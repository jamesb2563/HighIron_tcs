// Dispatcher controls, signals, turnout speeds, yards and reversing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importOverpass } from '../src/osm-import.js';
import { buildNetwork, externalSections } from '../src/network.js';
import { Dispatcher } from '../src/dispatcher.js';

const MPH = 0.44704;
const net = buildNetwork(importOverpass(JSON.parse(readFileSync(new URL('../fixtures/sample-line.json', import.meta.url)))));
const secs = externalSections(net);
const ends = Object.values(net.interlockings).filter((i) => i.kind === 'end' || i.kind === 'portal').sort((a, b) => a.lon - b.lon);
const WEST = ends[0].id;
const EAST = ends.at(-1).id;
const sidingAB = secs.filter((s) => s.kind === 'siding').sort((a, b) => b.length - a.length)[0];
const mainAB = secs.find((s) => s.kind === 'main' && s.group === sidingAB.group);
const longMain = secs.filter((s) => s.kind === 'main' && s.lanes === 1).sort((a, b) => b.length - a.length)[0];

/** Run until every train is done (or a limit); returns per-train traces. */
function run(d, { limit = 6 * 3600, each } = {}) {
  const used = {};
  for (let s = 0; s < limit; s++) {
    d.tick(1);
    if (s % 10 === 0) assert.deepEqual(d.checkInvariants(), [], `t=${s}`);
    for (const t of Object.values(d.state.trains)) {
      for (const l of t.legs) (used[t.id] ||= new Set()).add(l.sec);
      each?.(t, s);
    }
    if (Object.values(d.state.trains).every((t) => ['arrived', 'noroute'].includes(t.status))) break;
  }
  return used;
}
const arrivedAt = (d, id) => d.state.events.find((e) => e.train === id && e.msg.startsWith('arrived'))?.t;

test('hold keeps a train at stop without counting as a deadlock; release lets it go', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'A', from: WEST, to: EAST });
  d.hold('A');
  for (let s = 0; s < 2000; s++) d.tick(1);
  assert.equal(d.state.trains.A.legs.length, 0);
  assert.deepEqual(d.stalled(600), []);
  d.release('A');
  run(d);
  assert.equal(d.state.trains.A.status, 'arrived');
});

test('hold at an interlocking: the train stops there until released', () => {
  const d = new Dispatcher(net);
  const at = mainAB.ib;
  d.addTrain({ id: 'A', from: WEST, to: EAST });
  d.holdAt('A', at);
  for (let s = 0; s < 3000; s++) d.tick(1);
  const t = d.state.trains.A;
  assert.equal(d.exitIL(t.legs.at(-1).sec, t.legs.at(-1).dir), at);
  assert.ok(t.speed < 0.1 && /held at/.test(t.wait.reason));
  d.release('A');
  run(d);
  assert.equal(t.status, 'arrived');
});

test('priority: when two trains want the same track, the higher-priority one gets it', () => {
  const order = (pri) => {
    const d = new Dispatcher(net);
    d.addTrain({ id: 'L', from: WEST, to: EAST, priority: pri.L });
    d.addTrain({ id: 'H', from: WEST, to: EAST, priority: pri.H });
    run(d);
    return d.state.events.filter((e) => e.msg.startsWith('arrived')).map((e) => e.train).join('');
  };
  assert.equal(order({ L: 0, H: 0 }), 'LH', 'equal priority: first come, first served');
  assert.equal(order({ L: 0, H: 5 }), 'HL', 'higher priority goes first');
});

test('priority: a lower-priority train yields track a waiting higher-priority train needs, but not forever', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'H', from: EAST, to: WEST, priority: 5 });
  const H = d.state.trains.H;
  H.plan = d.loopFreeRoute(H, new Set()).map((p) => `${p.sec}:${p.dir}`);
  H.wait = { since: 0, reason: 'waiting' };
  H.nextRequestAt = Infinity; // keep H waiting for this test
  d.addTrain({ id: 'L', from: WEST, to: EAST, priority: 0 });
  d.tick(1);
  assert.equal(d.state.trains.L.legs.length, 0);
  assert.match(d.state.trains.L.wait.reason, /yielding to H/);
  for (let s = 0; s < d.opts.yieldLimit + 30; s++) d.tick(1);
  assert.ok(d.state.trains.L.legs.length > 0, 'L goes after the yield limit');
});

test('route via a siding, with the turnout speed limit observed', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'A', from: WEST, to: EAST, length: 900, maxSpeed: 60 * MPH });
  d.setRoute('A', [sidingAB.id]);
  let worst = 0;
  const used = run(d, {
    each: (t) => {
      for (const l of t.legs) if (l.turnoutMph && l.start <= t.head && l.start >= t.head - t.length) worst = Math.max(worst, t.speed / MPH - l.turnoutMph);
    },
  });
  assert.ok(used.A.has(sidingAB.id), 'took the siding');
  assert.ok(worst < 1, `exceeded turnout speed by ${worst.toFixed(1)} mph`);
  assert.equal(d.state.trains.A.status, 'arrived');
});

test('slow order makes the trip longer; lifting it restores the time', () => {
  const trip = (slow) => {
    const d = new Dispatcher(net);
    if (slow) d.slowOrder(longMain.id, 10);
    d.addTrain({ id: 'A', from: WEST, to: EAST });
    run(d);
    return arrivedAt(d, 'A');
  };
  const normal = trip(false);
  const slowed = trip(true);
  const expected = longMain.length / (10 * MPH) - longMain.length / Math.min(26.8, longMain.speed);
  assert.ok(slowed - normal > expected * 0.8, `slow order added ${slowed - normal}s, expected about ${Math.round(expected)}s`);
});

test('out of service: double track routes around it; single track waits until restored', () => {
  const d = new Dispatcher(net);
  d.setOutOfService(mainAB.id);
  d.addTrain({ id: 'A', from: WEST, to: EAST, length: 900 });
  const used = run(d);
  assert.ok(used.A.has(sidingAB.id) && !used.A.has(mainAB.id));

  const d2 = new Dispatcher(net);
  d2.setOutOfService(longMain.id);
  d2.addTrain({ id: 'B', from: WEST, to: EAST });
  for (let s = 0; s < 1200; s++) d2.tick(1);
  assert.notEqual(d2.state.trains.B.status, 'noroute');
  assert.match(d2.state.trains.B.wait.reason, /out of service/);
  d2.setOutOfService(longMain.id, false);
  run(d2);
  assert.equal(d2.state.trains.B.status, 'arrived');
});

test('signals: a follower sees Approach and keeps to approach speed under it', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'A', from: WEST, to: EAST, maxSpeed: 40 * MPH });
  d.addTrain({ id: 'B', from: WEST, to: EAST, maxSpeed: 60 * MPH });
  const seen = new Set();
  let over = 0;
  run(d, {
    each: (t) => {
      if (t.id !== 'B' || !t.legs.length) return;
      const v = d.signalView(t);
      if (v.next) seen.add(v.next.aspect);
      if (v.governing === 'approach') over = Math.max(over, t.speed / MPH - d.opts.approachMph);
    },
  });
  assert.ok(seen.has('clear') && seen.has('approach'), [...seen].join(','));
  assert.ok(over < 1, `ran ${over.toFixed(1)} mph over approach speed`);
  assert.ok(d.signalStates !== undefined);
});

// ---------------------------------------------------------------- Jacksonville yards
const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const jax = buildNetwork(importOverpass([load('jacksonville.osm.json'), load('jacksonville-areas.osm.json')]));
const J = (name) => Object.values(jax.interlockings).find((i) => i.name === name).id;

test('yard capacity: a full yard holds the next train out until space frees up', () => {
  const net2 = structuredClone(jax);
  const bowden = J('Bowden Yard');
  net2.interlockings[bowden].capacity.standingLength = 3200;
  const d = new Dispatcher(net2);
  const from = J('Florida East Coast Railway to the southeast');
  for (const id of ['A', 'B', 'C']) d.addTrain({ id, from, to: bowden, length: 1500 });
  let sawFull = false;
  for (let s = 0; s < 4 * 3600; s++) {
    d.tick(1);
    if (s % 10 === 0) assert.deepEqual(d.checkInvariants(), []);
    if (/is full/.test(d.state.trains.C.wait?.reason || '')) sawFull = true;
    if (d.state.trains.A.status === 'arrived' && d.state.trains.B.status === 'arrived') break;
  }
  assert.ok(sawFull, 'C was held for room');
  assert.notEqual(d.state.trains.C.status, 'arrived');
  assert.deepEqual(d.yardStatus(bowden).trains.sort(), ['A', 'B']);
  d.breakUp('A');
  for (let s = 0; s < 3 * 3600 && d.state.trains.C.status !== 'arrived'; s++) d.tick(1);
  assert.equal(d.state.trains.C.status, 'arrived');
});

test('onward trip: arrive at a yard, dwell, depart for the next destination', () => {
  const d = new Dispatcher(jax);
  d.addTrain({ id: 'A', from: J('Valdosta District to the northwest'), to: J('Moncrief Yard'), then: { to: J('Nahunta Subdivision to the northwest'), dwell: 900 } });
  let dwellStart = null;
  let departed = null;
  for (let s = 0; s < 6 * 3600; s++) {
    d.tick(1);
    const t = d.state.trains.A;
    if (t.status === 'dwelling' && dwellStart === null) dwellStart = d.state.time;
    if (dwellStart !== null && departed === null && t.legs.length) departed = d.state.time;
    if (t.status === 'arrived' && t.dest === J('Nahunta Subdivision to the northwest')) break;
  }
  assert.ok(departed - dwellStart >= 900, `dwelt ${departed - dwellStart}s`);
  assert.equal(d.state.trains.A.status, 'arrived');
  assert.deepEqual(d.yardStatus(J('Moncrief Yard')).trains, [], 'left the yard');
});

test('yards lock per lead: departures can use different leads at the same time', () => {
  const d = new Dispatcher(jax);
  const moncrief = J('Moncrief Yard');
  const portals = ['Valdosta District to the northwest', 'Sanford Subdivision to the south', 'Nahunta Subdivision to the northwest', 'Kingsland Subdivision to the north'];
  portals.forEach((p, i) => d.addTrain({ id: `T${i}`, from: moncrief, to: J(p), length: 1200 }));
  let most = 0;
  for (let s = 0; s < 4 * 3600; s++) {
    d.tick(1);
    if (s % 10 === 0) assert.deepEqual(d.checkInvariants(), []);
    const leads = new Set(Object.entries(d.state.locks).filter(([k]) => k.startsWith(`${moncrief}@`)).map(([, v]) => v));
    most = Math.max(most, leads.size);
    for (const t of Object.values(d.state.trains)) if (t.inYard) d.breakUp(t.id);
    if (Object.values(d.state.trains).every((t) => t.status === 'arrived')) break;
  }
  assert.ok(Object.values(d.state.trains).every((t) => t.status === 'arrived'));
  assert.ok(most >= 2, `at most ${most} train(s) on Moncrief leads at once`);
});

test('chaos: random traffic with holds, slow orders and closures finishes safely', async () => {
  const { chaos } = await import('../tools/chaos.js');
  const r = chaos(jax, { seed: 5, trials: 2, trains: 10, log: () => {} });
  for (const x of r) assert.equal(x.result, 'done', `trial ${x.trial}: ${x.result} ${x.stuck.join('; ')}`);
});
