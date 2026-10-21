// Generates fixtures/sample-line.json: a synthetic Overpass response covering the
// mapping styles the importer has to handle. Run: node fixtures/make-fixture.js
//
//  W ===== A ==main== B ===== b1 ===== C ==main== D ===== E ==trk1== X ==trk1== F ===== G ===== H
//           \=siding=/         \spur      \=short=/          \=trk2==/\==trk2==/  tracks=2   single
//                                                               (crossover at X)
// plus an abandoned branch that must be ignored.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAT = 39.0;
const UP = 0.00025; // ~28 m north for parallel track
let seq = 1000;
const nodes = [];
const ways = [];
const node = (lat, lon, tags) => {
  const id = seq++;
  nodes.push({ type: 'node', id, lat: +lat.toFixed(7), lon: +lon.toFixed(7), ...(tags ? { tags } : {}) });
  return id;
};
const way = (ids, tags) => ways.push({ type: 'way', id: seq++, nodes: ids, tags: { railway: 'rail', ...tags } });
const along = (lon0, lon1, n, lat = LAT) => Array.from({ length: n }, (_, i) => node(lat, lon0 + ((lon1 - lon0) * (i + 1)) / (n + 1)));

const sw = { railway: 'switch' };
const W = node(LAT, -113.0);
const A = node(LAT, -112.9, sw);
const B = node(LAT, -112.88, sw);
const b1 = node(LAT, -112.8, sw);
const C = node(LAT, -112.7, sw);
const D = node(LAT, -112.686, sw);
const E = node(LAT, -112.55, sw);
const X1a = node(LAT, -112.505, sw);
const F = node(LAT, -112.45, sw);
const G = node(LAT, -112.3);
const H = node(LAT, -112.2);

const main = { usage: 'main', maxspeed: '70 mph', name: 'Sample Subdivision' };
way([W, ...along(-113.0, -112.9, 4), A, ...along(-112.9, -112.88, 1), B, ...along(-112.88, -112.8, 3), b1,
  ...along(-112.8, -112.7, 4), C, ...along(-112.7, -112.686, 1), D, ...along(-112.686, -112.55, 5), E], main);

// Passing siding A-B (~1.7 km) and a short siding C-D (~1.2 km).
way([A, node(LAT + UP, -112.8985), node(LAT + UP, -112.8815), B], { service: 'siding', maxspeed: '20 mph' });
way([C, node(LAT + UP, -112.6985), node(LAT + UP, -112.6875), D], { service: 'siding', maxspeed: '20 mph' });

// Industrial spur off b1.
way([b1, node(LAT - 0.0004, -112.797), node(LAT - 0.003, -112.792)], { service: 'spur', maxspeed: '10 mph' });

// Double track mapped as separate ways with a crossover (E .. F).
const dt = { usage: 'main', maxspeed: '79 mph', name: 'Sample Subdivision', 'railway:track_ref': '1' };
way([E, ...along(-112.55, -112.505, 2), X1a, ...along(-112.505, -112.45, 2), F], dt);
const u0 = node(LAT + UP, -112.546);
const X1b = node(LAT + UP, -112.503, sw);
const u1 = node(LAT + UP, -112.454);
way([E, u0, ...along(-112.546, -112.503, 2, LAT + UP), X1b, ...along(-112.503, -112.454, 2, LAT + UP), u1, F],
  { ...dt, 'railway:track_ref': '2' });
way([X1a, X1b], { service: 'crossover', maxspeed: '30 mph' });

// Double track mapped as one way with tracks=2 (F .. G), then single track to H.
way([F, ...along(-112.45, -112.3, 4), G], { ...main, maxspeed: '79 mph', tracks: '2' });
way([G, ...along(-112.3, -112.2, 3), H], { ...main, maxspeed: '60 mph' });

// Abandoned branch: not railway=rail, must be ignored.
ways.push({ type: 'way', id: seq++, nodes: [b1, node(LAT + 0.01, -112.8)], tags: { railway: 'abandoned' } });

const out = { version: 0.6, generator: 'make-fixture.js', elements: [...ways, ...nodes] };
const path = fileURLToPath(new URL('./sample-line.json', import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(`wrote ${path}: ${nodes.length} nodes, ${ways.length} ways`);
