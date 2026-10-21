// Coarse "railnet" built on top of a TCS network: the map / economy layer.
//
//   nodes  junctions (where lines really diverge), yards, portals (track leaving the
//          map), diamonds and stub ends
//   edges  the corridor between two nodes: subdivision name, operator, length, run time,
//          single/double track, passing sidings, and the industries along it
//
// Two things make OSM track hard to coarsen, and this module handles both:
//   * Double track is often mapped as separate ways with crossovers at staggered
//     places, so a naive graph sees a "junction" at every crossover. Here a control
//     point is only a junction if its legs head off in three or more different
//     directions, judged by where each leg is ~800 m out, not by switch angles.
//   * Industry spurs would turn every customer into a node. They are pruned first and
//     credited to the edge or node they hang off.
//
// Every edge keeps the TCS section ids it covers, so a railnet route maps back down to
// dispatchable track.

import { pointAlong, bearing, angleDiff, haversine } from './geo.js';

const MPH = 0.44704;

export const DEFAULT_RAILNET_OPTIONS = {
  // Run-time table: one entry per train top speed, every speedStep mph up to speedMax,
  // or higher if any track in the network is faster.
  speedStep: 5,
  speedMax: 80,
  // Acceleration and braking used for the run-time tables (m/s^2). These match the
  // dispatcher's default train; see the README note about weight-based values.
  accel: 0.15,
  decel: 0.3,
  // Legs leaving a control point run "together" (double track, a siding) if they are
  // still close at both probe distances; otherwise they are different routes.
  probes: [
    [800, 40], // [metres along the leg, max separation in metres]
    [2500, 80],
  ],
  mergeRadius: 250, // m: nodes this close collapse into one (portals of double track, etc.)
};

export function buildRailnet(net, options = {}) {
  const opts = { ...DEFAULT_RAILNET_OPTIONS, ...options };
  const ils = net.interlockings;

  // ---- adjacency over passing groups (parallel tracks between the same pair count once)
  const groupsAt = {};
  const ends = (g) => { const s = net.sections[net.groups[g].sections[0]]; return [s.ia, s.ib]; };
  for (const g of Object.keys(net.groups)) {
    const [a, b] = ends(g);
    (groupsAt[a] ||= new Set()).add(g);
    (groupsAt[b] ||= new Set()).add(g);
  }
  const other = (g, id) => { const [a, b] = ends(g); return a === id ? b : a; };
  const repCache = new Map();
  const rep = (g) => {
    if (!repCache.has(g)) {
      const ms = net.groups[g].sections.map((id) => net.sections[id]);
      repCache.set(g, ms.find((s) => s.kind === 'main') || ms.reduce((x, y) => (y.length > x.length ? y : x)));
    }
    return repCache.get(g);
  };
  const groupLen = (g) => Math.min(...net.groups[g].sections.map((id) => net.sections[id].length));
  const isMainish = (g) => net.groups[g].sections.some((id) => net.sections[id].kind === 'main');

  // ---- 1. prune spurs, crediting the IL they hang off
  const removed = new Set();
  const spurs = {};
  const industries = {};
  for (const il of Object.values(ils)) if (il.industries) industries[il.id] = [...il.industries];
  const live = (id) => [...(groupsAt[id] || [])].filter((g) => !removed.has(g));
  for (let changed = true; changed; ) {
    changed = false;
    for (const il of Object.values(ils)) {
      if (il.kind === 'yard' || il.kind === 'portal') continue;
      const l = live(il.id);
      if (l.length !== 1 || isMainish(l[0])) continue;
      const parent = other(l[0], il.id);
      if (parent === il.id) continue;
      removed.add(l[0]);
      spurs[parent] = (spurs[parent] || 0) + 1 + (spurs[il.id] || 0);
      industries[parent] = [...(industries[parent] || []), ...(industries[il.id] || [])];
      changed = true;
    }
  }

  // ---- 2. leg directions: follow each leg ~probeDistance, staying on the straightest track
  const coordsFrom = (s, id) => (s.ia === id ? s.coords : [...s.coords].reverse());
  const probe = (id, g0, dist) => {
    let at = id;
    let g = g0;
    let left = dist;
    const seen = new Set([g0]);
    for (;;) {
      const s = rep(g);
      const c = coordsFrom(s, at);
      if (s.length >= left || ils[other(g, at)].kind !== 'cp') return pointAlong(c, Math.min(left, s.length));
      left -= s.length;
      const heading = bearing(c[Math.max(0, c.length - 2)], c[c.length - 1]);
      at = other(g, at);
      let best = null;
      for (const n of live(at)) {
        if (seen.has(n)) continue;
        const nc = coordsFrom(rep(n), at);
        const dev = angleDiff(heading, bearing(nc[0], pointAlong(nc, Math.min(50, rep(n).length))));
        if (dev < 45 && (!best || dev < best.dev)) best = { n, dev };
      }
      if (!best) return c[c.length - 1];
      seen.add(best.n);
      g = best.n;
    }
  };
  const bundles = {}; // il -> [[group, ...], ...]
  for (const il of Object.values(ils)) {
    const legs = live(il.id).map((g) => ({ g, p: other(g, il.id) === il.id ? null : opts.probes.map(([d]) => probe(il.id, g, d)) }));
    const together = (p, q) => p && q && opts.probes.every(([, max], i) => haversine(p[i], q[i]) < max);
    const out = [];
    for (const leg of legs) {
      const b = out.find((x) => together(x.p, leg.p));
      if (b) b.groups.push(leg.g); else out.push({ p: leg.p, groups: [leg.g] });
    }
    bundles[il.id] = out.map((x) => x.groups);
  }
  const bundleOf = (id, g) => bundles[id].findIndex((b) => b.includes(g));

  // ---- 3. nodes, then merge near-coincident ones
  // Main-track lanes in a bundle: where this changes (2 -> 1) double track begins or
  // ends, which is also where separately-mapped tracks part ways to different places.
  const lanesIn = (b) => b.reduce((n, g) => n + net.groups[g].sections.reduce((m, id) => m + (net.sections[id].kind === 'main' ? net.sections[id].lanes : 0), 0), 0);
  const isNode = (il) => {
    if (!live(il.id).length) return false;
    if (il.kind !== 'cp' || il.diamond) return true;
    const b = bundles[il.id];
    if (b.length !== 2) return true;
    return Math.min(lanesIn(b[0]), 2) !== Math.min(lanesIn(b[1]), 2);
  };
  const nodeIL = Object.values(ils).filter(isNode);
  const parent = new Map(nodeIL.map((il) => [il.id, il.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (let i = 0; i < nodeIL.length; i++) {
    for (let j = i + 1; j < nodeIL.length; j++) {
      const a = nodeIL[i]; const b = nodeIL[j];
      if ((a.kind === 'yard') !== (b.kind === 'yard')) continue;
      if (a.kind === 'yard' && a.name !== b.name) continue;
      if (haversine([a.lat, a.lon], [b.lat, b.lon]) < opts.mergeRadius) parent.set(find(a.id), find(b.id));
    }
  }
  const kindOf = (il) => (il.kind === 'cp' ? (il.diamond ? 'diamond' : 'junction') : il.kind);
  const rank = { yard: 0, portal: 1, diamond: 2, junction: 3, end: 4 };
  const byRoot = new Map();
  for (const il of nodeIL) {
    const r = find(il.id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(il);
  }
  const nodes = {};
  const ilToNode = {};
  let nseq = 0;
  for (const members of byRoot.values()) {
    const lead = [...members].sort((x, y) => rank[kindOf(x)] - rank[kindOf(y)] || generic(x.name) - generic(y.name))[0];
    const id = `N${nseq++}`;
    nodes[id] = {
      id,
      name: lead.name,
      kind: kindOf(lead),
      lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
      lon: members.reduce((s, m) => s + m.lon, 0) / members.length,
      operator: lead.operator || null,
      ...(lead.capacity ? { capacity: lead.capacity } : {}),
      ...(lead.works ? { works: true } : {}),
      ...(lead.terminal ? { terminal: true } : {}),
      interlockings: members.map((m) => m.id),
      spurs: 0,
      industries: [],
    };
    for (const m of members) ilToNode[m.id] = id;
  }

  // Control points on a parallel track right beside a node belong to that node too, so a
  // corridor flood on the other track of double track stops there instead of running past.
  const nearNode = {};
  for (const il of Object.values(ils)) {
    if (ilToNode[il.id] || !live(il.id).length) continue;
    let best = null;
    for (const n of nodeIL) {
      const d = haversine([il.lat, il.lon], [n.lat, n.lon]);
      if (d < opts.mergeRadius && (!best || d < best.d)) best = { n: ilToNode[n.id], d };
    }
    if (best) nearNode[il.id] = best.n;
  }

  // ---- 4. edges: from each node bundle, flood the corridor to the next node(s)
  const edges = {};
  const seenKeys = new Set();
  let eseq = 0;
  for (const il of nodeIL) {
    bundles[il.id].forEach((bundle, bi) => {
      const dist = new Map();
      const prev = new Map();
      const visitedGroups = new Set();
      const arrivals = []; // [group, il] for every group the flood crossed
      const hits = new Map();
      const startNode = ilToNode[il.id];
      const open = bundle.map((g) => ({ at: other(g, il.id), from: il.id, g, d: groupLen(g) }));
      while (open.length) {
        open.sort((x, y) => x.d - y.d);
        const { at, from, g, d } = open.shift();
        if (!visitedGroups.has(g)) { visitedGroups.add(g); arrivals.push([g, at, from]); }
        if (dist.has(at) && dist.get(at) <= d) continue;
        dist.set(at, d);
        prev.set(at, { from, g });
        const stopAt = ilToNode[at] || nearNode[at];
        if (stopAt === startNode) continue; // back at our own node: not an edge
        if (stopAt) {
          const nid = stopAt;
          if (!hits.has(nid) || hits.get(nid).d > d) hits.set(nid, { il: at, g, d });
          continue;
        }
        const inB = bundleOf(at, g);
        bundles[at].forEach((b, k) => {
          if (k === inB) return;
          for (const ng of b) if (!visitedGroups.has(ng)) open.push({ at: other(ng, at), from: at, g: ng, d: d + groupLen(ng) });
        });
      }
      // Attribute each crossed group to the node(s) it leads to, via the shortest-path tree.
      const below = new Map(); // il -> Set(node ids reachable beneath it in the tree)
      const add = (x, nid) => { for (let y = x, k = 0; y && y !== il.id && k < 10000; y = prev.get(y)?.from, k++) { if (!below.has(y)) below.set(y, new Set()); if (below.get(y).has(nid)) break; below.get(y).add(nid); } };
      for (const [nid, hit] of hits) add(hit.il, nid);
      const leadsTo = (x) => { for (let y = x, k = 0; y && y !== il.id && k < 10000; y = prev.get(y)?.from, k++) if (below.get(y)?.size) return below.get(y); return new Set(); };
      const groupsFor = new Map([...hits.keys()].map((n) => [n, new Set()]));
      for (const [g, at, from] of arrivals) {
        let to = leadsTo(at);
        if (!to.size) to = leadsTo(from);
        for (const n of to) groupsFor.get(n).add(g);
      }
      for (const [nid, hit] of hits) {
        const keyA = `${il.id}:${bi}`;
        const keyB = `${hit.il}:${bundleOf(hit.il, hit.g)}`;
        const key = [keyA, keyB].sort().join('|');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const path = [];
        for (let x = hit.il, guard = 0; guard < 10000; guard++) {
          const p = prev.get(x);
          path.unshift({ g: p.g, from: p.from });
          if (p.from === il.id) break;
          x = p.from;
        }
        const id = `R${eseq++}`;
        const e = describeEdge(net, id, startNode, nid, path, groupsFor.get(nid), rep, groupLen, hit.d);
        for (const x of dist.keys()) {
          if (ilToNode[x] || nearNode[x] || !leadsTo(x).has(nid)) continue;
          e.spurs += spurs[x] || 0;
          e.industries.push(...(industries[x] || []));
        }
        e.industries = [...new Set(e.industries)];
        edges[id] = e;
      }
    });
  }
  mergeParallelEdges(edges);
  for (const [x, nid] of Object.entries(nearNode)) nodes[nid].interlockings.push(x);
  for (const n of Object.values(nodes)) {
    for (const x of n.interlockings) { n.spurs += spurs[x] || 0; n.industries.push(...(industries[x] || [])); }
    n.industries = [...new Set(n.industries)];
  }
  // Run-time tables per train top speed.
  const fastest = Math.max(0, ...Object.values(edges).flatMap((e) => e.profile.map((p) => p[1])));
  const top = Math.max(opts.speedMax, Math.ceil(fastest / opts.speedStep) * opts.speedStep);
  const speedClasses = [];
  for (let v = opts.speedStep; v <= top; v += opts.speedStep) speedClasses.push(v);
  for (const e of Object.values(edges)) {
    e.runTimes = {};
    for (const v of speedClasses) e.runTimes[v] = Math.round(profileTime(e.profile, v, opts));
  }
  return {
    version: 3,
    options: opts,
    timing: { speedClasses, accel: opts.accel, decel: opts.decel, basis: 'stop to stop, lower of train top speed and track speed, constant acceleration and braking' },
    nodes,
    edges,
  };
}

/**
 * Minimum time (s) to run a speed profile [[metres, track mph], ...] with a train whose
 * top speed is trainMph, at constant acceleration and braking. The train never exceeds
 * the lower of its own and the track's speed, brakes in time for slower track ahead,
 * and starts and ends stopped unless told otherwise.
 */
export function profileTime(profile, trainMph, { accel = 0.15, decel = 0.3, startStopped = true, endStopped = true, step = 25 } = {}) {
  const lim = [];
  for (const [len, mph] of profile) {
    const v = Math.min(mph, trainMph) * MPH;
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) lim.push([len / n, v]);
  }
  if (!lim.length) return 0;
  // Speeds at the boundaries between steps.
  const v = new Array(lim.length + 1);
  v[0] = startStopped ? 0 : lim[0][1];
  for (let i = 0; i < lim.length; i++) v[i + 1] = Math.min(lim[i][1], lim[i + 1]?.[1] ?? lim[i][1], Math.sqrt(v[i] ** 2 + 2 * accel * lim[i][0]));
  if (endStopped) v[lim.length] = 0;
  for (let i = lim.length - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * decel * lim[i][0]));
  let t = 0;
  for (let i = 0; i < lim.length; i++) {
    const [dx, cap] = lim[i];
    const a = v[i];
    const b = v[i + 1];
    // Accelerate from a toward cap, cruise, brake to b, within dx.
    const peak = Math.min(cap, Math.sqrt((2 * accel * decel * dx + decel * a * a + accel * b * b) / (accel + decel)));
    const dAcc = (peak * peak - a * a) / (2 * accel);
    const dDec = (peak * peak - b * b) / (2 * decel);
    const cruise = Math.max(0, dx - dAcc - dDec);
    t += (peak - a) / accel + (peak - b) / decel + (peak > 0 ? cruise / peak : 0);
  }
  return t;
}

/**
 * Stop-to-stop time (s) along a railnet route given as node ids, for a train with top
 * speed mph. Passing through intermediate nodes doesn't stop the train, so this is
 * shorter than adding up each line's table entry.
 */
export function routeTime(railnet, nodeIds, mph, opts = {}) {
  const profile = [];
  for (let i = 1; i < nodeIds.length; i++) {
    const a = nodeIds[i - 1];
    const b = nodeIds[i];
    const e = Object.values(railnet.edges)
      .filter((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))
      .sort((x, y) => x.length - y.length)[0];
    if (!e) throw new Error(`no railnet line between ${a} and ${b}`);
    profile.push(...(e.a === a ? e.profile : [...e.profile].reverse()));
  }
  return profileTime(profile, mph, { accel: railnet.timing?.accel, decel: railnet.timing?.decel, ...opts });
}

/**
 * Edges between the same two nodes that run side by side are one corridor: the two
 * tracks of double track found from different control points, or the same corridor
 * found from both ends. Merge them.
 */
function mergeParallelEdges(edges) {
  const mid = (e) => pointAlong(e.coords, polyLen(e.coords) / 2);
  const byPair = new Map();
  for (const e of Object.values(edges)) {
    const k = [e.a, e.b].sort().join('|');
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(e);
  }
  for (const list of byPair.values()) {
    const kept = [];
    for (const e of list) {
      const m = mid(e);
      const twin = kept.find((k) => Math.abs(k.length - e.length) < 0.15 * Math.max(k.length, e.length) + 50 &&
        haversine(k._mid, m) < 80);
      if (!twin) { e._mid = m; e._merged = 1; kept.push(e); continue; }
      const secs = new Set(twin.sections);
      const fresh = e.sections.filter((x) => !secs.has(x));
      twin.sections.push(...fresh);
      if (fresh.length) {
        twin._merged++;
        twin.sidings = Math.max(twin.sidings, e.sidings);
        twin.spurs += e.spurs;
        twin.industries = [...new Set([...twin.industries, ...e.industries])];
        if (twin.tracks === 'single' && e.tracks === 'single') twin.tracks = 'double';
        else if (twin.tracks !== e.tracks) twin.tracks = 'mixed';
      }
      twin.length = Math.min(twin.length, e.length);
      if (e.lineSpeedTime < twin.lineSpeedTime) { twin.lineSpeedTime = e.lineSpeedTime; twin.profile = e.profile; }
      delete edges[e.id];
    }
  }
  for (const e of Object.values(edges)) { delete e._mid; delete e._merged; }
}

const polyLen = (c) => { let l = 0; for (let i = 1; i < c.length; i++) l += haversine(c[i - 1], c[i]); return l; };

const generic = (name) => (!name || /^(CP \d+|End of track)/.test(name) ? 1 : 0);

function describeEdge(net, id, a, b, path, groups, rep, groupLen, length) {
  const coords = [];
  for (const { g, from } of path) {
    const s = rep(g);
    const c = s.ia === from ? s.coords : [...s.coords].reverse();
    coords.push(...(coords.length ? c.slice(1) : c));
  }
  const lineLen = new Map();
  const opLen = new Map();
  let mainLen = 0;
  let sidings = 0;
  let time = 0;
  const sections = [];
  for (const g of groups) {
    const ms = net.groups[g].sections.map((sid) => net.sections[sid]);
    sections.push(...net.groups[g].sections);
    if (ms.some((s) => s.kind === 'siding')) sidings++;
    for (const s of ms) {
      if (s.kind === 'main') mainLen += s.length * s.lanes;
      if (s.line) lineLen.set(s.line, (lineLen.get(s.line) || 0) + s.length);
      if (s.operator) opLen.set(s.operator, (opLen.get(s.operator) || 0) + s.length);
    }
  }
  const profile = [];
  for (const { g } of path) {
    time += groupLen(g) / rep(g).speed;
    const mph = Math.round(rep(g).speed / MPH);
    const len = groupLen(g);
    if (profile.length && profile.at(-1)[1] === mph) profile.at(-1)[0] += len;
    else profile.push([len, mph]);
  }
  for (const p of profile) p[0] = Math.round(p[0]);
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const ratio = length ? mainLen / length : 0;
  return {
    id,
    a,
    b,
    name: top(lineLen),
    operator: top(opLen),
    length: Math.round(length),
    lineSpeedTime: Math.round(time), // s at full track speed, no acceleration (lower bound)
    profile, // [[metres, track mph], ...] along the shortest path, a -> b
    runTimes: null, // filled in below: { mph: seconds stop to stop }
    tracks: ratio >= 1.8 ? 'double' : ratio >= 1.15 ? 'mixed' : 'single',
    sidings,
    spurs: 0,
    industries: [],
    coords,
    sections,
  };
}
