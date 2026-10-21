// Dispatcher pilot: runs fixed scenarios between two places and reports each train's
// trip time and the minutes lost against running alone.
//
//   node tools/pilot.js data/jacksonville.railnet.json "Moncrief Yard" "Bowden Yard" [lengthM] [mph]

import { readFileSync } from 'node:fs';
import { Dispatcher } from '../src/dispatcher.js';

const [file, A, B, lenArg, mphArg] = process.argv.slice(2);
const { network: net } = JSON.parse(readFileSync(file, 'utf8'));
const il = (name) => Object.values(net.interlockings).find((i) => i.name === name)?.id || (() => { throw new Error(`no place named ${name}`); })();
const a = il(A);
const b = il(B);
const spec = { length: +(lenArg || 1500), maxSpeed: +(mphArg || 50) * 0.44704 };

function run(trains) {
  const d = new Dispatcher(net);
  const t0 = {};
  const pending = trains.map((t, i) => ({ ...t, id: t.id || `T${i + 1}` }));
  for (let s = 0; s < 6 * 3600; s++) {
    for (const p of pending) if (t0[p.id] === undefined && s >= (p.at || 0) * 60) { d.addTrain({ id: p.id, from: p.from, to: p.to, ...spec }); t0[p.id] = s; }
    d.tick(1);
    if (pending.every((p) => d.state.trains[p.id] && ['arrived', 'noroute'].includes(d.state.trains[p.id].status))) break;
    if (d.checkInvariants().length) throw new Error(d.checkInvariants()[0]);
  }
  const arrived = {};
  for (const e of d.state.events) if (e.msg.startsWith('arrived')) arrived[e.train] = e.t;
  return Object.fromEntries(pending.map((p) => [p.id, arrived[p.id] != null ? (arrived[p.id] - t0[p.id]) / 60 : null]));
}

const alone = { E: run([{ id: 'E', from: a, to: b }]).E, W: run([{ id: 'W', from: b, to: a }]).W };
console.log(`${A} <-> ${B}, ${spec.length} m trains at up to ${mphArg || 50} mph`);
console.log(`Alone: east ${alone.E.toFixed(1)} min, west ${alone.W.toFixed(1)} min\n`);
const scenarios = [
  ['Two trains, same direction, released together', [{ id: 'E1', from: a, to: b }, { id: 'E2', from: a, to: b }]],
  ['Two trains, same direction, 10 min apart', [{ id: 'E1', from: a, to: b }, { id: 'E2', from: a, to: b, at: 10 }]],
  ['Opposing pair, released together', [{ id: 'E', from: a, to: b }, { id: 'W', from: b, to: a }]],
  ['Two following, one opposing', [{ id: 'E1', from: a, to: b }, { id: 'E2', from: a, to: b }, { id: 'W', from: b, to: a }]],
];
for (const [name, trains] of scenarios) {
  const r = run(trains);
  console.log(name);
  for (const [id, m] of Object.entries(r)) {
    const base = id.startsWith('W') ? alone.W : alone.E;
    console.log(`  ${id.padEnd(3)} ${m == null ? 'did not arrive' : `${m.toFixed(1)} min${m - base > 0.05 ? ` (+${(m - base).toFixed(1)})` : ''}`}`);
  }
}
