// VIDEOGAMES — World Card Game
// Loads local stats (data/stats.json) and local offline map borders (data/map.geojson).

const MAP_URL = "./data/map.geojson";

const CATEGORIES = [
  { key: "area", label: "Area (km²)" },
  { key: "population", label: "Population" },
  { key: "highest", label: "Highest point (m)" },
  { key: "neighbors", label: "Neighboring countries" },
];

const state = {
  round: 0,
  youDeck: [],
  cpuDeck: [],
  pot: [],
  selectedCategory: null,
  mapPaths: new Map(), // iso3 -> svg path
  countryData: new Map(), // iso3 -> stats
  continentsMap: new Map(), // continent -> Set(iso3)
  gameOver: false,
};

const $ = (id) => document.getElementById(id);
const svg = $("mapSvg");

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  return Math.round(n).toLocaleString("en-US");
}

function projectLonLat(lon, lat) {
  const x = ((lon + 180) / 360) * 1000;
  const y = ((90 - lat) / 180) * 500;
  return [x, y];
}

function coordsToPath(coords) {
  let d = "";
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const [x, y] = projectLonLat(lon, lat);
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d + " Z";
}

function featureToPath(feature) {
  const geom = feature.geometry;
  if (!geom) return "";
  const type = geom.type;
  const coords = geom.coordinates;
  let d = "";
  if (type === "Polygon") {
    for (const ring of coords) d += coordsToPath(ring);
  } else if (type === "MultiPolygon") {
    for (const poly of coords) for (const ring of poly) d += coordsToPath(ring);
  }
  return d;
}

function getIso3FromFeature(f) {
  const p = f.properties || {};
  // Our offline map uses ISO_A3 (preferred) with fallbacks.
  let iso3 = p.ISO_A3;
  if (!iso3 || iso3 === "-99") iso3 = p.ADM0_A3 || p.SOV_A3 || p.ISO_A3_EH || p.ADM0_ISO || p.iso3;
  return iso3;
}

async function loadData() {
  const statsRes = await fetch("./data/stats.json");
  if (!statsRes.ok) throw new Error("stats.json not found");
  const stats = await statsRes.json();

  const mapRes = await fetch(MAP_URL);
  if (!mapRes.ok) throw new Error("map.geojson not found");
  const geo = await mapRes.json();

  for (const c of stats.countries) state.countryData.set(c.iso3, c);
  for (const [cont, list] of Object.entries(stats.continents)) state.continentsMap.set(cont, new Set(list));

  const allowed = new Set(stats.iso3List);

  svg.innerHTML = "";
  for (const f of geo.features) {
    const iso3 = getIso3FromFeature(f);
    if (!iso3 || !allowed.has(iso3)) continue;
    const d = featureToPath(f);
    if (!d) continue;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#ffffff");
    path.setAttribute("stroke", "#94a3b8");
    path.setAttribute("stroke-width", "0.7");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("data-iso3", iso3);
    state.mapPaths.set(iso3, path);
    svg.appendChild(path);
  }

  return stats.iso3List;
}

function continentCompletedCount(deck) {
  const owned = new Set(deck.map((c) => c.iso3));
  let count = 0;
  for (const [, set] of state.continentsMap.entries()) {
    let all = true;
    for (const iso3 of set) {
      if (!owned.has(iso3)) {
        all = false;
        break;
      }
    }
    if (all) count++;
  }
  return count;
}

function updateScores() {
  $("youCountries").textContent = state.youDeck.length;
  $("cpuCountries").textContent = state.cpuDeck.length;
  $("youContinents").textContent = continentCompletedCount(state.youDeck);
  $("cpuContinents").textContent = continentCompletedCount(state.cpuDeck);
  $("potCount").textContent = state.pot.length;
  $("roundPill").textContent = `Round ${state.round}`;
  $("youStack").textContent = `${state.youDeck.length} cards`;
  $("cpuStack").textContent = `${state.cpuDeck.length} cards`;
}

function updateMapColors() {
  const owners = new Map();
  for (const c of state.youDeck) owners.set(c.iso3, "you");
  for (const c of state.cpuDeck) owners.set(c.iso3, "cpu");

  for (const [iso3, path] of state.mapPaths.entries()) {
    const own = owners.get(iso3);
    if (own === "you") {
      path.setAttribute("fill", "rgba(37,99,235,.22)");
      path.setAttribute("stroke", "rgba(37,99,235,.55)");
    } else if (own === "cpu") {
      path.setAttribute("fill", "rgba(220,38,38,.18)");
      path.setAttribute("stroke", "rgba(220,38,38,.55)");
    } else {
      path.setAttribute("fill", "#ffffff");
      path.setAttribute("stroke", "#94a3b8");
    }
  }
}

function setStatus(html) {
  const s = $("status");
  s.style.display = "block";
  s.innerHTML = html;
}

function cardBackHtml() {
  return `
    <h3>Opponent card</h3>
    <div class="countryName">Hidden</div>
    <div class="meta">Choose a category on your card</div>
    <div class="kv"><div class="k">Area (km²)</div><div class="v">?</div></div>
    <div class="kv"><div class="k">Population</div><div class="v">?</div></div>
    <div class="kv"><div class="k">Highest point (m)</div><div class="v">?</div></div>
    <div class="kv"><div class="k">Neighboring countries</div><div class="v">?</div></div>
  `;
}

function cardHtml(card, isYou, showCategories, disabled) {
  const c = card;
  const lines = [
    `<div class="countryName">${c.name}</div>`,
    `<div class="meta">ISO: ${c.iso3} • Continent: ${c.continent || "Unknown"}</div>`,
    `<div class="kv"><div class="k">Area (km²)</div><div class="v">${fmtInt(c.area)}</div></div>`,
    `<div class="kv"><div class="k">Population</div><div class="v">${fmtInt(c.population)}</div></div>`,
    `<div class="kv"><div class="k">Highest point (m)</div><div class="v">${fmtInt(c.highest)}</div></div>`,
    `<div class="kv"><div class="k">Neighboring countries</div><div class="v">${fmtInt(c.neighbors)}</div></div>`,
  ];

  let buttons = "";
  if (showCategories) {
    buttons =
      `<div class="choices">` +
      CATEGORIES
        .map((cat) => {
          return `
          <button ${disabled ? "disabled" : ""} data-cat="${cat.key}">
            <div class="btnTitle"><b>${cat.label}</b><span>${fmtInt(c[cat.key])}</span></div>
          </button>
        `;
        })
        .join("") +
      `</div>`;
  }

  return `<h3>${isYou ? "Your card" : "Opponent card"}</h3>` + lines.join("") + buttons;
}

function initDecks(iso3List) {
  const cards = iso3List.map((iso3) => state.countryData.get(iso3)).filter(Boolean);
  shuffle(cards);
  const half = Math.floor(cards.length / 2);
  state.youDeck = cards.slice(0, half);
  state.cpuDeck = cards.slice(half);
  state.pot = [];
  state.round = 0;
  state.selectedCategory = null;
  state.gameOver = false;
  updateScores();
  updateMapColors();
}

function endGame(winner) {
  state.gameOver = true;
  if (winner === "you") {
    setStatus(`<div class="end" style="color:var(--blue)">YOU WIN. FOR NOW YOU KNOW THE WORLD</div>`);
  } else {
    setStatus(`<div class="end" style="color:var(--red)">NICE TRY, BUT YOU CAN DO IT BETTER!</div>`);
  }
}

function disableCategoryButtons() {
  document.querySelectorAll('#youCard button[data-cat]').forEach((b) => (b.disabled = true));
}

async function resolveRound(catKey) {
  if (state.gameOver) return;
  if (state.selectedCategory) return;

  state.selectedCategory = catKey;
  disableCategoryButtons();

  const youCard = state.youDeck.shift();
  const cpuCard = state.cpuDeck.shift();

  $("cpuCard").innerHTML = cardHtml(cpuCard, false, false, false);
  setStatus(`Comparing <b>${CATEGORIES.find((c) => c.key === catKey).label}</b>…`);

  await new Promise((r) => setTimeout(r, 2000));

  const av = youCard[catKey] ?? -1;
  const bv = cpuCard[catKey] ?? -1;

  if (Number(av) === Number(bv)) {
    state.pot.push(youCard, cpuCard);
    $("cpuCard").innerHTML = cardBackHtml();
    setStatus(`It’s a tie. Both cards go to the <b>pot</b>!`);
  } else if (Number(av) > Number(bv)) {
    const won = [youCard, cpuCard, ...state.pot];
    state.pot = [];
    state.youDeck.push(...won);
    setStatus(`<b style="color:var(--blue)">YOU win</b> this round and take ${won.length} card(s).`);
  } else {
    const won = [cpuCard, youCard, ...state.pot];
    state.pot = [];
    state.cpuDeck.push(...won);
    setStatus(`<b style="color:var(--red)">SOMEONE ELSE wins</b> this round and takes ${won.length} card(s).`);
  }

  updateScores();
  updateMapColors();

  await new Promise((r) => setTimeout(r, 900));
  nextRound();
}

function nextRound() {
  if (state.gameOver) return;
  if (state.youDeck.length === 0) return endGame("cpu");
  if (state.cpuDeck.length === 0) return endGame("you");

  state.round += 1;
  state.selectedCategory = null;

  const youTop = state.youDeck[0];
  $("youCard").innerHTML = cardHtml(youTop, true, true, false);
  $("cpuCard").innerHTML = cardBackHtml();

  document.querySelectorAll('#youCard button[data-cat]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const catKey = btn.getAttribute("data-cat");
      await resolveRound(catKey);
    });
  });

  setStatus(`Choose a category on your card to compare with the opponent.`);
  updateScores();
  updateMapColors();
}

async function init() {
  try {
    const iso3List = await loadData();

    $("loading").style.display = "none";
    $("gameRow").style.display = "grid";
    $("status").style.display = "block";
    $("startBtn").disabled = false;
    $("resetBtn").disabled = false;

    initDecks(iso3List);

    setStatus("Press <b>Start game</b>.");

    $("startBtn").onclick = () => {
      $("startBtn").disabled = true;
      nextRound();
    };

    $("resetBtn").onclick = () => {
      initDecks(iso3List);
      $("startBtn").disabled = false;
      $("youCard").innerHTML = "";
      $("cpuCard").innerHTML = "";
      setStatus("Press <b>Start game</b>.");
    };
  } catch (err) {
    $("loading").innerHTML = "Failed to load data. Please check internet connection and try again.<br/><br/><code>" + String(err) + "</code>";
    console.error(err);
  }
}

init();
