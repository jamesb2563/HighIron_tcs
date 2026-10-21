// Offline build: Overpass export -> network + railnet JSON the game loads directly.
//
//   node tools/build-railnet.js data/jacksonville.osm.json [more.osm.json ...] [--out=file.json]
//
// Several input files are merged (duplicates dropped), so a supplementary export of
// areas or fixes can sit beside the main one. Output defaults to the first input's
// name with .railnet.json.
//
// Prints a report: connectivity, dropped fragments, possible gaps worth checking in
// OSM, portals, yards, and railnet size. Pass --connect=from:to,from:to to join gaps
// you've confirmed by hand (OSM node ids).

import { readFileSync, writeFileSync } from 'node:fs';
import { importOverpass } from '../src/osm-import.js';
import { buildNetwork, externalSections } from '../src/network.js';
import { buildRailnet } from '../src/railnet.js';

const args = process.argv.slice(2);
const inputs = args.filter((a) => !a.startsWith('--'));
if (!inputs.length) { console.error('usage: node tools/build-railnet.js <overpass.json> [more.json ...] [--out=file.json] [--connect=a:b,...]'); process.exit(1); }
const input = inputs[0];
const output = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || input.replace(/(\.osm)?\.json$/, '') + '.railnet.json';
const connect = (args.find((a) => a.startsWith('--connect=')) || '').slice(10).split(',').filter(Boolean)
  .map((p) => p.split(':').map(Number));

const t0 = Date.now();
const raw = importOverpass(inputs.map((f) => JSON.parse(readFileSync(f, 'utf8'))), { connect });
const network = buildNetwork(raw);
const railnet = buildRailnet(network);
writeFileSync(output, JSON.stringify({ builtAt: new Date().toISOString(), sources: inputs, network, railnet }));

const r = network.report;
const ext = externalSections(network);
const km = (m) => (m / 1000).toFixed(1);
const kinds = {};
for (const s of ext) kinds[s.kind] = (kinds[s.kind] || 0) + s.length;
const nk = {};
for (const n of Object.values(railnet.nodes)) nk[n.kind] = (nk[n.kind] || 0) + 1;

console.log(`Built ${output} in ${Date.now() - t0} ms`);
console.log(`Track: ${Object.entries(kinds).map(([k, v]) => `${k} ${km(v)} km`).join(', ')}`);
console.log(`Connected pieces: ${r.components.length} (${r.components.slice(0, 5).map((c) => `${c.km} km`).join(', ')})`);
console.log(`Dropped fragments: ${r.droppedFragments.length}`);
const suspects = r.gaps.filter((g) => !g.snapped);
console.log(`Gaps joined: ${r.gaps.filter((g) => g.snapped).length}; possible gaps to check in OSM: ${suspects.length}`);
for (const g of suspects.slice(0, 12)) console.log(`  node ${g.node} at ${g.lat.toFixed(5)},${g.lon.toFixed(5)}: ${g.distance} m from other track`);
console.log(`Portals (${r.portals.length}): ${r.portals.join('; ')}`);
console.log(`Yards (${r.yards.length}):`);
for (const il of Object.values(network.interlockings).filter((i) => i.kind === 'yard').sort((a, b) => b.capacity.trackLength - a.capacity.trackLength)) {
  const c = il.capacity;
  const tags = [il.works && 'works', il.terminal && 'terminal'].filter(Boolean).join(', ');
  console.log(`  ${il.name}${tags ? ` [${tags}]` : ''}: ${km(c.trackLength)} km track, ${c.standingTracks} standing pieces, longest ${c.longestTrack} m, ~${c.cars} cars, ${c.leads} connection(s)${c.areaKm2 ? `, ${c.areaKm2} km² mapped` : ''}`);
}
console.log(`Railnet: ${Object.keys(railnet.nodes).length} nodes (${Object.entries(nk).map(([k, v]) => `${v} ${k}`).join(', ')}), ${Object.keys(railnet.edges).length} edges`);
if (network.warnings.length) console.log(`Warnings: ${network.warnings.length}\n  ${network.warnings.slice(0, 10).join('\n  ')}`);
