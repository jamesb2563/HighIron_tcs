// Raw track graph -> TCS network.
//
// Vocabulary (mirrors how railroads talk about CTC territory):
//   control point (CP)  a node where track topology changes: switch, track end, or a
//                       change in number of tracks.
//   interlocking        a cluster of CPs close together (e.g. both ends of a crossover).
//                       Trains pass through an interlocking one at a time.
//   section             the track between two CPs. Has 1+ lanes (lanes > 1 only when
//                       OSM maps multiple tracks on one way with tracks=N).
//   passing group       all sections between the same pair of interlockings. If the
//                       group has 2+ lanes in total (passing siding, double track) trains
//                       can meet or pass there.
//   block               automatic signal block inside a section; following trains are
//                       spaced one block apart.
//
// The network is a plain JSON-serialisable object so it can be cached in localStorage.

import { bearing, angleDiff, pointAlong, haversine } from './geo.js';

export const DEFAULT_NETWORK_OPTIONS = {
  interlockingRadius: 250, // m: CPs joined by a section this short become one interlocking
  turnLimitDeg: 70, // max deviation from straight a train can take through a node
  signalDecel: 0.15, // m/s^2 used for block length sizing (freight-ish)
  blockFactor: 1.2, // block = braking distance * factor
  blockMin: 800,
  blockMax: 4000,
  collapseYards: true, // yard tracks become one interlocking per yard, entered via its leads
  minComponentLength: 500, // m: disconnected pieces smaller than this are dropped as fragments
  junctionNameRadius: 600, // m: how far a railway=junction label can be from its control point
  yardNameRadius: 1500,
  minStandingTrack: 150, // m: shortest piece of yard track counted as somewhere cars can stand
  carLength: 18.3, // m per car including couplers (about 60 ft), for yard capacity in cars
};

/** Value covering the most length among edges. */
function dominant(es, get) {
  const m = new Map();
  for (const e of es) { const v = get(e); if (v) m.set(v, (m.get(v) || 0) + e.length); }
  let best = null;
  for (const [v, l] of m) if (!best || l > best[1]) best = [v, l];
  return best ? best[0] : null;
}

export function buildNetwork(raw, options = {}) {
  const opts = { ...DEFAULT_NETWORK_OPTIONS, ...options };
  const { nodes, edges } = raw;
  const warnings = [...(raw.warnings || [])];

  const otherEnd = (e, n) => (e.a === n ? e.b : e.a);
  /** Polyline of an edge oriented to start at node n. */
  const orientedCoords = (e, n) => (e.a === n ? e.coords : [...e.coords].reverse());
  const outBearing = (e, n) => {
    const c = orientedCoords(e, n);
    return bearing(c[0], pointAlong(c, Math.min(25, e.length / 2)));
  };
  /** Can a train arriving at node n on edge e1 continue onto edge e2? */
  const deviation = (n, e1, e2) => 180 - angleDiff(outBearing(edges.get(e1), n), outBearing(edges.get(e2), n));
  const canPass = (n, e1, e2) => e1 !== e2 && deviation(n, e1, e2) <= opts.turnLimitDeg;

  // --- 1. Control points -------------------------------------------------------
  const isCP = new Set();
  for (const n of nodes.values()) {
    if (n.edges.length !== 2) { isCP.add(n.id); continue; }
    const [e1, e2] = n.edges.map((id) => edges.get(id));
    if (e1.lanes !== e2.lanes || e1.kind !== e2.kind) isCP.add(n.id);
  }

  // --- 2. Sections: walk CP to CP through plain degree-2 nodes -------------------
  const sections = {};
  const edgeToSection = new Map();
  let secSeq = 0;
  for (const startId of isCP) {
    for (const firstEdge of nodes.get(startId).edges) {
      if (edgeToSection.has(firstEdge)) continue;
      const edgeIds = [];
      let coords = [];
      let cur = startId;
      let eid = firstEdge;
      for (;;) {
        const e = edges.get(eid);
        edgeIds.push(eid);
        const c = orientedCoords(e, cur);
        coords = coords.length ? coords.concat(c.slice(1)) : c.slice();
        cur = otherEnd(e, cur);
        if (isCP.has(cur)) break;
        const next = nodes.get(cur).edges.find((x) => x !== eid);
        if (!next || edgeIds.includes(next)) break;
        eid = next;
      }
      const es = edgeIds.map((id) => edges.get(id));
      const id = `s${secSeq++}`;
      sections[id] = {
        id,
        a: startId,
        b: cur,
        edges: edgeIds,
        coords,
        length: es.reduce((s, e) => s + e.length, 0),
        kind: es[0].kind,
        lanes: Math.min(...es.map((e) => e.lanes)),
        speed: Math.min(...es.map((e) => e.speed)),
        name: es.find((e) => e.tags.name)?.tags.name || null,
        line: dominant(es, (e) => e.tags.line),
        operator: dominant(es, (e) => e.tags.operator),
        internal: false,
      };
      for (const x of edgeIds) edgeToSection.set(x, id);
    }
  }

  // --- 2b. Drop small disconnected fragments ------------------------------------------
  const report = { components: [], droppedFragments: [], gaps: raw.gaps || [] };
  {
    const cp = new Map();
    const f = (x) => (cp.get(x) === x ? x : (cp.set(x, f(cp.get(x))), cp.get(x)));
    for (const s of Object.values(sections)) { if (!cp.has(s.a)) cp.set(s.a, s.a); if (!cp.has(s.b)) cp.set(s.b, s.b); cp.set(f(s.a), f(s.b)); }
    const comp = new Map();
    for (const s of Object.values(sections)) {
      const r = f(s.a);
      if (!comp.has(r)) comp.set(r, { sections: [], length: 0 });
      comp.get(r).sections.push(s.id);
      comp.get(r).length += s.length;
    }
    for (const c of comp.values()) {
      if (c.length < opts.minComponentLength) {
        const s0 = sections[c.sections[0]];
        report.droppedFragments.push({ sections: c.sections.length, length: Math.round(c.length), lat: s0.coords[0][0], lon: s0.coords[0][1] });
        for (const id of c.sections) { for (const e of sections[id].edges) edgeToSection.delete(e); delete sections[id]; }
      } else {
        report.components.push({ sections: c.sections.length, km: +(c.length / 1000).toFixed(1) });
      }
    }
    report.components.sort((a, b) => b.km - a.km);
    for (const id of [...isCP]) if (!Object.values(sections).some((s) => s.a === id || s.b === id)) isCP.delete(id);
  }

  // --- 3. Facilities: which track belongs to a yard, terminal or works ----------------
  // Track tagged service=yard always does. So does any non-main track inside a mapped
  // facility area (yard, works, terminal), whatever its tags: Baldwin's tracks are tagged
  // as sidings, for example. Unnamed plain landuse=railway areas often just outline a
  // main-line corridor, or a station or junction area, so a plain landuse=railway area
  // only counts if it holds at least 1 km of service=yard track.
  const features = raw.features || { yards: [], junctions: [], stations: [], industries: [] };
  const inPoly = (p, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i]; const [yj, xj] = poly[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inArea = (p, f) => f.rings && f.rings.some((r) => inPoly(p, r));
  const mid = (s) => s.coords[Math.floor(s.coords.length / 2)];
  const areas = features.yards.filter((f) => f.rings);
  for (const f of areas) {
    const yardTrack = Object.values(sections).filter((s) => s.kind === 'yard' && inArea(mid(s), f)).reduce((n, s) => n + s.length, 0);
    f.eligible = f.type !== 'yard' || f.explicit || yardTrack >= 1000;
  }
  const facilityAreas = areas.filter((f) => f.eligible).sort((x, y) => x.areaKm2 - y.areaKm2); // smallest first
  const areaOf = (p) => facilityAreas.find((f) => inArea(p, f)) || null;
  for (const s of Object.values(sections)) {
    if (s.kind === 'main') continue;
    const f = areaOf(mid(s));
    if (f) s.facility = f.id;
    s.yardLike = s.kind === 'yard' || !!f;
  }

  // --- 3a. Interlockings: union-find over CPs joined by short or crossover sections ---
  // Facility track is folded into one interlocking per facility, except the leads that
  // touch other track, which stay as ordinary sections so main-line switches stay
  // separate.
  const parent = new Map([...isCP].map((id) => [id, id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const nonYardAt = new Set();
  for (const s of Object.values(sections)) if (!s.yardLike) { nonYardAt.add(s.a); nonYardAt.add(s.b); }
  for (const s of Object.values(sections)) {
    if (s.a === s.b) continue;
    const yardInterior = opts.collapseYards && s.yardLike && !nonYardAt.has(s.a) && !nonYardAt.has(s.b);
    const shortTrack = s.length <= opts.interlockingRadius && (s.kind === 'main' || s.kind === 'siding') && !s.yardLike;
    if (s.kind === 'crossover' || shortTrack || yardInterior) {
      s.internal = true;
      if (yardInterior) s.yardInterior = true;
      parent.set(find(s.a), find(s.b));
    }
  }
  // Clusters inside the same facility area are the same facility.
  {
    const firstIn = new Map();
    for (const s of Object.values(sections)) {
      if (!s.yardInterior || !s.facility) continue;
      if (!firstIn.has(s.facility)) firstIn.set(s.facility, s.a);
      else parent.set(find(s.a), find(firstIn.get(s.facility)));
    }
  }
  const interlockings = {};
  const nodeToIL = {};
  let ilSeq = 0;
  const rootToIL = new Map();
  for (const id of isCP) {
    const root = find(id);
    if (!rootToIL.has(root)) {
      const ilId = `I${ilSeq++}`;
      rootToIL.set(root, ilId);
      interlockings[ilId] = { id: ilId, nodes: [], lat: 0, lon: 0, kind: 'cp', name: null };
    }
    const il = interlockings[rootToIL.get(root)];
    il.nodes.push(id);
    nodeToIL[id] = il.id;
  }
  for (const il of Object.values(interlockings)) {
    const ns = il.nodes.map((id) => nodes.get(id));
    il.lat = ns.reduce((s, n) => s + n.lat, 0) / ns.length;
    il.lon = ns.reduce((s, n) => s + n.lon, 0) / ns.length;
    const isIndustry = (n) => String(n.tags.railway || '').split(';').includes('spur_junction');
    il.name = ns.filter((n) => !isIndustry(n)).map((n) => n.tags.name || n.tags['railway:ref'] || n.tags.ref).find(Boolean) || null;
    const inds = ns.filter(isIndustry).map((n) => n.tags.name).filter(Boolean);
    if (inds.length) il.industries = [...new Set(inds)];
    if (ns.some((n) => n.tags.railway === 'railway_crossing')) il.diamond = true;
  }
  for (const s of Object.values(sections)) if (s.yardInterior) interlockings[nodeToIL[s.a]].kind = 'yard';

  // --- 3b. Name yards, then merge yard clusters that are the same yard -------------
  const nearestFeature = (list, p, radius) => {
    let best = null;
    for (const f of list) { const d = haversine(p, [f.lat, f.lon]); if (d <= radius && (!best || d < best.d)) best = { f, d }; }
    return best?.f || null;
  };
  for (const il of Object.values(interlockings)) {
    if (il.kind !== 'yard') continue;
    const pts = il.nodes.map((id) => nodes.get(id)).map((n) => [n.lat, n.lon]);
    const inside = facilityAreas.filter((f) => pts.some((p) => inArea(p, f)));
    il.areas = inside.map((f) => f.id);
    if (inside.some((f) => f.type === 'works')) il.works = true;
    if (inside.some((f) => f.type === 'terminal')) il.terminal = true;
    // A yard's own name (from its area or the nearest yard label) beats a switch name.
    const named = inside.find((f) => f.name) ||
      nearestFeature(features.yards.filter((y) => y.name && (!y.rings || y.eligible)), [il.lat, il.lon], opts.yardNameRadius);
    if (named) { il.name = named.name || `${named.operator} yard`; if (named.operator) il.operator = named.operator; }
    else if (il.name) continue;
    else if (inside.length) { const f = inside[0]; il.name = f.operator ? `${f.operator} ${f.type}` : f.type === 'works' ? 'Railroad works' : null; }
  }
  {
    const byName = new Map();
    for (const il of Object.values(interlockings)) {
      if (il.kind !== 'yard' || !il.name) continue;
      const keep = (byName.get(il.name) || []).find((k) => haversine([k.lat, k.lon], [il.lat, il.lon]) < 3000);
      if (!keep) { byName.set(il.name, [...(byName.get(il.name) || []), il]); continue; }
      for (const n of il.nodes) { keep.nodes.push(n); nodeToIL[n] = keep.id; }
      keep.areas = [...new Set([...(keep.areas || []), ...(il.areas || [])])];
      keep.works ||= il.works;
      keep.terminal ||= il.terminal;
      delete interlockings[il.id];
    }
    for (const list of byName.values()) for (const il of list) {
      const ns = il.nodes.map((id) => nodes.get(id));
      il.lat = ns.reduce((a, n) => a + n.lat, 0) / ns.length;
      il.lon = ns.reduce((a, n) => a + n.lon, 0) / ns.length;
    }
  }
  let yardNum = 1;
  for (const il of Object.values(interlockings)) if (il.kind === 'yard' && !il.name) il.name = `Yard ${yardNum++}`;
  // Non-main track with both ends inside the same yard is yard trackage too.
  for (const s of Object.values(sections)) {
    if (s.internal || s.a === s.b || s.kind === 'main') continue;
    const ia = nodeToIL[s.a];
    if (ia === nodeToIL[s.b] && interlockings[ia].kind === 'yard') { s.internal = true; s.yardInterior = true; }
  }

  // --- 3c. Yard size and capacity -----------------------------------------------------
  // Measured from the track folded into each yard. "Standing" track is any piece of yard
  // track long enough to hold cars (opts.minStandingTrack); car capacity is standing
  // length / opts.carLength. Track split by a crossover counts as two pieces, so the
  // piece count overstates the number of tracks, but the lengths are right.
  {
    const areaById = Object.fromEntries(areas.map((f) => [f.id, f]));
    const stats = {};
    for (const s of Object.values(sections)) {
      if (!s.yardInterior) continue;
      const il = nodeToIL[s.a];
      const st = (stats[il] ||= { trackLength: 0, standingTracks: 0, standingLength: 0, longestTrack: 0 });
      st.trackLength += s.length;
      if (s.length >= opts.minStandingTrack) { st.standingTracks++; st.standingLength += s.length; }
      st.longestTrack = Math.max(st.longestTrack, s.length);
    }
    for (const il of Object.values(interlockings)) {
      if (il.kind !== 'yard') continue;
      const st = stats[il.id] || { trackLength: 0, standingTracks: 0, standingLength: 0, longestTrack: 0 };
      il.capacity = {
        trackLength: Math.round(st.trackLength),
        standingTracks: st.standingTracks,
        standingLength: Math.round(st.standingLength),
        longestTrack: Math.round(st.longestTrack),
        cars: Math.floor(st.standingLength / opts.carLength),
        areaKm2: il.areas?.length ? +il.areas.reduce((a, id) => a + (areaById[id]?.areaKm2 || 0), 0).toFixed(2) : null,
      };
    }
  }

  const external = Object.values(sections).filter((s) => !s.internal && s.a !== s.b);
  for (const s of Object.values(sections)) {
    s.ia = nodeToIL[s.a];
    s.ib = nodeToIL[s.b];
    if (!s.internal && s.a === s.b) warnings.push(`section ${s.id} is a loop with no control point, ignored`);
  }
  // External-section degree per interlocking: 1 => track end.
  const ilDegree = {};
  for (const s of external) { ilDegree[s.ia] = (ilDegree[s.ia] || 0) + 1; ilDegree[s.ib] = (ilDegree[s.ib] || 0) + 1; }
  const center = [
    external.reduce((a, s) => a + s.coords[0][0], 0) / Math.max(1, external.length),
    external.reduce((a, s) => a + s.coords[0][1], 0) / Math.max(1, external.length),
  ];
  const compass = (from, to) => ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(bearing(from, to) / 45) % 8];
  for (const il of Object.values(interlockings)) {
    il.degree = ilDegree[il.id] || 0;
    if (il.degree === 1 && il.kind !== 'yard') {
      const s = external.find((x) => x.ia === il.id || x.ib === il.id);
      const endNode = nodes.get(s.ia === il.id ? s.a : s.b);
      const open = endNode.tags.railway !== 'buffer_stop';
      il.kind = open && s.kind === 'main' ? 'portal' : 'end';
      if (il.kind === 'portal') il.name ||= `${s.line || s.operator || 'Main line'} to the ${compass(center, [il.lat, il.lon])}`;
    }
  }
  // Junction labels go to the nearest control point that is actually a junction.
  for (const j of features.junctions) {
    if (!j.name) continue;
    let best = null;
    for (const il of Object.values(interlockings)) {
      if (il.kind !== 'cp' || il.name) continue;
      const d = haversine([j.lat, j.lon], [il.lat, il.lon]);
      if (d <= opts.junctionNameRadius && (!best || d < best.d)) best = { il, d };
    }
    if (best) best.il.name = j.name;
  }
  let cpNum = 1;
  for (const il of Object.values(interlockings)) {
    if (!il.name) il.name = il.kind === 'end' ? `End of track ${il.id}` : `CP ${cpNum++}`;
  }

  // --- 4. Transitions: which section ends connect through each interlocking ---------
  // transitions["s3:b"] = [{ sec: "s7", side: "a" }, ...]   (leave s3 at its b end, enter s7 at its a end)
  const sideAt = (sec, node, edgeId) => (sec.a === node && sec.edges[0] === edgeId ? 'a' : 'b');
  const transitions = {};
  for (const s of external) {
    for (const side of ['a', 'b']) {
      const node = side === 'a' ? s.a : s.b;
      const edgeIn = side === 'a' ? s.edges[0] : s.edges[s.edges.length - 1];
      // Each route through the interlocking is "diverging" if at any switch it takes a
      // leg other than the straightest one available (used for turnout speed limits).
      const found = new Map();
      const seen = new Set();
      const queue = [[node, edgeIn, false, 0]];
      while (queue.length) {
        const [n, via, div0, deg0] = queue.shift();
        const options = nodes.get(n).edges.filter((e) => canPass(n, via, e)).map((e) => ({ e, dev: deviation(n, via, e) }));
        const straightest = Math.min(...options.map((o) => o.dev));
        for (const { e, dev } of options) {
          const sec = sections[edgeToSection.get(e)];
          if (!sec) continue;
          const turned = options.length > 1 && dev > straightest + 1.5;
          const div = div0 || turned;
          const deg = turned ? Math.max(deg0, dev) : deg0;
          const entry = sideAt(sec, n, e);
          if (!sec.internal) {
            if (sec.id === s.id && entry === side) continue;
            const k = `${sec.id}:${entry}`;
            const prev = found.get(k);
            if (!prev || (prev.diverging && !div)) found.set(k, { sec: sec.id, side: entry, ...(div ? { diverging: true, turnoutDeg: Math.round(deg) } : {}) });
            continue;
          }
          const xo = sec.kind === 'crossover';
          if (seen.has(`${sec.id}:${entry}`)) continue;
          seen.add(`${sec.id}:${entry}`);
          queue.push(entry === 'a' ? [sec.b, sec.edges[sec.edges.length - 1], div || xo, deg] : [sec.a, sec.edges[0], div || xo, deg]);
        }
      }
      transitions[`${s.id}:${side}`] = [...found.values()];
    }
  }

  // --- 5. Passing groups ----------------------------------------------------------
  const groups = {};
  for (const s of external) {
    const key = [s.ia, s.ib].sort().join('|');
    if (!groups[key]) groups[key] = { id: key, sections: [], lanes: 0, passable: false };
    groups[key].sections.push(s.id);
    groups[key].lanes += s.lanes;
    s.group = key;
  }
  for (const g of Object.values(groups)) g.passable = g.lanes >= 2;

  // --- 5b. Chains and passing corridors --------------------------------------------
  // Section-pair groups only see double track when both tracks run between the same two
  // control points. On real data the tracks are often split differently: one has extra
  // switches for industry spurs, or crossovers are staggered. So, ignoring industry
  // spurs, sections are joined into chains through control points that only continue
  // the track, and chains between the same two anchors form a corridor. A corridor with
  // two or more lanes is somewhere trains can meet or pass, however it's switched.
  const { chains, corridors } = buildChains(external, interlockings);
  for (const c of Object.values(chains)) c.sections.forEach((x, i) => { sections[x.sec].chain = c.id; sections[x.sec].chainIndex = i; });

  // --- 6. Blocks ---------------------------------------------------------------------
  for (const s of external) {
    let n = 1;
    if (s.kind === 'main') {
      const braking = (s.speed * s.speed) / (2 * opts.signalDecel);
      const target = Math.min(opts.blockMax, Math.max(opts.blockMin, braking * opts.blockFactor));
      n = Math.max(1, Math.round(s.length / target));
    }
    s.blockCount = n;
    s.blockLength = s.length / n;
  }

  // Strip internal sections' heavy fields we don't need, keep them for drawing.
  const bySecIL = {};
  for (const s of external) {
    (bySecIL[s.ia] ||= []).push({ sec: s.id, side: 'a' });
    (bySecIL[s.ib] ||= []).push({ sec: s.id, side: 'b' });
  }
  for (const il of Object.values(interlockings)) {
    il.sectionEnds = bySecIL[il.id] || [];
    if (il.capacity) il.capacity.leads = il.sectionEnds.length;
  }

  const ilList = Object.values(interlockings);
  report.portals = ilList.filter((i) => i.kind === 'portal').map((i) => i.name);
  report.yards = ilList.filter((i) => i.kind === 'yard').map((i) => i.name);
  report.suspectGaps = report.gaps.filter((g) => !g.snapped).length;

  return {
    version: 2,
    options: opts,
    interlockings,
    sections,
    transitions,
    groups,
    chains,
    corridors,
    features: {
      stations: features.stations.map(({ name, operator, lat, lon }) => ({ name, operator, lat, lon })),
      facilities: facilityAreas.map(({ id, name, operator, type, rings, areaKm2 }) => ({ id, name, operator, type, rings, areaKm2 })),
    },
    report,
    warnings,
  };
}

/** Sections trains can route over (internal crossover/ladder pieces excluded). */
export const externalSections = (net) => Object.values(net.sections).filter((s) => !s.internal && s.a !== s.b);

/**
 * Chains: maximal runs of sections joined at control points that only continue the
 * track once industry spurs are ignored. Corridors: chains between the same two anchors.
 */
function buildChains(external, interlockings) {
  const at = {};
  for (const s of external) { (at[s.ia] ||= new Set()).add(s.id); (at[s.ib] ||= new Set()).add(s.id); }
  const byId = Object.fromEntries(external.map((s) => [s.id, s]));
  const otherIL = (s, il) => (s.ia === il ? s.ib : s.ia);

  // Industry spurs: non-main dead ends (repeatedly), unless they lead to a yard or portal.
  const spur = new Set();
  const live = (il) => [...(at[il] || [])].filter((id) => !spur.has(id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const il of Object.values(interlockings)) {
      if (il.kind === 'yard' || il.kind === 'portal') continue;
      const l = live(il.id);
      if (l.length !== 1) continue;
      const s = byId[l[0]];
      if (s.kind === 'main' || s.ia === s.ib) continue;
      spur.add(s.id);
      changed = true;
    }
  }
  const isAnchor = (il) => {
    const k = interlockings[il].kind;
    if (k !== 'cp' || interlockings[il].diamond) return true;
    const l = live(il);
    return l.length !== 2 || l.some((id) => byId[id].ia === byId[id].ib);
  };

  const chains = {};
  const inChain = new Set();
  let seq = 0;
  const addChain = (a, list) => {
    const id = `c${seq++}`;
    let il = a;
    const secs = [];
    for (const sid of list) {
      const s = byId[sid];
      const dir = s.ia === il ? 1 : -1;
      secs.push({ sec: sid, dir });
      il = otherIL(s, il);
      inChain.add(sid);
    }
    const ss = list.map((x) => byId[x]);
    chains[id] = {
      id,
      a,
      b: il,
      sections: secs,
      length: ss.reduce((n, s) => n + s.length, 0),
      lanes: ss.length === 1 ? ss[0].lanes : Math.min(...ss.map((s) => s.lanes)),
      spur: list.length === 1 && spur.has(list[0]),
    };
  };
  for (const il of Object.keys(at)) {
    if (!isAnchor(il)) continue;
    for (const first of live(il)) {
      if (inChain.has(first)) continue;
      const list = [first];
      let cur = otherIL(byId[first], il);
      let prev = first;
      while (!isAnchor(cur) && cur !== il) {
        const next = live(cur).find((x) => x !== prev);
        if (!next || inChain.has(next) || list.includes(next)) break;
        list.push(next);
        prev = next;
        cur = otherIL(byId[next], cur);
      }
      addChain(il, list);
    }
  }
  // Spurs and anything left over (rings without anchors) are one-section chains.
  for (const s of external) if (!inChain.has(s.id)) addChain(s.ia, [s.id]);

  const corridors = {};
  for (const c of Object.values(chains)) {
    const key = c.a === c.b ? `${c.a}|${c.id}` : [c.a, c.b].sort().join('|');
    if (!corridors[key]) corridors[key] = { id: key, chains: [], lanes: 0, passable: false };
    corridors[key].chains.push(c.id);
    corridors[key].lanes += c.lanes;
    c.corridor = key;
  }
  for (const k of Object.values(corridors)) k.passable = k.lanes >= 2;

  // Bypass: is there another way between a chain's two ends, not much longer than the
  // chain itself? That's what makes it somewhere an opposing train can get past — a
  // passing siding, either track of double track, however the switches fall.
  const running = (c) => c.sections.every((x) => byId[x.sec].kind === 'main' || byId[x.sec].kind === 'siding');
  for (const c of Object.values(chains)) c.running = running(c);
  const adj = {};
  for (const c of Object.values(chains)) {
    if (c.spur || c.a === c.b || !c.running) continue;
    if (interlockings[c.a].kind === 'yard' || interlockings[c.b].kind === 'yard') continue;
    (adj[c.a] ||= []).push(c);
    (adj[c.b] ||= []).push(c);
  }
  for (const c of Object.values(chains)) {
    c.bypass = false;
    if (!c.running) continue;
    if (c.lanes >= 2) { c.bypass = true; continue; }
    if (c.spur || c.a === c.b) continue;
    const limit = c.length * BYPASS_FACTOR + BYPASS_SLACK;
    const dist = new Map([[c.a, 0]]);
    const open = [[0, c.a]];
    while (open.length) {
      open.sort((x, y) => x[0] - y[0]);
      const [d, il] = open.shift();
      if (il === c.b) { c.bypass = true; break; }
      if (d > dist.get(il)) continue;
      for (const o of adj[il] || []) {
        if (o === c) continue;
        const nx = o.a === il ? o.b : o.a;
        const nd = d + o.length;
        if (nd <= limit && (!dist.has(nx) || nd < dist.get(nx))) { dist.set(nx, nd); open.push([nd, nx]); }
      }
    }
    if (c.bypass) corridors[c.corridor].passable = true;
  }
  return { chains, corridors };
}

const BYPASS_FACTOR = 1.5;
const BYPASS_SLACK = 2000; // m
