// Real-data tests on the Jacksonville, FL Overpass export (data/jacksonville.osm.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importOverpass } from '../src/osm-import.js';
import { buildNetwork, externalSections } from '../src/network.js';
import { buildRailnet } from '../src/railnet.js';
import { Dispatcher } from '../src/dispatcher.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const net = buildNetwork(importOverpass([load('jacksonville.osm.json'), load('jacksonville-areas.osm.json')]));
const rn = buildRailnet(net);
const ils = Object.values(net.interlockings);
const byName = (n) => ils.find((i) => i.name === n);

test('one connected network, fragments dropped', () => {
  assert.equal(net.report.components.length, 1);
  assert.ok(net.report.components[0].km > 900);
});

test('yards are collapsed and named from OSM', () => {
  const yards = ils.filter((i) => i.kind === 'yard').map((i) => i.name);
  for (const y of ['Moncrief Yard', 'Simpson Yard', 'Bowden Yard', 'Baldwin Yard', 'Acorn Yard']) assert.ok(yards.includes(y), y);
  assert.equal(new Set(yards).size, yards.length, 'each yard is one node');
});

test('track leaving the map becomes named portals', () => {
  const portals = ils.filter((i) => i.kind === 'portal').map((i) => i.name);
  for (const p of ['Sanford Subdivision to the south', 'Kingsland Subdivision to the north', 'Valdosta District to the northwest'])
    assert.ok(portals.includes(p), p);
});

test('sections carry subdivision names from route relations', () => {
  const lines = new Set(externalSections(net).map((s) => s.line).filter(Boolean));
  for (const l of ['Callahan Subdivision', 'Nahunta Subdivision', 'Sanford Subdivision', 'Florida East Coast Railway', 'Valdosta District'])
    assert.ok(lines.has(l), l);
});

test('railnet: double-track portals merge, junctions are named, edges cover the main line once', () => {
  const nodes = Object.values(rn.nodes);
  assert.equal(nodes.filter((n) => n.kind === 'portal').length, 7);
  for (const j of ['Duval Connection', 'North Shore Junction', 'A624.0 Callahan'])
    assert.ok(nodes.some((n) => n.name === j) || Object.values(rn.nodes).some((n) => n.interlockings.some((i) => net.interlockings[i].name === j)), j);
  const owner = new Map();
  for (const e of Object.values(rn.edges)) for (const s of e.sections) owner.set(s, (owner.get(s) || 0) + 1);
  const main = externalSections(net).filter((s) => s.kind === 'main' && s.ia !== s.ib);
  assert.deepEqual(main.filter((s) => !owner.has(s.id)).map((s) => s.id), [], 'every main section is in an edge');
  const shared = [...owner.values()].filter((c) => c > 1).length;
  assert.ok(shared / owner.size < 0.02, `${shared} sections in more than one edge`);
  assert.ok(Object.values(rn.edges).some((e) => e.name === 'Nahunta Subdivision' && e.tracks === 'double'));
});

test('reversing moves: refused when turned off, made when allowed', () => {
  const off = new Dispatcher(net, null, { allowReversing: false });
  off.addTrain({ id: 'X', from: byName('Kingsland Subdivision to the north').id, to: byName('Yard 1').id });
  off.tick(1);
  assert.equal(off.state.trains.X.status, 'noroute');
  assert.equal(off.state.trains.X.legs.length, 0);

  for (const [from, to] of [['Kingsland Subdivision to the north', 'Yard 1'], ['Yard 4', 'Yard 1']]) {
    const d = new Dispatcher(net);
    d.addTrain({ id: 'X', from: byName(from).id, to: byName(to).id, length: 1200 });
    for (let s = 0; s < 3 * 3600 && d.state.trains.X.status !== 'arrived'; s++) {
      d.tick(1);
      if (s % 10 === 0) assert.deepEqual(d.checkInvariants(), []);
    }
    assert.equal(d.state.trains.X.status, 'arrived', `${from} -> ${to}`);
    assert.equal(d.state.trains.X.reversals, 1);
  }
});

test('random traffic between portals and yards: no collisions, no deadlocks', () => {
  const pts = ils.filter((i) => i.kind === 'portal' || i.kind === 'yard');
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 4; trial++) {
    const d = new Dispatcher(net);
    for (let i = 0; i < 12; i++) {
      const a = pts[Math.floor(rnd() * pts.length)];
      let b;
      do b = pts[Math.floor(rnd() * pts.length)]; while (b === a);
      d.addTrain({ from: a.id, to: b.id, length: 500 + Math.floor(rnd() * 2000), maxSpeed: 15 + rnd() * 15 });
    }
    let done = false;
    for (let s = 0; s < 24 * 3600 && !done; s++) {
      d.tick(1);
      // Trains that reach a yard are broken up there, so yards don't fill for good.
      for (const t of Object.values(d.state.trains)) if (t.inYard) d.breakUp(t.id);
      if (s % 60 === 0) assert.deepEqual(d.checkInvariants(), [], `trial ${trial} t=${s}`);
      done = Object.values(d.state.trains).every((t) => t.status === 'arrived' || t.status === 'noroute');
      const stuck = d.stalled(3600);
      if (stuck.length) assert.fail(`trial ${trial}: stalled ${stuck.map((t) => `${t.id} (${t.wait?.reason})`).join(', ')}`);
    }
    assert.ok(done, `trial ${trial} did not finish`);
  }
});

test('double track split by industry switches still counts as double track', () => {
  // FEC between CP 88 and CP 233: one track has extra switches (CP 105, 309, 234), the other doesn't.
  for (const id of ['s887', 's1373', 's359', 's265']) {
    const c = net.chains[net.sections[id].chain];
    assert.ok(c.bypass, `${id} should have a way past`);
  }
});

test('pilot, Moncrief to Bowden: opposing trains use both tracks', () => {
  const a = byName('Moncrief Yard').id;
  const b = byName('Bowden Yard').id;
  const spec = { length: 1500, maxSpeed: 50 * 0.44704 };
  const trip = (trains) => {
    const d = new Dispatcher(net);
    for (const t of trains) d.addTrain({ ...t, ...spec });
    for (let s = 0; s < 3 * 3600 && !Object.values(d.state.trains).every((t) => t.status === 'arrived'); s++) {
      d.tick(1);
      if (s % 30 === 0) assert.deepEqual(d.checkInvariants(), []);
    }
    const out = {};
    for (const e of d.state.events) if (e.msg.startsWith('arrived')) out[e.train] = e.t / 60;
    return out;
  };
  const alone = trip([{ id: 'E', from: a, to: b }]).E;
  const opp = trip([{ id: 'E', from: a, to: b }, { id: 'W', from: b, to: a }]);
  assert.ok(opp.E - alone < 2 && opp.W - alone < 2, `opposing pair lost ${(opp.E - alone).toFixed(1)} / ${(opp.W - alone).toFixed(1)} min`);
  const three = trip([{ id: 'E1', from: a, to: b }, { id: 'E2', from: a, to: b }, { id: 'W', from: b, to: a }]);
  assert.ok(three.W - alone < 2, `opposing train lost ${(three.W - alone).toFixed(1)} min to two followers`);
});

test('railnet run-time tables: 5 to 80 mph, faster trains never slower, matches kinematics', async () => {
  const { profileTime } = await import('../src/railnet.js');
  const v = 60 * 0.44704;
  assert.ok(Math.abs(profileTime([[10000, 60]], 60) - (10000 / v + v / 0.3 + v / 0.6)) < 0.5);
  assert.deepEqual(rn.timing.speedClasses, Array.from({ length: 16 }, (_, i) => 5 * (i + 1)));
  for (const e of Object.values(rn.edges)) {
    const ts = rn.timing.speedClasses.map((s) => e.runTimes[s]);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] <= ts[i - 1], `${e.id} slower at ${rn.timing.speedClasses[i]} mph`);
    assert.ok(ts.at(-1) >= e.lineSpeedTime);
  }
});

test('facility areas: unnamed works relation joins Moncrief; yards get capacity', () => {
  const moncrief = byName('Moncrief Yard');
  assert.ok(moncrief.works, 'Moncrief has the railroad works area');
  assert.ok(moncrief.capacity.areaKm2 > 0.4);
  for (const y of ils.filter((i) => i.kind === 'yard')) {
    const c = y.capacity;
    assert.ok(c && c.trackLength > 0 && c.cars >= 0 && c.leads >= 1, y.name);
    assert.ok(c.standingLength <= c.trackLength && c.longestTrack <= c.trackLength);
  }
  // Baldwin's tracks are tagged as spurs; its mapped area brings them in.
  assert.ok(byName('Baldwin Yard').capacity.trackLength > 20000);
  // A plain landuse=railway area around a station isn't a yard.
  assert.ok(!byName('Orange Park Station') || byName('Orange Park Station').kind !== 'yard');
});

test('several input files merge without duplicates', () => {
  const both = importOverpass([load('jacksonville-areas.osm.json'), load('jacksonville-areas.osm.json')]);
  assert.equal(both.features.yards.length, 1);
  assert.equal(both.features.yards[0].type, 'works');
  assert.equal(both.features.yards[0].rings.length, 1);
});
