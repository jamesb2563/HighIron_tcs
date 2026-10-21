// Demo harness: load OSM rail data, build the network, run the dispatcher on a Leaflet map.
// Serve the tcs/ folder over HTTP (ES modules don't load from file://).

import { importOverpass } from '../src/osm-import.js';
import { buildNetwork, externalSections } from '../src/network.js';
import { buildRailnet } from '../src/railnet.js';
import { Dispatcher } from '../src/dispatcher.js';
import { sliceAlong } from '../src/geo.js';

const KEY_NET = 'highiron.tcs.network';
const KEY_STATE = 'highiron.tcs.state';
const MPH = 0.44704;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COLORS = {
  base: { main: '#33454f', siding: '#5d7480', spur: '#7c8f97', yard: '#7c8f97', crossover: '#5d7480' },
  a: css('--dir-a'),
  b: css('--dir-b'),
  occupied: css('--occupied'),
};
const $ = (id) => document.getElementById(id);

const map = L.map('map', { preferCanvas: true }).setView([39.0, -112.6], 10);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

let net = null;
let railnet = null;
let view = 'track';
let disp = null;
let running = false;
let speedX = 60;
const yardMarkers = {};
const ASPECT = { stop: '#d9483b', approach: '#f2b134', 'advance-approach': '#f7d774', clear: '#3fae6a' };
const ASPECT_TEXT = { stop: 'Stop', approach: 'Approach', 'advance-approach': 'Advance Approach', clear: 'Clear' };
const layers = { areas: L.layerGroup().addTo(map), signals: L.layerGroup().addTo(map), track: L.layerGroup().addTo(map), railnet: L.layerGroup(), blocks: L.layerGroup().addTo(map), trains: L.layerGroup().addTo(map) };
const secLines = {};
const trainLines = {};

// ------------------------------------------------------------------ network
function useNetwork(n, state = null, rn = null) {
  net = n;
  railnet = rn || buildRailnet(net);
  disp = state ? Dispatcher.fromJSON(net, state) : new Dispatcher(net);
  Object.keys(yardMarkers).forEach((k) => delete yardMarkers[k]);
  lastList = '';
  Object.keys(trainLines).forEach((k) => delete trainLines[k]);
  layers.trains.clearLayers();
  drawNetwork();
  drawRailnet();
  fillSelects();
  const ext = externalSections(net);
  const passing = Object.values(net.groups).filter((g) => g.passable).length;
  const km = ext.reduce((s, x) => s + x.length, 0) / 1000;
  const rnN = Object.keys(railnet.nodes).length;
  const rnE = Object.keys(railnet.edges).length;
  $('netInfo').textContent =
    `${ext.length} sections, ${Object.keys(net.interlockings).length} control points, ` +
    `${passing} passing locations, ${km.toFixed(1)} km of track. Railnet: ${rnN} nodes, ${rnE} lines.` +
    (net.warnings.length ? ` ${net.warnings.length} import warning(s) in the console.` : '');
  net.warnings.forEach((w) => console.warn(w));
  render();
}

/** Accepts a raw Overpass export or a prebuilt file from tools/build-railnet.js. */
function loadData(json) {
  if (json.network) { useNetwork(json.network, null, json.railnet); return; }
  const n = buildNetwork(importOverpass(json));
  if (!externalSections(n).length) throw new Error('No railway=rail track found in that file.');
  useNetwork(n);
}

const yardInfo = (c, il) => c
  ? `${(c.trackLength / 1000).toFixed(1)} km of yard track, about ${c.cars.toLocaleString()} cars standing` +
    `<br>Longest track ${c.longestTrack} m · ${c.leads} connection${c.leads === 1 ? '' : 's'}` +
    `${c.areaKm2 ? ` · ${c.areaKm2} km² mapped` : ''}${il?.works ? '<br>Includes railroad works' : ''}`
  : '';

function drawAreas() {
  layers.areas.clearLayers();
  for (const f of net.features?.facilities || []) {
    for (const r of f.rings) {
      L.polygon(r, { color: '#6c8592', weight: 1, fillColor: f.type === 'works' ? '#b5562c' : '#6c8592', fillOpacity: 0.12, interactive: false })
        .addTo(layers.areas);
    }
  }
}

function drawNetwork() {
  drawAreas();
  layers.track.clearLayers();
  Object.keys(secLines).forEach((k) => delete secLines[k]);
  const bounds = [];
  for (const s of Object.values(net.sections)) {
    const weight = s.lanes > 1 ? 7 : s.kind === 'main' ? 5 : 3;
    const line = L.polyline(s.coords, { color: COLORS.base[s.kind] || COLORS.base.main, weight, opacity: 0.95 })
      .bindTooltip(`${s.name || s.kind} · ${s.id} · ${(s.length / 1000).toFixed(2)} km · ${s.lanes} track${s.lanes > 1 ? 's' : ''} · ${s.blockCount || 0} block(s) · ${Math.round(s.speed / MPH)} mph`, { sticky: true })
      .on('click', (ev) => { if (!s.internal) trackPopup(s, ev.latlng); })
      .addTo(layers.track);
    secLines[s.id] = line;
    bounds.push(...s.coords);
    // Block boundaries
    if (!s.internal && s.blockCount > 1) {
      for (let i = 1; i < s.blockCount; i++) {
        const p = sliceAlong(s.coords, i * s.blockLength, i * s.blockLength)[0];
        L.circleMarker(p, { radius: 2.5, color: '#e4ecef', weight: 1, fillOpacity: 1 }).addTo(layers.track);
      }
    }
  }
  for (const il of Object.values(net.interlockings)) {
    const m = L.marker([il.lat, il.lon], {
      icon: L.divIcon({ className: `il-icon ${il.kind === 'end' ? 'end' : ''}`, iconSize: [10, 10] }),
      keyboard: false,
    }).bindTooltip(il.kind === 'yard' ? `<b>${il.name}</b><br>${yardInfo(il.capacity, il)}` : il.name).addTo(layers.track);
    if (il.kind === 'yard') yardMarkers[il.id] = m;
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

function fillSelects() {
  const order = { portal: 0, yard: 1, end: 2, cp: 3 };
  const label = { portal: 'Off map', yard: 'Yards', end: 'Ends of track', cp: 'Control points' };
  const ils = Object.values(net.interlockings).filter((i) => i.degree > 0)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  $('then').innerHTML = '<option value="">Stay there</option>';
  for (const sel of [$('from'), $('to'), $('then')]) {
    if (sel.id !== 'then') sel.innerHTML = '';
    let group = null;
    for (const il of ils) {
      if (!group || group.label !== label[il.kind]) { group = document.createElement('optgroup'); group.label = label[il.kind]; sel.append(group); }
      group.append(new Option(il.name, il.id));
    }
  }
  const ends = ils.filter((i) => i.kind === 'portal' || i.kind === 'end');
  if (ends.length > 1) { $('from').value = ends[0].id; $('to').value = ends.at(-1).id; }
}

const OPERATOR_COLORS = ['#2f6f9f', '#b5562c', '#4f8a3a', '#8a4f9e', '#a8862c', '#3a8a86', '#9e4f6a'];
function operatorColor(op) {
  const ops = [...new Set(Object.values(railnet.edges).map((e) => e.operator || '?'))].sort();
  return OPERATOR_COLORS[ops.indexOf(op || '?') % OPERATOR_COLORS.length];
}

function drawRailnet() {
  layers.railnet.clearLayers();
  for (const e of Object.values(railnet.edges)) {
    const w = e.tracks === 'double' ? 7 : e.tracks === 'mixed' ? 5 : 3.5;
    const extra = [e.sidings ? `${e.sidings} siding${e.sidings > 1 ? 's' : ''}` : '', e.spurs ? `${e.spurs} spur${e.spurs > 1 ? 's' : ''}` : '']
      .filter(Boolean).join(', ');
    L.polyline(e.coords, { color: operatorColor(e.operator), weight: w, opacity: 0.9 })
      .bindTooltip(`${e.name || 'Unnamed track'}<br>${e.operator || 'Unknown operator'} · ${(e.length / 1000).toFixed(1)} km · ${e.tracks} track` +
        (e.runTimes ? `<br>Stop to stop: ${[25, 40, 60].map((v) => `${(e.runTimes[v] / 60).toFixed(1)} min at ${v} mph`).join(', ')}` : '') +
        `${extra ? '<br>' + extra : ''}${e.industries.length ? '<br>Industries: ' + e.industries.slice(0, 4).join(', ') + (e.industries.length > 4 ? '…' : '') : ''}`, { sticky: true })
      .addTo(layers.railnet);
  }
  for (const n of Object.values(railnet.nodes)) {
    const big = n.kind === 'yard' || n.kind === 'portal';
    L.circleMarker([n.lat, n.lon], {
      radius: big ? 7 : 4, weight: 2, color: '#15212a',
      fillColor: n.kind === 'yard' ? '#e4ecef' : n.kind === 'portal' ? css('--dir-a') : n.kind === 'diamond' ? css('--dir-b') : '#15212a',
      fillOpacity: 1,
    }).bindTooltip(`<b>${n.name}</b>${n.capacity ? '<br>' + yardInfo(n.capacity, n) : ''}${n.industries.length ? '<br>' + n.industries.slice(0, 4).join(', ') : ''}`, { direction: 'right' })
      .addTo(layers.railnet);
  }
}

function setView(v) {
  view = v;
  document.querySelectorAll('.view').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === v));
  if (v === 'railnet') { map.removeLayer(layers.track); map.removeLayer(layers.blocks); map.removeLayer(layers.signals); layers.railnet.addTo(map); }
  else { map.removeLayer(layers.railnet); layers.track.addTo(map); layers.blocks.addTo(map); layers.signals.addTo(map); }
}
document.querySelectorAll('.view').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

// ------------------------------------------------------------------ render
function render() {
  if (!disp) return;
  const st = disp.state;
  // Authority colouring per section (first held lane wins).
  for (const s of Object.values(net.sections)) {
    const line = secLines[s.id];
    if (!line || s.internal) continue;
    let dir = 0;
    for (let l = 0; l < s.lanes; l++) { const L_ = st.lanes[`${s.id}/${l}`]; if (L_ && L_.holders.length) { dir = L_.dir; break; } }
    line.setStyle({ color: dir > 0 ? COLORS.a : dir < 0 ? COLORS.b : COLORS.base[s.kind] || COLORS.base.main });
  }
  layers.blocks.clearLayers();
  for (const key of Object.keys(st.blocks)) {
    const [sec, , i] = key.split('/');
    const s = net.sections[sec];
    L.polyline(sliceAlong(s.coords, i * s.blockLength, (+i + 1) * s.blockLength), { color: COLORS.occupied, weight: 3, opacity: 0.9, interactive: false }).addTo(layers.blocks);
  }
  // Trains
  const seen = new Set();
  for (const t of Object.values(st.trains)) {
    if (t.status === 'arrived') continue;
    const geo = disp.trainGeometry(t);
    if (geo.length < 2) continue;
    seen.add(t.id);
    if (!trainLines[t.id]) {
      trainLines[t.id] = {
        casing: L.polyline(geo, { color: '#ffffff', weight: 11, interactive: false }).addTo(layers.trains),
        body: L.polyline(geo, { color: '#15212a', weight: 7 }).bindTooltip(t.name, { permanent: true, direction: 'top', offset: [0, -6] }).addTo(layers.trains),
      };
    } else {
      trainLines[t.id].casing.setLatLngs(geo);
      trainLines[t.id].body.setLatLngs(geo);
    }
  }
  for (const id of Object.keys(trainLines)) {
    if (!seen.has(id)) { layers.trains.removeLayer(trainLines[id].casing); layers.trains.removeLayer(trainLines[id].body); delete trainLines[id]; }
  }
  // Signals: each train's next signal, coloured by aspect.
  layers.signals.clearLayers();
  if (view === 'track') {
    for (const sg of disp.signalStates()) {
      L.circleMarker([sg.lat, sg.lon], { radius: 6, weight: sg.diverging ? 3 : 1.5, color: sg.diverging ? '#ffffff' : '#15212a', fillColor: ASPECT[sg.aspect], fillOpacity: 1, dashArray: sg.diverging ? '2 2' : null })
        .bindTooltip(`${st.trains[sg.train].name}: next signal ${ASPECT_TEXT[sg.aspect]}${sg.diverging ? ` (diverging, ${sg.speedMph} mph)` : ''}`)
        .addTo(layers.signals);
    }
  }
  for (const [il, m] of Object.entries(yardMarkers)) {
    const y = disp.yardStatus(il);
    const occ = y.capacity ? `<br>In use: ${((y.standing + y.inbound) / 1000).toFixed(1)} of ${(y.capacity / 1000).toFixed(1)} km${y.trains.length ? ` (${y.trains.join(', ')})` : ''}${y.arriving.length ? `, arriving ${y.arriving.join(', ')}` : ''}` : '';
    m.setTooltipContent(`<b>${net.interlockings[il].name}</b><br>${yardInfo(net.interlockings[il].capacity, net.interlockings[il])}${occ}`);
  }
  // Panel
  const h = Math.floor(st.time / 3600), m = Math.floor((st.time % 3600) / 60);
  $('clock').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const list = Object.values(st.trains).map((t) => {
    const why = t.status === 'arrived' ? `arrived at ${disp.ilName(t.dest)}${t.inYard ? ' (in yard)' : ''}`
      : t.status === 'noroute' ? `no route to ${disp.ilName(t.dest)}`
      : t.status === 'dwelling' ? `in ${disp.ilName(t.dest)}, leaves for ${disp.ilName(t.then?.to)} at ${clock(t.departAt)}`
      : t.wait ? t.wait.reason : `${Math.round(t.speed / MPH)} mph to ${disp.ilName(t.dest)}`;
    const aspect = t.legs.length && t.status !== 'arrived' ? `<span class="dot" style="--c:${ASPECT[t.aspect || 'stop']}" title="Next signal: ${ASPECT_TEXT[t.aspect || 'stop']}"></span>` : '';
    const live = !['arrived', 'noroute'].includes(t.status);
    const controls = live ? `<span class="ctl">
        <button data-act="${t.held ? 'release' : 'hold'}" data-id="${t.id}">${t.held ? 'Release' : 'Hold'}</button>
        <button data-act="pri-" data-id="${t.id}" aria-label="Lower priority">−</button><span class="pri">P${t.priority || 0}</span><button data-act="pri+" data-id="${t.id}" aria-label="Raise priority">+</button>
      </span>` : t.inYard ? `<span class="ctl"><button data-act="breakup" data-id="${t.id}">Break up</button></span>` : '';
    return `<li><button class="x" data-act="remove" data-id="${t.id}" aria-label="Remove ${t.name}">✕</button>${aspect}<b>${t.name}</b> ${t.status} · ${Math.round(t.length)} m${t.reversals ? ` · reversed ${t.reversals}×` : ''}<span class="why">${why}</span>${controls}</li>`;
  }).join('') || '<li class="why">No trains yet. Add one above, then press Run.</li>';
  // Only touch the DOM when something changed, so the buttons stay clickable.
  if (list !== lastList) { $('trains').innerHTML = list; lastList = list; }
  $('log').innerHTML = st.events.slice(-60).reverse().map((e) => {
    const mm = Math.floor(e.t / 60);
    return `<li><time>${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}</time>${e.train} ${e.msg}</li>`;
  }).join('');
}

let lastList = '';
const clock = (sec) => { const mm = Math.floor(sec / 60); return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; };

function trackPopup(s, latlng) {
  const slow = disp.state.slowOrders[s.id];
  const out = disp.state.outOfService[s.id];
  const html = `<b>${s.name || s.kind}</b> · ${s.id}<br>${(s.length / 1000).toFixed(2)} km, ${Math.round(s.speed / MPH)} mph track` +
    `${slow ? `<br>Slow order: ${slow} mph` : ''}${out ? '<br><b>Out of service</b>' : ''}<div class="pop">` +
    `<button data-sec="${s.id}" data-act="slow10">Slow 10 mph</button><button data-sec="${s.id}" data-act="slow25">Slow 25 mph</button>` +
    `${slow ? `<button data-sec="${s.id}" data-act="lift">Lift slow order</button>` : ''}` +
    `<button data-sec="${s.id}" data-act="${out ? 'restore' : 'oos'}">${out ? 'Back in service' : 'Take out of service'}</button></div>`;
  L.popup().setLatLng(latlng).setContent(html).openOn(map);
}
map.on('popupopen', (e) => {
  e.popup.getElement().querySelectorAll('button[data-sec]').forEach((b) => (b.onclick = () => {
    const sec = b.dataset.sec;
    const act = b.dataset.act;
    if (act === 'slow10') disp.slowOrder(sec, 10);
    if (act === 'slow25') disp.slowOrder(sec, 25);
    if (act === 'lift') disp.slowOrder(sec, null);
    if (act === 'oos') disp.setOutOfService(sec, true);
    if (act === 'restore') disp.setOutOfService(sec, false);
    map.closePopup();
    render();
  }));
});

// ------------------------------------------------------------------ loop
let last = performance.now();
let acc = 0;
let renderAcc = 0;
function frame(now) {
  const real = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (running && disp) {
    acc += real * speedX;
    let steps = 0;
    while (acc >= 1 && steps < 2000) { disp.tick(1); acc -= 1; steps++; }
  }
  renderAcc += real;
  if (renderAcc > 0.1) { renderAcc = 0; render(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ controls
async function loadUrl(url, label) {
  $('netInfo').textContent = `Loading ${label}…`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    loadData(await res.json());
  } catch (err) { $('netInfo').textContent = `Couldn’t load ${label}: ${err.message}`; }
}
$('loadSample').onclick = () => loadUrl('../fixtures/sample-line.json', 'the sample line');
$('loadJax').onclick = () => loadUrl('../data/jacksonville.railnet.json', 'Jacksonville');
$('fileInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { loadData(JSON.parse(await f.text())); }
  catch (err) { $('netInfo').textContent = `Couldn’t load ${f.name}: ${err.message}`; }
  e.target.value = '';
};
$('addTrain').onclick = () => {
  if (!disp) return;
  if ($('from').value === $('to').value) { $('netInfo').textContent = 'Pick a destination different from the origin.'; return; }
  const spec = { from: $('from').value, to: $('to').value, length: +$('len').value, maxSpeed: +$('spd').value * MPH, priority: +$('pri').value };
  if ($('then').value && net.interlockings[$('to').value].kind === 'yard') spec.then = { to: $('then').value, dwell: 15 * 60 };
  disp.addTrain(spec);
  render();
};
$('trains').onclick = (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  const t = disp.state.trains[id];
  if (act === 'remove') disp.removeTrain(id);
  if (act === 'hold') disp.hold(id);
  if (act === 'release') disp.release(id);
  if (act === 'pri+') disp.setPriority(id, (t.priority || 0) + 1);
  if (act === 'pri-') disp.setPriority(id, Math.max(0, (t.priority || 0) - 1));
  if (act === 'breakup') disp.breakUp(id);
  render();
};
$('play').onclick = () => {
  running = !running;
  $('play').setAttribute('aria-pressed', running);
  $('play').textContent = running ? 'Pause' : 'Run';
};
document.querySelectorAll('.speed').forEach((b) => (b.onclick = () => {
  speedX = +b.dataset.x;
  document.querySelectorAll('.speed').forEach((x) => x.setAttribute('aria-pressed', x === b));
}));
$('save').onclick = () => {
  if (!disp) return;
  try {
    localStorage.setItem(KEY_NET, JSON.stringify({ network: net, railnet }));
    localStorage.setItem(KEY_STATE, JSON.stringify(disp.toJSON()));
    $('netInfo').textContent = 'Saved.';
  } catch (err) { $('netInfo').textContent = `Save failed: ${err.message}`; }
};
$('restore').onclick = () => {
  try {
    const n = JSON.parse(localStorage.getItem(KEY_NET));
    const s = JSON.parse(localStorage.getItem(KEY_STATE));
    if (!n || !s) { $('netInfo').textContent = 'Nothing saved yet.'; return; }
    useNetwork(n.network || n, s, n.railnet);
  } catch (err) { $('netInfo').textContent = `Restore failed: ${err.message}`; }
};

$('loadJax').click();

// Handle for the browser console and automated tests: tcs.disp, tcs.net, tcs.map.
window.tcs = { map, get disp() { return disp; }, get net() { return net; }, get railnet() { return railnet; } };
