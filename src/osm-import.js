// Overpass JSON -> raw track graph.
//
// Accepts either Overpass output style:
//   * "out body; >; out skel qt;" / "node(w); out body;"  (nodes as separate elements)
//   * "out geom;"                                        (way.geometry inline)
//
// Output graph:
//   nodes: Map<nodeId, { id, lat, lon, tags, edges: edgeId[] }>   (junction nodes only)
//   edges: Map<edgeId, { id, wayId, a, b, coords, length, kind, lanes, speed, tags }>
// An edge is a piece of an OSM way between two junction nodes (switches, way ends,
// or nodes shared with another way).

import { polylineLength, bearing, angleDiff, pointAlong, haversine } from './geo.js';

export const DEFAULT_IMPORT_OPTIONS = {
  railwayTypes: ['rail'], // add 'light_rail', 'narrow_gauge' etc. if wanted
  excludeService: [], // e.g. ['yard'] to drop yard trackage entirely
  // Fallback speeds (m/s) when maxspeed is missing, keyed by edge kind.
  defaultSpeeds: { main: 22.35, siding: 8.94, crossover: 8.94, spur: 4.47, yard: 4.47 },
  // Near-miss repair: a dead-end way endpoint (not a buffer stop) that points at other
  // track within snapRadius metres is joined to it. Gaps up to reportRadius are only
  // reported, because at that distance parallel yard tracks look like gaps too.
  snapRadius: 3,
  reportRadius: 25,
  snapMaxDeviation: 40, // degrees between the dead end's direction and the target track
  // Manual fixes: [[deadEndNodeId, targetNodeId], ...] joins the first onto the second.
  connect: [],
};

const MPH = 0.44704;

/** Parse an OSM maxspeed value to m/s. Bare numbers are km/h per OSM convention. */
export function parseMaxspeed(v) {
  if (!v) return null;
  const s = String(v).split(';')[0].trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(mph|km\/h|kmh|kph|knots)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  if (m[2] === 'mph') return n * MPH;
  if (m[2] === 'knots') return n * 0.514444;
  return n / 3.6;
}

/** Classify an OSM railway way into an edge kind. */
export function classify(tags) {
  switch (tags.service) {
    case 'crossover': return 'crossover';
    case 'siding': return 'siding';
    case 'spur': return 'spur';
    case 'yard': return 'yard';
  }
  if (tags.usage === 'industrial') return 'spur';
  return 'main';
}

const KEEP_TAGS = ['name', 'ref', 'usage', 'service', 'tracks', 'maxspeed', 'operator', 'owner', 'gauge', 'electrified', 'railway:track_ref', 'railway:preferred_direction'];

/**
 * Elements from one Overpass response, an element array, or several responses (e.g. the
 * main export plus a file of extra areas). Duplicates by type and id are dropped.
 */
function mergeElements(json) {
  const lists = Array.isArray(json) && json.length && (json[0].elements || Array.isArray(json[0]))
    ? json.map((j) => (Array.isArray(j) ? j : j.elements || []))
    : [Array.isArray(json) ? json : json.elements || []];
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const el of list) {
    const k = `${el.type}/${el.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(el);
  }
  return out;
}

export function importOverpass(json, options = {}) {
  const opts = { ...DEFAULT_IMPORT_OPTIONS, ...options,
    defaultSpeeds: { ...DEFAULT_IMPORT_OPTIONS.defaultSpeeds, ...(options.defaultSpeeds || {}) } };
  const warnings = [];
  const elements = mergeElements(json);

  const osmNodes = new Map();
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null) osmNodes.set(el.id, el);
  }

  const ways = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags) continue;
    if (!opts.railwayTypes.includes(el.tags.railway)) continue;
    if (el.tags.service && opts.excludeService.includes(el.tags.service)) continue;
    if (!el.nodes || el.nodes.length < 2) continue;
    // "out geom" style: fill coordinates from inline geometry.
    if (el.geometry) {
      el.geometry.forEach((g, i) => {
        const id = el.nodes[i];
        if (g && !osmNodes.has(id)) osmNodes.set(id, { type: 'node', id, lat: g.lat, lon: g.lon });
      });
    }
    ways.push({ ...el, nodes: el.nodes.slice() });
  }

  const gaps = repairGaps(ways, osmNodes, opts, warnings);

  // Subdivision / line names from route=railway relations (smallest relation wins, so a
  // specific subdivision beats a whole-railroad relation).
  const relNames = new Map();
  const rels = elements
    .filter((e) => e.type === 'relation' && e.tags && e.tags.route === 'railway' && e.tags.name)
    .sort((a, b) => a.members.length - b.members.length);
  for (const r of rels) {
    for (const m of r.members) {
      if (m.type === 'way' && !relNames.has(m.ref)) relNames.set(m.ref, { name: r.tags.name, operator: r.tags.operator });
    }
  }

  // Count how many way-positions reference each node. Shared => junction.
  const refCount = new Map();
  for (const w of ways) for (const id of w.nodes) refCount.set(id, (refCount.get(id) || 0) + 1);

  const isJunction = (id, w, i) =>
    i === 0 || i === w.nodes.length - 1 || refCount.get(id) > 1 ||
    (osmNodes.get(id)?.tags?.railway === 'switch');

  const nodes = new Map();
  const edges = new Map();
  let edgeSeq = 0;

  const ensureNode = (id) => {
    if (!nodes.has(id)) {
      const n = osmNodes.get(id);
      nodes.set(id, { id: String(id), lat: n.lat, lon: n.lon, tags: n.tags || {}, edges: [] });
    }
    return nodes.get(id);
  };

  for (const w of ways) {
    const missing = w.nodes.filter((id) => !osmNodes.has(id));
    if (missing.length) {
      warnings.push(`way ${w.id}: ${missing.length} node(s) without coordinates, skipped`);
      continue;
    }
    const kind = classify(w.tags);
    const lanes = kind === 'main' ? Math.max(1, parseInt(w.tags.tracks, 10) || 1) : 1;
    const speed = parseMaxspeed(w.tags.maxspeed) ?? opts.defaultSpeeds[kind] ?? opts.defaultSpeeds.main;
    const tags = {};
    for (const k of KEEP_TAGS) if (w.tags[k] != null) tags[k] = w.tags[k];
    const rel = relNames.get(w.id);
    tags.line = rel?.name || (kind === 'main' ? w.tags.name : null) || null;
    if (!tags.operator && rel?.operator) tags.operator = rel.operator;

    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isJunction(w.nodes[i], w, i)) continue;
      const ids = w.nodes.slice(start, i + 1);
      const coords = ids.map((id) => [osmNodes.get(id).lat, osmNodes.get(id).lon]);
      const length = polylineLength(coords);
      if (length > 0) {
        const id = `e${edgeSeq++}`;
        const a = ensureNode(ids[0]);
        const b = ensureNode(ids[ids.length - 1]);
        edges.set(id, { id, wayId: w.id, a: a.id, b: b.id, coords, length, kind, lanes, speed, tags });
        a.edges.push(id);
        if (b !== a) b.edges.push(id);
      }
      start = i;
    }
  }

  // Re-key nodes by string id for consistency with edge refs.
  const byId = new Map();
  for (const n of nodes.values()) byId.set(n.id, n);
  return { nodes: byId, edges, warnings, gaps, features: collectFeatures(elements) };
}

// ---------------------------------------------------------------- near-miss repair

const toXY = (p, lat0) => [p[1] * 111320 * Math.cos((lat0 * Math.PI) / 180), p[0] * 110540];

/**
 * Find dead-end way endpoints that point at nearby track. Joins those within
 * opts.snapRadius (and any listed in opts.connect); returns all candidates up to
 * opts.reportRadius as { node, lat, lon, distance, deviation, snapped }.
 * Mutates way node lists (and may add synthetic nodes with negative ids).
 */
function repairGaps(ways, osmNodes, opts, warnings) {
  const refCount = new Map();
  for (const w of ways) for (const id of w.nodes) refCount.set(id, (refCount.get(id) || 0) + 1);
  const coord = (id) => { const n = osmNodes.get(id); return n ? [n.lat, n.lon] : null; };
  let synth = -1;
  const gaps = [];

  // Manual joins first.
  for (const [from, to] of opts.connect || []) {
    if (!osmNodes.has(from) || !osmNodes.has(to)) { warnings.push(`connect ${from}->${to}: node not in data`); continue; }
    for (const w of ways) w.nodes = w.nodes.map((id) => (id === from ? to : id));
    gaps.push({ node: from, to, manual: true, snapped: true });
  }

  const ends = [];
  for (const w of ways) {
    for (const idx of [0, w.nodes.length - 1]) {
      const id = w.nodes[idx];
      if (refCount.get(id) !== 1 || osmNodes.get(id)?.tags?.railway === 'buffer_stop') continue;
      if (!coord(id)) continue;
      ends.push({ w, idx, id });
    }
  }
  for (const end of ends) {
    const ids = end.idx === 0 ? end.w.nodes : [...end.w.nodes].reverse();
    const c = ids.map(coord).filter(Boolean);
    if (c.length < 2) continue;
    const inward = bearing(c[0], pointAlong(c, Math.min(30, polylineLength(c) / 2)));
    const outward = (inward + 180) % 360;
    const P = toXY(c[0], c[0][0]);
    let best = null;
    for (const w of ways) {
      if (w === end.w) continue;
      for (let i = 1; i < w.nodes.length; i++) {
        const a = coord(w.nodes[i - 1]);
        const b = coord(w.nodes[i]);
        if (!a || !b) continue;
        const A = toXY(a, c[0][0]);
        const B = toXY(b, c[0][0]);
        const dx = B[0] - A[0];
        const dy = B[1] - A[1];
        const L2 = dx * dx + dy * dy;
        let t = L2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy);
        if (d > opts.reportRadius || d < 0.01 || (best && d >= best.d)) continue;
        const q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        if (angleDiff(bearing(c[0], q), outward) > 35) continue; // target must be ahead
        const seg = bearing(a, b);
        const dev = Math.min(angleDiff(seg, outward), angleDiff((seg + 180) % 360, outward));
        if (dev > opts.snapMaxDeviation) continue;
        best = { d, w, i, t, q, dev };
      }
    }
    if (!best) continue;
    const gap = { node: end.id, lat: c[0][0], lon: c[0][1], distance: +best.d.toFixed(1), deviation: Math.round(best.dev), snapped: false };
    if (best.d <= opts.snapRadius) {
      // Join onto an existing vertex if one is close, else insert a node on the segment.
      const near = [best.w.nodes[best.i - 1], best.w.nodes[best.i]].find((id) => haversine(coord(id), best.q) < 1);
      let target = near;
      if (!target) {
        target = synth--;
        osmNodes.set(target, { type: 'node', id: target, lat: best.q[0], lon: best.q[1], tags: { fixme: 'synthetic join' } });
        best.w.nodes.splice(best.i, 0, target);
      }
      end.w.nodes[end.idx] = target;
      gap.snapped = true;
      gap.to = target;
    }
    gaps.push(gap);
  }
  const snapped = gaps.filter((g) => g.snapped).length;
  if (snapped) warnings.push(`joined ${snapped} near-miss gap(s)`);
  return gaps;
}

// ---------------------------------------------------------------- named features

/**
 * Outer rings of an area: a closed way, or a multipolygon relation whose outer member
 * ways (with "out geom" geometry) are joined end to end into closed rings.
 */
function ringsOf(el) {
  if (el.geometry) {
    const r = el.geometry.filter(Boolean).map((g) => [g.lat, g.lon]);
    return r.length > 2 ? [r] : null;
  }
  if (!el.members) return null;
  const segs = el.members.filter((m) => (m.role === 'outer' || m.role === '') && m.geometry)
    .map((m) => m.geometry.filter(Boolean).map((g) => [g.lat, g.lon]));
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const rings = [];
  while (segs.length) {
    let ring = segs.shift().slice();
    for (let guard = 0; guard < 10000 && key(ring[0]) !== key(ring.at(-1)); guard++) {
      const end = key(ring.at(-1));
      const i = segs.findIndex((x) => key(x[0]) === end || key(x.at(-1)) === end);
      if (i < 0) break; // unclosed: use what we have
      const x = segs.splice(i, 1)[0];
      ring = ring.concat((key(x[0]) === end ? x : x.slice().reverse()).slice(1));
    }
    if (ring.length > 2) rings.push(ring);
  }
  return rings.length ? rings : null;
}

/** Yards, works, junctions and stations, as points or areas, for naming and membership. */
function collectFeatures(elements) {
  const out = { yards: [], junctions: [], stations: [], industries: [] };
  for (const el of elements) {
    const t = el.tags;
    if (!t) continue;
    const isArea = el.type !== 'node';
    let bucket = null;
    let type = null;
    if (t.railway === 'yard' || t.railway === 'container_terminal' || t.landuse === 'railway' ||
        (t.landuse === 'industrial' && t.industrial === 'railway')) {
      bucket = 'yards';
      type = t.works || t.railway === 'workshop' || t.industrial === 'railway' ? 'works'
        : t.railway === 'container_terminal' ? 'terminal' : 'yard';
    } else if (t.railway === 'junction') bucket = 'junctions';
    else if (String(t.railway || '').split(';').includes('spur_junction')) bucket = 'industries';
    else if ((t.railway === 'station' || t.railway === 'halt') && t.train !== 'no') bucket = 'stations';
    if (!bucket) continue;
    // Unnamed points carry nothing useful; unnamed yard and works areas still mark
    // which track belongs to a facility.
    if (!t.name && !t.operator && !(isArea && bucket === 'yards')) continue;
    const f = { id: `${el.type}/${el.id}`, name: t.name || null, operator: t.operator || null };
    if (type) f.type = type;
    if (t.railway === 'yard') f.explicit = true;
    if (!isArea) { f.lat = el.lat; f.lon = el.lon; }
    else {
      const rings = ringsOf(el);
      if (!rings) continue;
      f.rings = rings;
      const all = rings.flat();
      f.lat = all.reduce((a, p) => a + p[0], 0) / all.length;
      f.lon = all.reduce((a, p) => a + p[1], 0) / all.length;
      f.areaKm2 = +rings.reduce((a, r) => a + ringArea(r), 0).toFixed(3);
    }
    out[bucket].push(f);
  }
  return out;
}

/** Area of a [lat, lon] ring in km^2 (local flat projection; fine at yard scale). */
function ringArea(r) {
  const lat0 = (r[0][0] * Math.PI) / 180;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][1] * 111320 * Math.cos(lat0); const yi = r[i][0] * 110540;
    const xj = r[j][1] * 111320 * Math.cos(lat0); const yj = r[j][0] * 110540;
    a += (xj + xi) * (yj - yi);
  }
  return Math.abs(a / 2) / 1e6;
}
