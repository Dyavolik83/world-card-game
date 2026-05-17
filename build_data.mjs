/*
  build_data.mjs
  Runs in GitHub Actions to generate offline data for the game.

  Output:
    dist/index.html
    dist/data/map.geojson
    dist/data/stats.json

  Why this exists:
  - School networks (and sometimes Wikidata itself) can block or fail SPARQL requests.
  - We therefore:
    1) query in small batches, and
    2) fall back to the public QLever Wikidata endpoint if Wikidata Query Service fails.
*/
import fs from "fs";
import path from "path";

const ISO3_LIST = [
  // Europe (12)
  "GBR","IRL","FRA","ESP","PRT","DEU","ITA","NLD","BEL","CHE","SWE","POL",
  // Africa (10)
  "MAR","DZA","EGY","NGA","ZAF","KEN","ETH","GHA","TZA","SEN",
  // Asia (12)
  "CHN","IND","JPN","KOR","IDN","THA","VNM","SAU","IRN","PAK","PHI","ARE",
  // North America (10)
  "USA","CAN","MEX","CUB","DOM","HTI","GTM","PAN","CRI","JAM",
  // South America (10)
  "BRA","ARG","CHL","PER","COL","ECU","BOL","URY","PRY","VEN",
  // Oceania (6)
  "AUS","NZL","PNG","FJI","VUT","WSM"
];

// Map borders source (Natural Earth)
const GEOJSON_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

// SPARQL endpoints (fallback)
// - Wikidata Query Service is sometimes unstable (HTTP 500)
// - QLever provides a public Wikidata SPARQL endpoint (see https://qlever.dev/wikidata)
const SPARQL_ENDPOINTS = [
  {
    name: "Wikidata Query Service",
    url: "https://query.wikidata.org/sparql"
  },
  {
    name: "QLever Wikidata",
    url: "https://qlever.dev/api/wikidata"
  }
];

function featureIso3(f){
  const p = f.properties || {};
  return p.ISO_A3 || p.ADM0_A3 || p.iso_a3 || p.adm0_a3 || null;
}

function buildSparqlForIso3(list){
  const values = list.map(c=>`\"${c}\"`).join(" ");
  // Note: backslashes are ONLY for JavaScript string literal escaping. SPARQL receives plain quotes.
  return `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>

SELECT ?iso3 ?countryLabel
       (SAMPLE(?continentLabel) AS ?continentLabel)
       (MAX(?area) AS ?area)
       (MAX(?pop) AS ?pop)
       (MAX(?elev) AS ?elev)
       (COUNT(DISTINCT ?neigh) AS ?neighCount)
WHERE {
  VALUES ?iso3 { ${values} }
  ?country wdt:P298 ?iso3 .
  OPTIONAL { ?country wdt:P30 ?continent . }
  OPTIONAL { ?country wdt:P2046 ?area . }
  OPTIONAL { ?country wdt:P1082 ?pop . }
  OPTIONAL { ?country wdt:P47 ?neigh . }
  OPTIONAL {
    ?country wdt:P610 ?hp .
    OPTIONAL { ?hp wdt:P2044 ?elev . }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". }
}
GROUP BY ?iso3 ?countryLabel
`;
}

async function fetchJsonWithRetry(url, opts={}, tries=4){
  let lastErr;
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url, opts);
      if(!res.ok){
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0,250)}`);
      }
      return await res.json();
    }catch(e){
      lastErr = e;
      const delay = 900 * Math.pow(2,i);
      console.log(`Retry in ${delay}ms…`, String(e).slice(0,160));
      await new Promise(r=>setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function postSparqlJson(endpointUrl, query){
  // Standard SPARQL protocol: POST with form-encoded query
  const body = new URLSearchParams({ query });
  const headers = {
    "Accept": "application/sparql-results+json",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "world-card-game/1.0 (https://github.com/Dyavolik83/world-card-game; mostovoyav83@gmail.com)"
  };
  return await fetchJsonWithRetry(endpointUrl, { method: "POST", headers, body }, 3);
}

async function queryWithFallback(query){
  let lastErr = null;
  for(const ep of SPARQL_ENDPOINTS){
    try{
      console.log(`SPARQL: trying ${ep.name}…`);
      const res = await postSparqlJson(ep.url, query);
      return res;
    }catch(e){
      lastErr = e;
      console.log(`SPARQL: ${ep.name} failed: ${String(e).slice(0,160)}`);
    }
  }
  throw lastErr || new Error("All SPARQL endpoints failed");
}

function chunk(arr, size){
  const out = [];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

async function fetchCountryStatsBatched(batchSize=12){
  const batches = chunk(ISO3_LIST, batchSize);
  const byIso3 = new Map();

  for(let i=0;i<batches.length;i++){
    const batch = batches[i];
    console.log(`Query batch ${i+1}/${batches.length} (${batch.length} countries)…`);
    const query = buildSparqlForIso3(batch);

    // Some endpoints can still be flaky; retry per batch using the existing retry+fallback.
    const wd = await queryWithFallback(query);

    const rows = wd.results.bindings;
    for(const r of rows){
      const iso3 = r.iso3.value;
      const name = r.countryLabel?.value || iso3;
      const cont = r.continentLabel?.value || "Unknown";
      const area = r.area ? Number(r.area.value) : null;
      const pop = r.pop ? Number(r.pop.value) : null;
      const elev = r.elev ? Number(r.elev.value) : null;
      const neigh = r.neighCount ? Number(r.neighCount.value) : 0;

      byIso3.set(iso3, {iso3, name, continent: cont, area, population: pop, highest: elev, neighbors: neigh});
    }

    // Gentle pacing to reduce throttling
    await new Promise(r=>setTimeout(r, 450));
  }

  return byIso3;
}

async function main(){
  const distDir = path.join(process.cwd(), "dist");
  const dataDir = path.join(distDir, "data");
  fs.mkdirSync(dataDir, {recursive:true});

  // Copy index.html to dist
  fs.copyFileSync(path.join(process.cwd(), "index.html"), path.join(distDir, "index.html"));

  console.log("Downloading GeoJSON…");
  const geo = await fetchJsonWithRetry(GEOJSON_URL, {
    headers:{ "User-Agent":"world-card-game/1.0 (mostovoyav83@gmail.com)" }
  });

  const features = (geo.features || []).filter(f => {
    const iso3 = featureIso3(f);
    return iso3 && ISO3_LIST.includes(iso3);
  });

  const filtered = { type: "FeatureCollection", features };
  fs.writeFileSync(path.join(dataDir, "map.geojson"), JSON.stringify(filtered));
  console.log("Saved dist/data/map.geojson", filtered.features.length);

  console.log("Querying country stats (batched + fallback endpoints)…");
  const byIso3 = await fetchCountryStatsBatched(12);

  const countries = [];
  const continents = {};

  for(const iso3 of ISO3_LIST){
    const c = byIso3.get(iso3) || {iso3, name: iso3, continent:"Unknown", area:null, population:null, highest:null, neighbors:0};
    countries.push(c);
    if(!continents[c.continent]) continents[c.continent] = [];
    continents[c.continent].push(iso3);
  }

  const out = { iso3List: ISO3_LIST, countries, continents };
  fs.writeFileSync(path.join(dataDir, "stats.json"), JSON.stringify(out, null, 2));
  console.log("Saved dist/data/stats.json");
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
