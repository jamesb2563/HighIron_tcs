import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importOverpass, parseMaxspeed } from '../src/osm-import.js';
import { buildNetwork } from '../src/network.js';
import { Dispatcher } from '../src/dispatcher.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-line.json', import.meta.url)));
const net = buildNetwork(importOverpass(fixture));

const secs = Object.values(net.sections);
const ils = Object.values(net.interlockings);
const ends = ils.filter((i) => i.kind === 'end' || i.kind === 'portal');
// Ends sorted west -> east by longitude; the spur end sits in the middle.
const [WEST, SPUR, EAST] = ends.sort((a, b) => a.lon - b.lon).map((i) => i.id);

function run(d, { maxTime = 6 * 3600, dt = 1 } = {}) {
  for (let t = 0; t < maxTime; t += dt) {
    d.tick(dt);
    const errs = d.checkInvariants();
    assert.deepEqual(errs, [], `invariant broken at ${d.state.time}s`);
    if (Object.values(d.state.trains).every((x) => x.status === 'arrived')) return d.state.time;
    const stuck = d.stalled(1800);
    if (stuck.length) assert.fail(`stalled: ${stuck.map((s) => `${s.id} (${s.wait.reason})`).join(', ')}`);
  }
  assert.fail('trains did not all arrive');
}

test('maxspeed parsing', () => {
  assert.equal(Math.round(parseMaxspeed('70 mph') * 100) / 100, 31.29);
  assert.equal(Math.round(parseMaxspeed('100') * 3.6), 100);
  assert.equal(parseMaxspeed('signals'), null);
});

test('importer ignores non-rail ways and splits at junctions', () => {
  const raw = importOverpass(fixture);
  assert.ok(raw.edges.size > 0);
  for (const e of raw.edges.values()) assert.notEqual(e.tags.railway, 'abandoned');
  assert.equal(ends.length, 3, 'two line ends plus the spur end');
});

test('passing sidings, double track and tracks=2 become passable groups', () => {
  const passable = Object.values(net.groups).filter((g) => g.passable);
  assert.equal(passable.length, 5); // siding A-B, siding C-D, E-X, X-F, F-G (tracks=2)
  assert.ok(secs.some((s) => s.lanes === 2 && !s.internal));
});

test('crossover is internal to one interlocking and allows a track change', () => {
  const xo = secs.find((s) => s.kind === 'crossover');
  assert.ok(xo.internal);
  assert.equal(xo.ia, xo.ib);
  const into = Object.entries(net.transitions).filter(([k, v]) => v.length === 2 && net.sections[k.split(':')[0]].ib === xo.ia);
  assert.ok(into.length >= 1, 'some track reaches two exits through the crossover interlocking');
});

test('no V-turn from a siding back onto the parallel main', () => {
  const siding = secs.find((s) => s.kind === 'siding' && s.length > 1500);
  for (const side of ['a', 'b']) {
    for (const tr of net.transitions[`${siding.id}:${side}`]) {
      assert.notEqual(net.sections[tr.sec].group, siding.group);
    }
  }
});

test('long single track is split into automatic blocks', () => {
  const longest = secs.filter((s) => s.kind === 'main' && s.lanes === 1).sort((a, b) => b.length - a.length)[0];
  assert.ok(longest.blockCount >= 3);
});

test('following trains stack and arrive in order', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'A', from: WEST, to: EAST });
  d.addTrain({ id: 'B', from: WEST, to: EAST });
  d.addTrain({ id: 'C', from: WEST, to: EAST });
  run(d);
  const order = d.state.events.filter((e) => e.msg.startsWith('arrived')).map((e) => e.train);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('opposing trains meet without deadlock', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'E1', from: WEST, to: EAST });
  d.addTrain({ id: 'W1', from: EAST, to: WEST });
  d.addTrain({ id: 'E2', from: WEST, to: EAST });
  d.addTrain({ id: 'W2', from: EAST, to: WEST });
  run(d);
});

test('trains too long for the sidings still meet on double track', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'E', from: WEST, to: EAST, length: 2500 });
  d.addTrain({ id: 'W', from: EAST, to: WEST, length: 2500 });
  run(d);
});

test('spur faces west: from the east a train has to reverse, and does', () => {
  const off = new Dispatcher(net, null, { allowReversing: false });
  off.addTrain({ id: 'X', from: SPUR, to: EAST, length: 600 });
  off.tick(1);
  assert.equal(off.state.trains.X.status, 'noroute');

  const d = new Dispatcher(net);
  d.addTrain({ id: 'X', from: SPUR, to: EAST, length: 600 });
  run(d);
  assert.equal(d.state.trains.X.reversals, 1);
  assert.ok(d.state.events.some((e) => e.msg.startsWith('reversed')));
});

test('mixed traffic including spur moves', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'L', from: SPUR, to: WEST, length: 600 });
  d.addTrain({ id: 'E', from: WEST, to: EAST });
  d.addTrain({ id: 'S', from: WEST, to: SPUR, length: 600 });
  d.addTrain({ id: 'W2', from: EAST, to: WEST, length: 1000 });
  run(d);
});

test('state survives a JSON round trip mid-run', () => {
  const d = new Dispatcher(net);
  d.addTrain({ id: 'E', from: WEST, to: EAST });
  d.addTrain({ id: 'W', from: EAST, to: WEST });
  for (let i = 0; i < 900; i++) d.tick(1);
  const saved = JSON.stringify({ net, state: d.toJSON() });
  const { net: n2, state } = JSON.parse(saved);
  const d2 = Dispatcher.fromJSON(n2, state);
  run(d2);
});
