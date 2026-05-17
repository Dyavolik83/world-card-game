/*
  build_data.mjs
  Build OFFLINE data for the World Card Game.

  Output:
    dist/index.html
    dist/data/map.geojson
    dist/data/stats.json

  Goal:
  - No Wikidata / SPARQL at all (it often returns HTTP 500 on GitHub runners).
  - Use:
    • Natural Earth (for borders + population + continent)
    • Wikipedia elevation extremes (for highest point elevation)
    • Local computation (for area + neighbors)

  Sources:
    Natural Earth GeoJSON:
      https://github.com/nvkelso/natural-earth-vector
    Wikipedia table:
      https://en.wikipedia.org/wiki/List_of_elevation_extremes_by_country
*/

import fs from "fs";
import path from "path";

const ISO3_TARGET = [
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

const NATURAL_EARTH_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

const WIKI_ELEV_URL =
  "https://en.wikipedia.org/wiki/List_of_elevation_extremes_by_country";

const EARTH_RADIUS_KM = 6371.0088;

function featureIso3(f){
  const p = f.properties || {};
  // Natural Earth uses ISO_A3 and ADM0_A3
  return p.ISO_A3 || p.ADM0_A3 || p.ADM0_A3_US || null;
}

function getName(p){
  return p.NAME_EN || p.NAME_LONG || p.ADMIN || p.SOVEREIGNT || p.NAME || "Unknown";
}

function getContinent(p){
  return p.CONTINENT || p.REGION_UN || "Unknown";
}

function getPopulation(p){
  const v = p.POP_EST;
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function toRad(deg){
  return deg * Math.PI / 180;
}

// Approximate spherical polygon area (lon/lat degrees) using a common formula
function ringAreaKm2(ring){
  if(!Array.isArray(ring) || ring.length < 4) return 0;
  // Ensure closed
  const first = ring[0];
  const last = ring[ring.length - 1];
  const coords = (first[0] === last[0] && first[1] === last[1]) ? ring : ring.concat([first]);

  let sum = 0;
  for(let i = 0; i < coords.length - 1; i++){
    const [lon1d, lat1d] = coords[i];
    const [lon2d, lat2d] = coords[i+1];
    let lon1 = toRad(lon1d);
    let lon2 = toRad(lon2d);
    const lat1 = toRad(lat1d);
    const lat2 = toRad(lat2d);

    let dLon = lon2 - lon1;
    if(dLon > Math.PI) dLon -= 2 * Math.PI;
    if(dLon < -Math.PI) dLon += 2 * Math.PI;

    sum += dLon * (Math.sin(lat1) + Math.sin(lat2));
  }
  const area = Math.abs(sum) * (EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2;
  return area;
}

function featureAreaKm2(feature){
  const g = feature.geometry;
  if(!g) return 0;
  if(g.type === "Polygon"){
    // sum abs of rings (holes are small at this scale)
    return (g.coordinates || []).reduce((acc, ring) => acc + ringAreaKm2(ring), 0);
  }
  if(g.type === "MultiPolygon"){
    return (g.coordinates || []).reduce((acc, poly) => {
      return acc + (poly || []).reduce((acc2, ring) => acc2 + ringAreaKm2(ring), 0);
    }, 0);
  }
  return 0;
}

function roundPoint(pt, decimals=3){
  const f = Math.pow(10, decimals);
  return [Math.round(pt[0]*f)/f, Math.round(pt[1]*f)/f];
}

function edgeKey(a,b){
  const as = `${a[0]},${a[1]}`;
  const bs = `${b[0]},${b[1]}`;
  return (as < bs) ? `${as}|${bs}` : `${bs}|${as}`;
}

function collectEdgesForFeature(feature, iso3, edgeMap){
  const g = feature.geometry;
  if(!g) return;

  const handleRing = (ring) => {
    if(!Array.isArray(ring) || ring.length < 2) return;
    for(let i=0;i<ring.length-1;i++){
      const p1 = roundPoint(ring[i]);
      const p2 = roundPoint(ring[i+1]);
      if(p1[0] === p2[0] && p1[1] === p2[1]) continue;
      const k = edgeKey(p1,p2);
      if(!edgeMap.has(k)) edgeMap.set(k, new Set());
      edgeMap.get(k).add(iso3);
    }
  };

  if(g.type === "Polygon"){
    for(const ring of (g.coordinates || [])) handleRing(ring);
  } else if(g.type === "MultiPolygon"){
    for(const poly of (g.coordinates || [])){
      for(const ring of (poly || [])) handleRing(ring);
    }
  }
}

function buildNeighborCounts(features){
  const edgeMap = new Map();
  const neighbors = new Map(); // iso3 -> Set

  for(const f of features){
    const iso3 = featureIso3(f);
    if(!iso3) continue;
    if(!neighbors.has(iso3)) neighbors.set(iso3, new Set());
    collectEdgesForFeature(f, iso3, edgeMap);
  }

  for(const set of edgeMap.values()){
    const arr = Array.from(set);
    if(arr.length < 2) continue;
    for(let i=0;i<arr.length;i++){
      for(let j=i+1;j<arr.length;j++){
        neighbors.get(arr[i])?.add(arr[j]);
        neighbors.get(arr[j])?.add(arr[i]);
      }
    }
  }

  const counts = new Map();
  for(const [iso3, set] of neighbors.entries()) counts.set(iso3, set.size);
  return counts;
}

function decodeEntities(s){
  return s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html){
  return decodeEntities(
    html
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " ")
  );
}

function normalizeName(s){
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTextWithRetry(url, tries=4){
  let lastErr;
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url, {
        headers: {
          "User-Agent": "world-card-game/1.0 (school project)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });
      if(!res.ok){
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
      }
      return await res.text();
    }catch(e){
      lastErr = e;
      const delay = 800 * Math.pow(2,i);
      console.log(`Retry in ${delay}ms…`, String(e).slice(0,160));
      await new Promise(r=>setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchJsonWithRetry(url, tries=4){
  let lastErr;
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url, {
        headers:{ "User-Agent":"world-card-game/1.0 (school project)" }
      });
      if(!res.ok){
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
      }
      return await res.json();
    }catch(e){
      lastErr = e;
      const delay = 800 * Math.pow(2,i);
      console.log(`Retry in ${delay}ms…`, String(e).slice(0,160));
      await new Promise(r=>setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function buildElevationMap(){
  console.log("Downloading Wikipedia elevation table…");
  const html = await fetchTextWithRetry(WIKI_ELEV_URL, 4);

  const marker = 'class="wikitable sortable"';
  const idx = html.indexOf(marker);
  if(idx === -1) throw new Error("Could not find wikitable in Wikipedia page");
  const start = html.lastIndexOf("<table", idx);
  const end = html.indexOf("</table>", start);
  const tableHtml = html.slice(start, end + 8);

  const elevByCountry = new Map();

  const rowParts = tableHtml.split(/<tr[^>]*>/i).slice(1);
  for(const row of rowParts){
    const cells = row.match(/<(td|th)[^>]*>[\s\S]*?<\/(td|th)>/ig);
    if(!cells || cells.length < 3) continue;

    // Skip header rows that contain "Country" in first cell
    const firstText = stripTags(cells[0]);
    if(/country/i.test(firstText) && /region/i.test(firstText)) continue;

    const country = stripTags(cells[0]);
    const maxElev = stripTags(cells[2]);

    const m = maxElev.match(/(-?\d[\d,]*)/);
    if(!m) continue;
    const elev = Number(m[1].replace(/,/g, ""));
    if(!Number.isFinite(elev)) continue;

    const key = normalizeName(country);
    if(key) elevByCountry.set(key, elev);
  }

  console.log("Elevation entries:", elevByCountry.size);
  return elevByCountry;
}

function getHighestForFeature(props, elevMap){
  const candidates = [
    props.NAME_EN, props.NAME_LONG, props.ADMIN, props.SOVEREIGNT, props.NAME
  ].filter(Boolean);

  const synonyms = {
    "united states of america": "united states",
    "united kingdom": "united kingdom",
    "tanzania": "tanzania",
    "united republic of tanzania": "tanzania",
    "korea south": "south korea",
    "republic of korea": "south korea",
    "vietnam": "vietnam",
    "lao pdr": "laos",
    "bolivia": "bolivia",
    "venezuela": "venezuela"
  };

  for(const c of candidates){
    const n = normalizeName(c);
    if(elevMap.has(n)) return elevMap.get(n);
    if(synonyms[n] && elevMap.has(synonyms[n])) return elevMap.get(synonyms[n]);

    // try a softer match for known patterns
    if(n.includes("tanzania") && elevMap.has("tanzania")) return elevMap.get("tanzania");
    if(n.includes("united states") && elevMap.has("united states")) return elevMap.get("united states");
    if(n.includes("south korea") && elevMap.has("south korea")) return elevMap.get("south korea");
  }
  return null;
}

async function main(){
  const distDir = path.join(process.cwd(), "dist");
  const dataDir = path.join(distDir, "data");
  fs.mkdirSync(dataDir, {recursive:true});

  // Copy index.html to dist
  fs.copyFileSync(path.join(process.cwd(), "index.html"), path.join(distDir, "index.html"));

  console.log("Downloading Natural Earth borders…");
  const geo = await fetchJsonWithRetry(NATURAL_EARTH_URL, 4);

  // Filter to our target list
  const featuresAll = (geo.features || []).filter(f => {
    const iso3 = featureIso3(f);
    return iso3 && ISO3_TARGET.includes(iso3);
  });

  const usedIso3 = featuresAll.map(f => featureIso3(f)).filter(Boolean);
  const missing = ISO3_TARGET.filter(x => !usedIso3.includes(x));
  if(missing.length){
    console.log("WARNING: missing countries in map source:", missing.join(", "));
  }

  // Write map
  const mapOut = { type: "FeatureCollection", features: featuresAll };
  fs.writeFileSync(path.join(dataDir, "map.geojson"), JSON.stringify(mapOut));
  console.log("Saved dist/data/map.geojson", featuresAll.length);

  // Build elevation map from Wikipedia
  const elevMap = await buildElevationMap();

  // Neighbors from shared edges
  const neighCount = buildNeighborCounts(featuresAll);

  // Build countries list + continents groups
  const countries = [];
  const continents = {};

  for(const f of featuresAll){
    const p = f.properties || {};
    const iso3 = featureIso3(f);
    const name = getName(p);
    const continent = getContinent(p);
    const population = getPopulation(p);
    const area = featureAreaKm2(f);
    const highest = getHighestForFeature(p, elevMap);
    const neighbors = neighCount.get(iso3) ?? 0;

    countries.push({
      iso3,
      name,
      continent,
      area,
      population,
      highest,
      neighbors
    });

    if(!continents[continent]) continents[continent] = [];
    continents[continent].push(iso3);
  }

  const out = { iso3List: countries.map(c=>c.iso3), countries, continents };
  fs.writeFileSync(path.join(dataDir, "stats.json"), JSON.stringify(out, null, 2));
  console.log("Saved dist/data/stats.json");
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
