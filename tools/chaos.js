// Chaos test: random traffic plus random dispatcher actions, checking the safety
// invariants and that everything finishes. Use it after any dispatcher change.
//
//   node tools/chaos.js data/jacksonville.railnet.json [seed=1] [trials=6] [trains=14]
//
// Each trial: trains between random portals and yards with random lengths, speeds and
// priorities; 40% of yard arrivals have an onward trip. Every 10 simulated minutes one of:
// hold a running train for 5 min, a 10-20 mph slow order for 30 min, or a main-line
// section out of service for 20 min. Trains left standing in a yard are broken up after
// 20 min. A trial fails on any invariant breach, or if it hasn't finished in 30 h.

import { readFileSync } from 'node:fs';
import { Dispatcher } from '../src/dispatcher.js';

export function chaos(net, { seed = 1, trials = 6, trains = 14, log = console.log } = {}) {
  const I = Object.values(net.interlockings);
  const pts = I.filter((i) => i.kind === 'portal' || i.kind === 'yard');
  const mains = Object.values(net.sections).filter((s) => s.kind === 'main' && !s.internal && s.ia !== s.ib);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const results = [];
  for (let trial = 0; trial < trials; trial++) {
    const d = new Dispatcher(net);
    for (let i = 0; i < trains; i++) {
      const a = pick(pts);
      let b;
      do b = pick(pts); while (b === a);
      const spec = { from: a.id, to: b.id, length: 500 + Math.floor(rnd() * 2000), maxSpeed: (25 + rnd() * 35) * 0.44704, priority: Math.floor(rnd() * 4) };
      if (b.kind === 'yard' && rnd() < 0.4) {
        let c;
        do c = pick(pts); while (c === b);
        spec.then = { to: c.id, dwell: 600 + Math.floor(rnd() * 1800) };
      }
      d.addTrain(spec);
    }
    const undo = [];
    let res = 'timeout';
    let s;
    for (s = 0; s < 30 * 3600; s++) {
      if (s % 600 === 300) {
        const r = rnd();
        const running = Object.values(d.state.trains).filter((t) => t.status === 'running');
        if (r < 0.3 && running.length) { const t = pick(running); d.hold(t.id); undo.push([s + 300, () => d.release(t.id)]); }
        else if (r < 0.55) { const m = pick(mains); d.slowOrder(m.id, 10 + 5 * Math.floor(rnd() * 3)); undo.push([s + 1800, () => d.slowOrder(m.id, null)]); }
        else if (r < 0.75) { const m = pick(mains); d.setOutOfService(m.id); undo.push([s + 1200, () => d.setOutOfService(m.id, false)]); }
      }
      for (const u of undo) if (u[0] === s) u[1]();
      d.tick(1);
      for (const t of Object.values(d.state.trains)) if (t.inYard && t.status === 'arrived' && d.state.time - t.arrivedAt > 1200) d.breakUp(t.id);
      if (s % 30 === 0) { const e = d.checkInvariants(); if (e.length) { res = `invariant: ${e[0]}`; break; } }
      if (Object.values(d.state.trains).every((t) => t.status === 'arrived' || t.status === 'noroute')) { res = 'done'; break; }
    }
    const stuck = res === 'done' ? [] : Object.values(d.state.trains).filter((t) => t.status !== 'arrived').map((t) => `${t.id}: ${t.wait?.reason || t.status}`);
    const reversals = Object.values(d.state.trains).reduce((a, t) => a + (t.reversals || 0), 0);
    results.push({ trial, result: res, hours: +(s / 3600).toFixed(1), reversals, stuck });
    log(`trial ${trial}: ${res} after ${(s / 3600).toFixed(1)} h, ${reversals} reversal(s)${stuck.length ? `\n  ${stuck.join('\n  ')}` : ''}`);
  }
  return results;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [file, seed = '1', trials = '6', trains = '14'] = process.argv.slice(2);
  if (!file) { console.error('usage: node tools/chaos.js <railnet.json> [seed] [trials] [trains]'); process.exit(1); }
  const { network } = JSON.parse(readFileSync(file, 'utf8'));
  const r = chaos(network, { seed: +seed, trials: +trials, trains: +trains });
  const failed = r.filter((x) => x.result !== 'done').length;
  console.log(`${r.length - failed}/${r.length} trials finished cleanly`);
  process.exit(failed ? 1 : 0);
}
