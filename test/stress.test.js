// Randomised traffic: many trains in both directions plus spur moves, checking safety
// invariants and that everything eventually arrives (no deadlock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importOverpass } from '../src/osm-import.js';
import { buildNetwork } from '../src/network.js';
import { Dispatcher } from '../src/dispatcher.js';

const net = buildNetwork(importOverpass(JSON.parse(readFileSync(new URL('../fixtures/sample-line.json', import.meta.url)))));
const [WEST, SPUR, EAST] = Object.values(net.interlockings).filter((i) => i.kind === 'end' || i.kind === 'portal').sort((a, b) => a.lon - b.lon).map((i) => i.id);

test('randomised traffic: no collisions, no deadlocks', () => {
  let seed = 2026;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pairs = [[WEST, EAST], [EAST, WEST], [SPUR, WEST], [WEST, SPUR]];
  for (let trial = 0; trial < 40; trial++) {
    const d = new Dispatcher(net);
    const n = 6 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const [from, to] = pairs[Math.floor(rnd() * 4)];
      d.addTrain({ from, to, length: 400 + Math.floor(rnd() * 2400), maxSpeed: 15 + rnd() * 20 });
    }
    let done = false;
    for (let s = 0; s < 16 * 3600 && !done; s++) {
      d.tick(1);
      if (s % 20 === 0) assert.deepEqual(d.checkInvariants(), [], `trial ${trial} t=${s}`);
      done = Object.values(d.state.trains).every((t) => t.status === 'arrived');
      const stuck = d.stalled(1800);
      if (stuck.length) assert.fail(`trial ${trial}: stalled ${stuck.map((t) => `${t.id} (${t.wait?.reason})`).join(', ')}`);
    }
    assert.ok(done, `trial ${trial} did not finish`);
  }
});
