/*
  build_data.mjs
  Runs in GitHub Actions to generate offline data for the game.

  Output:
    dist/index.html
    dist/data/map.geojson
    dist/data/stats.json
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

// More stable world borders source (Natural Earth)
const GEOJSON_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

// Identify the ISO3 code from different GeoJSON sources
function featureIso3(f){
  const p = f.properties || {};
  // Natural Earth uses ADM0_A3 and ISO_A3
  return p.ISO_A3 || p.ADM0_A3 || p.iso_a3 || p.adm0_a3 || null;
}

function buildSparqlForIso3(list){
  const values = list.map(c=>`"${c}"`).join(" ");
  return `
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
  OPTIONAL { ?country wdt:P2046 ?area . }      # area (km^2)
  OPTIONAL { ?country wdt:P1082 ?pop . }       # population
  OPTIONAL { ?country wdt:P47 ?neigh . }       # shares border with
  OPTIONAL {
    ?country wdt:P610 ?hp .
    OPTIONAL { ?hp wdt:P2044 ?elev . }         # elevation (m)
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
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
        throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
      }
      return await res.json();
    }catch(e){
      lastErr = e;
      const delay = 800 * Math.pow(2,i);
      console.log(`Retry in ${delay}ms…`, String(e).slice(0,140));
      await new Promise(r=>setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function postSparqlJson(query){
  // Use POST (more reliable than GET; avoids long URL issues)
  const body = new URLSearchParams({ query });
  const headers = {
    "Accept": "application/sparql-results+json",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "world-card-game/1.0 (https://github.com/Dyavolik83/world-card-game; mostovoyav83@gmail.com)"
  };
  return await fetchJsonWithRetry(WIKIDATA_ENDPOINT, { method: "POST", headers, body }, 5);
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

  console.log("Querying Wikidata…");
  const query = buildSparqlForIso3(ISO3_LIST);
  const wd = await postSparqlJson(query);

  const rows = wd.results.bindings;
  const countries = [];
  const continents = {};

  for(const r of rows){
    const iso3 = r.iso3.value;
    const name = r.countryLabel?.value || iso3;
    const cont = r.continentLabel?.value || "Unknown";
    const area = r.area ? Number(r.area.value) : null;
    const pop = r.pop ? Number(r.pop.value) : null;
    const elev = r.elev ? Number(r.elev.value) : null;
    const neigh = r.neighCount ? Number(r.neighCount.value) : 0;

    countries.push({iso3, name, continent: cont, area, population: pop, highest: elev, neighbors: neigh});
    if(!continents[cont]) continents[cont] = [];
    continents[cont].push(iso3);
  }

  // Ensure all ISO3 present
  for(const iso3 of ISO3_LIST){
    if(!countries.find(c=>c.iso3===iso3)){
      const cont = "Unknown";
      countries.push({iso3, name: iso3, continent: cont, area:null, population:null, highest:null, neighbors:0});
      if(!continents[cont]) continents[cont] = [];
      continents[cont].push(iso3);
    }
  }

  const out = { iso3List: ISO3_LIST, countries, continents };
  fs.writeFileSync(path.join(dataDir, "stats.json"), JSON.stringify(out, null, 2));
  console.log("Saved dist/data/stats.json");
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
