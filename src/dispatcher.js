// Traffic-control dispatcher over a network from buildNetwork().
//
// Safety model (README "Dispatcher rules" has the full list and the reasons):
//   * Direction authority per lane: a lane held a->b or b->a admits only trains going
//     that way. Following trains stack; opposing trains never share a lane.
//   * Runs: a train is granted everything up to the next place it can clear (a single
//     section of a chain it fits on, with a way past for opposing trains) or its
//     destination, all at once.
//   * Followers are never granted past the end of the authority of a train ahead.
//   * Blocks inside a run are taken ahead within braking distance; interlockings are
//     exclusive (yards per lead) and a train only enters one when it can get its whole
//     length clear of it and of every other interlocking on the way.
//
// Also here: dispatcher commands (holds, priorities, waypoints, slow orders, track out
// of service), signal aspects and the speed model (track, turnout, approach), yard
// capacity and onward trips, and reversing moves.
//
// Positions are metres along the train's own path ("path coordinates"); each leg
// records where it starts in that coordinate system.

import { pointAlong, sliceAlong } from './geo.js';
import { externalSections } from './network.js';

export const DEFAULT_TRAIN = {
  length: 1500, // m
  maxSpeed: 26.8, // m/s (60 mph)
  accel: 0.15, // m/s^2
  decel: 0.3, // m/s^2
};

const DEFAULTS = {
  allowReversing: true, // trains may reverse when there's no other way to their destination
  reverseCost: 600, // s added to a route for each reversal (stop, change ends, brake test)
  reverseDwell: 120, // s a train stands before moving off in the other direction
  approachMph: 30, // speed limit after passing an Approach signal
  turnoutMph: [[3, 40], [5, 30], [8, 20], [Infinity, 10]], // diverging speed by turnout angle (deg)
  crossoverMph: 30, // diverging speed through a crossover with no measured angle
  retryInterval: 10, // s between run requests while held
  stopMargin: 15, // m short of authority end where trains aim to stop
  clearGap: 60, // m spacing assumed between trains sharing a clearing lane
  eventLimit: 200,
  yieldLimit: 900, // s a lower-priority train will wait for a higher one before going anyway
};

const MPH = 0.44704;
const laneKey = (sec, lane) => `${sec}/${lane}`;
const blockKey = (sec, lane, i) => `${sec}/${lane}/${i}`;

export class Dispatcher {
  constructor(network, state = null, options = {}) {
    this.net = network;
    this.opts = { ...DEFAULTS, ...options };
    this.sections = network.sections;
    this.ext = new Set(externalSections(network).map((s) => s.id));
    this.state = state || { time: 0, seq: 1, trains: {}, lanes: {}, blocks: {}, locks: {}, events: [] };
    this.state.yards ||= {}; // il -> { trains: { id: length }, inbound: { id: length } }
    this.state.slowOrders ||= {}; // section -> mph
    this.state.outOfService ||= {}; // section -> true
  }

  // ---------------------------------------------------------------- public API

  /** Stage a train at an interlocking (e.g. a track end); it enters when granted a run. */
  addTrain({ id, name, from, to, ...spec }) {
    const tid = id || `T${this.state.seq++}`;
    if (!this.net.interlockings[from]) throw new Error(`unknown origin ${from}`);
    if (!this.net.interlockings[to]) throw new Error(`unknown destination ${to}`);
    this.state.trains[tid] = {
      id: tid,
      name: name || tid,
      ...DEFAULT_TRAIN,
      ...spec,
      from,
      dest: to,
      status: 'staged',
      legs: [], // [{ sec, lane, dir, start, len }]
      head: 0,
      speed: 0,
      authEnd: 0,
      blocks: [], // [{ key, start, end }]
      locks: [], // [{ id, pos }]
      nextRequestAt: 0,
      wait: null,
      priority: spec.priority ?? 0,
      via: spec.via || [], // waypoints: interlocking or section ids, in order
      viaDone: 0,
      then: spec.then || null, // { to, dwell } onward trip after arriving at a yard
    };
    this.log(tid, `staged at ${this.ilName(from)} for ${this.ilName(to)}`);
    return tid;
  }

  removeTrain(id) {
    const t = this.state.trains[id];
    if (!t) return;
    this.releaseAll(t);
    for (const y of Object.values(this.state.yards)) { delete y.trains[id]; delete y.inbound[id]; }
    delete this.state.trains[id];
  }

  /** Advance the simulation by dt seconds. Use dt <= 2 for sensible kinematics. */
  tick(dt) {
    this.state.time += dt;
    // Higher priority first, so it gets first call on track each tick.
    const trains = Object.values(this.state.trains).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const t of trains) {
      if (t.status === 'dwelling' && this.state.time >= t.departAt) this.restage(t);
      if (t.status === 'arrived' || t.status === 'noroute' || t.status === 'dwelling') continue;
      this.extendAuthority(t);
      this.move(t, dt);
      if (t.speed > 0.01) this.state.lastProgress = this.state.time;
      this.releaseBehind(t);
      this.maybeReverse(t);
      this.checkArrival(t);
    }
  }

  // ---------------------------------------------------------------- dispatcher commands
  // Every command is logged, and invalidates cached refusals so held trains re-check.

  touch() { this.state.laneVersion = (this.state.laneVersion || 0) + 1; this.state.lastProgress = this.state.time; }
  train(id) { const t = this.state.trains[id]; if (!t) throw new Error(`unknown train ${id}`); return t; }

  /** Hold a train: it gets no more track and stops at the end of what it has. */
  hold(id) { const t = this.train(id); t.held = true; this.log(id, 'held by dispatcher'); this.touch(); }

  /** Release a held train (also clears any hold-at). */
  release(id) { const t = this.train(id); t.held = false; t.holdAt = null; this.log(id, 'released by dispatcher'); this.touch(); }

  /** Run as far as interlocking il, stop there, and wait to be released. */
  holdAt(id, il) {
    if (!this.net.interlockings[il]) throw new Error(`unknown interlocking ${il}`);
    const t = this.train(id); t.holdAt = il; this.log(id, `to hold at ${this.ilName(il)}`); this.touch();
  }

  /** Higher runs first and is yielded to by lower-priority trains. Default 0. */
  setPriority(id, p) { const t = this.train(id); t.priority = p; this.log(id, `priority ${p}`); this.touch(); }

  /**
   * Route a train via waypoints, in order: interlocking ids (pass through that control
   * point or yard) or section ids (use that track, e.g. a particular siding). Applies to
   * runs not yet granted.
   */
  setRoute(id, via) {
    const t = this.train(id);
    for (const v of via) if (!this.net.interlockings[v] && !this.sections[v]) throw new Error(`unknown waypoint ${v}`);
    t.via = [...via];
    t.viaDone = 0;
    t.plan = null;
    if (!t.legs.length) t.allowReverse = false;
    this.log(id, via.length ? `routed via ${via.map((v) => this.ilName(v) || v).join(', ')}` : 'route cleared');
    this.touch();
  }

  /** Speed restriction on a section (mph), or null to lift it. */
  slowOrder(sec, mph) {
    if (!this.sections[sec]) throw new Error(`unknown section ${sec}`);
    if (mph) this.state.slowOrders[sec] = mph; else delete this.state.slowOrders[sec];
    this.log('dispatcher', mph ? `slow order ${mph} mph on ${sec}` : `slow order lifted on ${sec}`);
    this.touch();
  }

  /**
   * Take a section out of service (or back in). Trains already granted it keep their
   * authority and clear it; nothing new is routed over it.
   */
  setOutOfService(sec, out = true) {
    if (!this.sections[sec]) throw new Error(`unknown section ${sec}`);
    if (out) this.state.outOfService[sec] = true; else delete this.state.outOfService[sec];
    this.log('dispatcher', `${sec} ${out ? 'out of service' : 'back in service'}`);
    this.touch();
  }

  /** Send a train that is standing in a yard on to a new destination. */
  departYard(id, to, { dwell = 0 } = {}) {
    const t = this.train(id);
    if (!this.net.interlockings[to]) throw new Error(`unknown destination ${to}`);
    t.then = { to, dwell };
    if (t.status === 'arrived' && t.inYard) { t.status = 'dwelling'; t.departAt = this.state.time + dwell; }
    this.touch();
  }

  /**
   * A train standing in a yard is broken up (its cars go to other tracks or trains):
   * it stops taking yard space. The train record stays, marked arrived.
   */
  breakUp(id) {
    const t = this.train(id);
    if (t.inYard) { delete this.state.yards[t.inYard]?.trains[id]; this.log(id, `broken up in ${this.ilName(t.inYard)}`); }
    t.inYard = null;
    if (t.status === 'dwelling') t.status = 'arrived';
    t.then = null;
    this.touch();
  }

  /** Yard occupancy for display: lengths standing and inbound against capacity. */
  yardStatus(il) {
    const cap = this.yardCapacity(il);
    const y = this.state.yards[il] || { trains: {}, inbound: {} };
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    return { capacity: cap, standing: sum(y.trains), inbound: sum(y.inbound), trains: Object.keys(y.trains), arriving: Object.keys(y.inbound) };
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.state));
  }

  static fromJSON(network, json, options) {
    return new Dispatcher(network, JSON.parse(JSON.stringify(json)), options);
  }

  /** Polyline from tail to head for drawing. */
  trainGeometry(t) {
    if (!t.legs.length) return [];
    const tail = Math.max(t.head - t.length, t.legs[0].start);
    const out = [];
    for (const leg of t.legs) {
      const s0 = Math.max(tail, leg.start);
      const s1 = Math.min(t.head, leg.start + leg.len);
      if (s1 <= s0) continue;
      const sec = this.sections[leg.sec];
      const toSec = (p) => (leg.dir > 0 ? p - leg.start : leg.len - (p - leg.start));
      const piece = sliceAlong(sec.coords, toSec(s0), toSec(s1));
      if (leg.dir < 0) piece.reverse();
      out.push(...piece);
    }
    return out;
  }

  headPoint(t) {
    const leg = this.legAt(t, t.head);
    if (!leg) return null;
    const sec = this.sections[leg.sec];
    const d = t.head - leg.start;
    return pointAlong(sec.coords, leg.dir > 0 ? d : leg.len - d);
  }

  /** Verify safety invariants. Returns a list of problems (empty = OK). */
  checkInvariants() {
    const errs = [];
    const occ = {}; // laneKey -> [{ train, lo, hi }] in section coordinates
    for (const t of Object.values(this.state.trains)) {
      for (const leg of t.legs) {
        const lk = laneKey(leg.sec, leg.lane);
        const L = this.state.lanes[lk];
        if (!L || L.dir !== leg.dir || !L.holders.includes(t.id)) errs.push(`${t.id} on ${lk} without matching authority`);
        const lo = Math.max(t.head - t.length, leg.start) - leg.start;
        const hi = Math.min(t.head, leg.start + leg.len) - leg.start;
        if (hi <= lo) continue;
        const a = leg.dir > 0 ? lo : leg.len - hi;
        const b = leg.dir > 0 ? hi : leg.len - lo;
        (occ[lk] ||= []).push({ train: t.id, lo: a, hi: b });
      }
    }
    for (const [lk, list] of Object.entries(occ)) {
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (list[i].lo < list[j].hi && list[j].lo < list[i].hi)
            errs.push(`${list[i].train} and ${list[j].train} overlap on ${lk}`);
    }
    for (const [lk, L] of Object.entries(this.state.lanes)) {
      if (L.holders.length && !L.dir) errs.push(`${lk} has holders but no direction`);
    }
    return errs;
  }

  /**
   * Likely deadlock: active trains exist, none is moving, and nothing has moved or been
   * granted for minWait seconds. Returns the stuck trains (empty = fine).
   */
  stalled(minWait = 600) {
    const active = Object.values(this.state.trains).filter((t) => !['arrived', 'noroute', 'dwelling'].includes(t.status) && !t.held && !this.atHold(t));
    if (!active.length) return [];
    if (this.state.time - (this.state.lastProgress ?? 0) < minWait) return [];
    return active;
  }

  // ---------------------------------------------------------------- internals

  ilName(id) {
    const [il, lead] = String(id).split('@');
    const name = this.net.interlockings[il]?.name;
    return name ? (lead ? `${name} (lead ${lead})` : name) : id;
  }

  log(train, msg) {
    const ev = this.state.events;
    ev.push({ t: Math.round(this.state.time), train, msg });
    if (ev.length > this.opts.eventLimit) ev.splice(0, ev.length - this.opts.eventLimit);
  }

  lane(sec, lane) {
    const k = laneKey(sec, lane);
    return (this.state.lanes[k] ||= { dir: 0, holders: [] });
  }

  laneCompatible(sec, lane, dir) {
    const L = this.state.lanes[laneKey(sec, lane)];
    return !L || L.dir === 0 || L.dir === dir;
  }

  pathEnd(t) {
    const last = t.legs[t.legs.length - 1];
    return last ? last.start + last.len : 0;
  }

  legAt(t, pos) {
    for (const leg of t.legs) if (pos >= leg.start && pos <= leg.start + leg.len) return leg;
    return t.legs[t.legs.length - 1] || null;
  }

  exitIL(sec, dir) { const s = this.sections[sec]; return dir > 0 ? s.ib : s.ia; }
  entryIL(sec, dir) { const s = this.sections[sec]; return dir > 0 ? s.ia : s.ib; }

  /** Track speed of a section in m/s, after any slow order. */
  speedOf(sec) {
    const s = this.sections[sec];
    const slow = this.state.slowOrders?.[sec];
    return slow ? Math.min(s.speed, slow * MPH) : s.speed;
  }

  /**
   * Dijkstra over (section, direction, waypoint) states. Returns [{ sec, dir }] or null.
   * Honours the train's waypoints (t.via: interlocking or section ids, in order), track
   * out of service, and, if t.allowReverse, reversing moves: a train may stop on a
   * section it fits on and come back the other way (path then lists that section twice
   * in a row, in opposite directions).
   */
  route(t, banned = new Set(), bannedTr = new Set()) {
    const via = (t.via || []).slice(t.viaDone || 0);
    const oos = this.state.outOfService || {};
    const starts = [];
    const last = t.legs[t.legs.length - 1];
    if (last) {
      const side = last.dir > 0 ? 'b' : 'a';
      for (const tr of this.net.transitions[`${last.sec}:${side}`] || []) starts.push({ sec: tr.sec, dir: tr.side === 'a' ? 1 : -1 });
    } else {
      for (const end of this.net.interlockings[t.from].sectionEnds) starts.push({ sec: end.sec, dir: end.side === 'a' ? 1 : -1 });
    }
    const cost = (sec, dir) => {
      const s = this.sections[sec];
      let c = s.length / this.speedOf(sec);
      let open = 0;
      for (let l = 0; l < s.lanes; l++) if (this.laneCompatible(sec, l, dir)) open++;
      if (!open) c += 1e5; // opposed right now: prefer another track if one exists
      // Prefer the main; use sidings to pass, and spurs or yard leads only when needed.
      if (s.kind === 'siding') c *= 1.5;
      else if (s.kind !== 'main') c *= 4;
      return c;
    };
    const meets = (sec, dir, w) => w < via.length && (via[w] === sec || this.exitIL(sec, dir) === via[w]);
    const advance = (sec, dir, w) => (meets(sec, dir, w) ? advance(sec, dir, w + 1) : w);
    const need = t.length + this.opts.stopMargin + this.opts.clearGap;
    const held = new Set(t.legs.map((l) => l.sec));
    const dist = new Map();
    const prev = new Map();
    const open = new MinHeap();
    const push = (st, d, from) => {
      const k = `${st.sec}:${st.dir}:${st.w}`;
      if (dist.has(k) && dist.get(k) <= d) return;
      dist.set(k, d);
      prev.set(k, from);
      open.push(d, st);
    };
    for (const st of starts) {
      if (banned.has(st.sec) || oos[st.sec]) continue;
      push({ ...st, w: advance(st.sec, st.dir, 0) }, cost(st.sec, st.dir), null);
    }
    while (open.size) {
      const [d, st] = open.pop();
      const k = `${st.sec}:${st.dir}:${st.w}`;
      if (d > dist.get(k)) continue;
      if (st.w === via.length && this.exitIL(st.sec, st.dir) === t.dest) {
        const path = [];
        for (let cur = k; cur; cur = prev.get(cur)) {
          const [sec, dir] = cur.split(':');
          path.unshift({ sec, dir: Number(dir) });
        }
        return path;
      }
      const side = st.dir > 0 ? 'b' : 'a';
      for (const tr of this.net.transitions[`${st.sec}:${side}`] || []) {
        if (banned.has(tr.sec) || oos[tr.sec]) continue;
        if (held.has(tr.sec) || bannedTr.has(`${st.sec}>${tr.sec}`)) continue;
        const dir = tr.side === 'a' ? 1 : -1;
        push({ sec: tr.sec, dir, w: advance(tr.sec, dir, st.w) }, d + cost(tr.sec, dir), k);
      }
      // Reversing move: stop clear on this section and come back the other way.
      const s = this.sections[st.sec];
      // Into a yard, a train can always turn: it pulls in and comes back out.
      const yardTurn = this.net.interlockings[this.exitIL(st.sec, st.dir)]?.kind === 'yard';
      if (t.allowReverse && prev.get(k) !== null && (s.length >= need || yardTurn) && s.kind !== 'crossover') {
        const [pk] = [prev.get(k)];
        const ps = pk && pk.split(':');
        if (!(ps && ps[0] === st.sec)) push({ sec: st.sec, dir: -st.dir, w: st.w }, d + this.opts.reverseCost + cost(st.sec, -st.dir), k);
      }
    }
    return null;
  }

  /**
   * Length available for one more train to stop clear in this lane, travelling dir.
   * Trains stop at block boundaries, so each holder is counted as the whole blocks it
   * would fill when stopped behind the one ahead.
   */
  laneRoom(sec, lane, dir) {
    const s = this.sections[sec];
    const L = this.state.lanes[laneKey(sec, lane)];
    if (!L || !L.holders.length) return s.length;
    if (L.dir !== dir) return 0;
    let blocks = 0;
    for (const id of L.holders) blocks += Math.ceil(((this.state.trains[id]?.length || 0) + this.opts.clearGap) / s.blockLength);
    return Math.max(0, s.blockCount - blocks) * s.blockLength;
  }

  /**
   * Try to grant a run. Returns true if legs were added. If the best route is blocked by
   * opposing authority, the blocking section is banned and the route recomputed (a few
   * times), so a train can still clear on the other track of a passing group.
   */
  requestRun(t) {
    // First request: make sure the destination is reachable at all without reversing,
    // before the train takes any track. Trains that would need a reversing move never
    // leave staging, so they can't end up parked on the main.
    if (!t.legs.length && !t.plan) {
      let full = this.loopFreeRoute(t, new Set());
      if (!full && !t.allowReverse && this.opts.allowReversing) {
        // Only reverse when there's no other way: otherwise trains would reverse to
        // dodge traffic rather than wait for it.
        t.allowReverse = true;
        full = this.loopFreeRoute(t, new Set());
        if (full) this.log(t.id, `route to ${this.ilName(t.dest)} needs a reversing move`);
        else t.allowReverse = false;
      }
      if (!full && Object.keys(this.state.outOfService).length) {
        // Maybe only because of track out of service: wait for it to come back.
        const saved = this.state.outOfService;
        this.state.outOfService = {};
        const without = this.loopFreeRoute(t, new Set());
        this.state.outOfService = saved;
        if (without) {
          this.noteWait(t, 'no route while track is out of service');
          t.allowReverse = false;
          return false;
        }
      }
      if (!full) {
        t.status = 'noroute';
        this.log(t.id, `no route to ${this.ilName(t.dest)}`);
        t.wait = null;
        return false;
      }
      t.plan = full.map((p) => `${p.sec}:${p.dir}`);
    }
    // If the best route is blocked by opposing authority, ban that section and re-route,
    // so a train can clear on the other track of a passing group.
    const banned = new Set();
    let plan = null;
    let path = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      path = this.loopFreeRoute(t, banned);
      if (!path) break;
      plan = this.planRun(t, path);
      if (plan.ok || !plan.opposed) break;
      banned.add(plan.opposed);
    }
    // Fall back to the rest of the known-good plan: it never needs a reversing move,
    // so the train can always wait for it rather than getting stranded.
    if (!plan || (!plan.ok && !path)) {
      const rest = this.remainingPlan(t);
      if (!rest.length && Object.keys(this.state.outOfService).length) {
        this.noteWait(t, 'no route while track is out of service');
        t.status = t.legs.length ? 'holding' : 'staged';
        return false;
      }
      if (!rest.length) {
        // Should not happen: the plan is checked up front. Take the train off the track
        // so it can't block anyone, and say why.
        this.log(t.id, `removed: lost its route to ${this.ilName(t.dest)}`);
        this.releaseAll(t);
        t.status = 'noroute';
        t.wait = null;
        return false;
      }
      path = rest;
      plan = this.planRun(t, rest);
    }
    const { ok, run, reason } = plan;
    if (!ok) {
      if (!t.wait) { t.wait = { since: this.state.time, reason }; this.log(t.id, `held: ${reason}`); }
      else t.wait.reason = reason;
      t.status = t.legs.length ? 'holding' : 'staged';
      return false;
    }
    const yieldTo = this.mustYield(t, run);
    if (yieldTo) {
      const reason = `yielding to ${yieldTo.name}`;
      if (!t.wait) { t.wait = { since: this.state.time, reason }; this.log(t.id, `held: ${reason}`); } else t.wait.reason = reason;
      t.status = t.legs.length ? 'holding' : 'staged';
      return false;
    }
    t.plan = path.map((p) => `${p.sec}:${p.dir}`);
    return this.grant(t, run, plan.endsAt);
  }

  /**
   * A higher-priority train waiting for track that this run would take against it gets
   * to go first. Lower-priority trains only defer for opts.yieldLimit seconds, so a
   * chain of yields can't stall the railroad.
   */
  mustYield(t, run) {
    if (t.wait && this.state.time - t.wait.since > this.opts.yieldLimit) return null;
    const mine = new Map(run.map((r) => [r.sec, r.dir]));
    for (const h of Object.values(this.state.trains)) {
      if (h === t || (h.priority || 0) <= (t.priority || 0) || !h.wait || h.held) continue;
      if (['arrived', 'noroute', 'dwelling'].includes(h.status)) continue;
      for (const p of this.remainingPlan(h).slice(0, 12)) if (mine.has(p.sec) && mine.get(p.sec) !== p.dir) return h;
    }
    return null;
  }

  /**
   * Route that never runs over the same section twice (or null), except a reversing
   * move, which uses one section twice in a row in opposite directions.
   */
  loopFreeRoute(t, banned) {
    const bannedTr = new Set();
    for (let attempt = 0; attempt < 12; attempt++) {
      const path = this.route(t, banned, bannedTr);
      if (!path) return null;
      const seen = new Set(t.legs.map((l) => l.sec));
      let bad = null;
      let mirror = -1; // after a reversal, the train may retrace the track it came in on
      for (let i = 0; i < path.length && !bad; i++) {
        const reversal = i > 0 && path[i - 1].sec === path[i].sec && path[i - 1].dir === -path[i].dir;
        if (reversal) { mirror = i - 2; continue; }
        const retrace = mirror >= 0 && path[mirror].sec === path[i].sec && path[mirror].dir === -path[i].dir;
        if (retrace) { mirror--; continue; }
        mirror = -1;
        if (seen.has(path[i].sec)) bad = `${i ? path[i - 1].sec : t.legs.at(-1)?.sec}>${path[i].sec}`;
        seen.add(path[i].sec);
      }
      if (!bad) return path;
      bannedTr.add(bad);
    }
    return null;
  }

  /** Part of the train's last good route still ahead of its granted legs. */
  remainingPlan(t) {
    if (!t.plan) return [];
    const last = t.legs.at(-1);
    const steps = t.plan.map((k) => { const i = k.lastIndexOf(':'); return { sec: k.slice(0, i), dir: Number(k.slice(i + 1)) }; });
    if (!last) return steps;
    const idx = steps.findIndex((p) => p.sec === last.sec && p.dir === last.dir);
    const rest = idx >= 0 ? steps.slice(idx + 1) : [];
    const oos = this.state.outOfService || {};
    return rest.some((p) => oos[p.sec]) ? [] : rest;
  }

  /**
   * Build (but don't grant) a run along path. The path is walked in units: a whole chain
   * when the path runs its full length (the only place a train can clear), otherwise
   * single sections. The run ends at the first chain where the train fits and an
   * opposing train would still have a way past, or at the destination.
   */
  planRun(t, path) {
    // A run never goes past a reversing move (the train must stop and change ends) or
    // past an interlocking the dispatcher is holding the train at.
    let endsAt = null;
    for (let i = 1; i < path.length; i++) {
      if (path[i].sec === path[i - 1].sec && path[i].dir === -path[i - 1].dir) {
        const into = this.exitIL(path[i - 1].sec, path[i - 1].dir);
        endsAt = this.net.interlockings[into]?.kind === 'yard' ? 'yardturn' : 'reverse';
        path = path.slice(0, i);
        break;
      }
    }
    if (t.holdAt) {
      const i = path.findIndex((p) => this.exitIL(p.sec, p.dir) === t.holdAt);
      if (i >= 0 && i < path.length - 1) { path = path.slice(0, i + 1); endsAt = 'hold'; }
      else if (i === path.length - 1 && !endsAt) endsAt = 'hold';
    }
    const units = [];
    for (let i = 0; i < path.length; ) {
      const s = this.sections[path[i].sec];
      const c = this.net.chains?.[s.chain];
      let n = 1;
      if (c && c.sections.length > 0) {
        const fwd = c.sections[0].sec === path[i].sec && c.sections[0].dir === path[i].dir;
        const rev = c.sections.at(-1).sec === path[i].sec && c.sections.at(-1).dir === -path[i].dir;
        if (fwd || rev) {
          const order = fwd ? c.sections : [...c.sections].reverse().map((x) => ({ sec: x.sec, dir: -x.dir }));
          const matches = order.every((x, k) => path[i + k] && path[i + k].sec === x.sec && path[i + k].dir === x.dir);
          if (matches) { units.push({ legs: path.slice(i, i + order.length), chain: c }); i += order.length; continue; }
        }
      }
      units.push({ legs: path.slice(i, i + n), chain: null });
      i += n;
    }

    const run = [];
    const tentative = new Map(); // laneKey -> dir, for this run
    let ok = false;
    let reason = 'opposing traffic';
    let opposed = null;
    let doubling = false;
    // Same-direction trains ahead of us. We may follow them but never be granted past
    // the end of their authority (a follower can't claim a spot beyond a leader).
    let leaders = [];
    const usedHere = new Set(t.legs.map((l) => l.sec));
    const need = t.length + this.opts.stopMargin + this.opts.clearGap;

    for (let u = 0; u < units.length; u++) {
      const unit = units[u];
      const isLast = u === units.length - 1;
      const picked = [];
      let mustStop = null;
      let stopIdx = null;
      for (let k = 0; k < unit.legs.length; k++) {
        const { sec, dir } = unit.legs[k];
        const s = this.sections[sec];
        if (usedHere.has(sec)) {
          reason = 'route doubles back on itself';
          opposed = sec;
          doubling = `${run.length + k ? (picked[k - 1] || run.at(-1)).sec : t.legs.at(-1)?.sec}>${sec}`;
          return { ok: false, run, reason, opposed, doubling };
        }
        usedHere.add(sec);
        let lanes = [...Array(s.lanes).keys()].filter((l) => this.laneCompatible(sec, l, dir));
        if (!lanes.length) {
          reason = `${s.name ? s.name + ' ' : ''}${sec} held against it`;
          return { ok: false, run, reason, opposed: sec, doubling };
        }
        // Prefer a lane without leaders, then the one with most room.
        const clearOf = (l) => !this.lane(sec, l).holders.some((h) => h !== t.id);
        lanes.sort((x, y) => clearOf(y) - clearOf(x) || this.laneRoom(sec, y, dir) - this.laneRoom(sec, x, dir));
        const lane = lanes[0];
        const lk = laneKey(sec, lane);
        leaders = leaders.filter((ld) => ld.lanes.has(lk));
        for (const h of this.lane(sec, lane).holders) {
          if (h === t.id || leaders.some((ld) => ld.id === h)) continue;
          const ht = this.state.trains[h];
          if (!ht) continue;
          const ls = ht.legs.map((x) => laneKey(x.sec, x.lane));
          leaders.push({ id: h, lanes: new Set(ls), last: ls[ls.length - 1] });
        }
        // A same-direction train ahead whose authority ends here: we must not be granted
        // past this point, or it would see us as a train ahead of it and wait for us.
        const stopper = leaders.find((ld) => ld.last === lk);
        if (stopper && stopIdx === null) { mustStop = stopper.id; stopIdx = k; }
        picked.push({ sec, dir, lane });
        tentative.set(lk, dir);
      }

      // Ending where a leader ends (same final section) is fine; going past it is not.
      const capped = stopIdx !== null && stopIdx < picked.length - 1;
      if (isLast && !capped) {
        const lastLeg = picked.at(-1);
        if (endsAt === 'reverse') {
          const L = this.state.lanes[laneKey(lastLeg.sec, lastLeg.lane)];
          if ((L && L.holders.some((h) => h !== t.id)) || this.sections[lastLeg.sec].length < need) {
            reason = `waiting for clear track to reverse on ${lastLeg.sec}`;
            return { ok: false, run, reason, opposed: null, doubling };
          }
        } else if (!endsAt) {
          const full = this.yardFull(t, this.exitIL(lastLeg.sec, lastLeg.dir));
          if (full) { reason = full; return { ok: false, run, reason, opposed: null, doubling }; }
        }
        run.push(...picked);
        ok = true;
        break;
      }
      if (unit.chain && unit.chain.bypass) {
        // Clear on the furthest section of the chain the train fits on by itself, so it
        // never stands across a switch inside the chain, as long as an opposing train
        // still has a way past the chain.
        let cleared = false;
        for (let k = stopIdx ?? picked.length - 1; k >= 0 && !cleared; k--) {
          if (this.chainRoom(t, [picked[k]]) < need) continue;
          const part = picked.slice(0, k + 1);
          const tent = new Map(tentative);
          for (const p of picked.slice(k + 1)) tent.delete(laneKey(p.sec, p.lane));
          if (this.wayPast(t, unit, picked, tent)) { run.push(...part); cleared = true; }
        }
        if (cleared) { ok = true; break; }
      }
      if (mustStop) {
        reason = `following ${mustStop}, no room to clear behind it`;
        return { ok: false, run, reason, opposed: null, doubling };
      }
      if (unit.chain && unit.chain.bypass) reason = `no room to clear at ${this.ilName(this.exitIL(picked.at(-1).sec, picked.at(-1).dir))}`;
      run.push(...picked); // run through
    }
    return { ok, run, reason, opposed, doubling, endsAt: ok && run.length === path.length ? endsAt : null };
  }

  /** Room left in a chain (as picked lanes) for this train to stop clear, travelling as picked. */
  chainRoom(t, picked) {
    let blocks = 0;
    let length = 0;
    const holders = new Set();
    // Only the chain's last section counts: a train stopped further back would stand
    // across the switches inside the chain (industry spurs, crossings) and block them.
    for (const p of picked.slice(-1)) {
      const s = this.sections[p.sec];
      blocks += s.blockCount;
      length += s.length;
      const L = this.state.lanes[laneKey(p.sec, p.lane)];
      if (L && L.holders.length) {
        if (L.dir !== p.dir) return 0;
        for (const h of L.holders) if (h !== t.id) holders.add(h);
      }
    }
    if (!holders.size) return length;
    const avg = length / blocks;
    let used = 0;
    for (const h of holders) used += Math.ceil(((this.state.trains[h]?.length || 0) + this.opts.clearGap) / avg);
    return Math.max(0, blocks - used) * avg;
  }

  /**
   * Would an opposing train still have a way past a train clearing in this chain? For a
   * multi-track section: another lane not held our way. Otherwise: a route from the far
   * end back to the near end that avoids the chain and isn't held against it, counting
   * this run's own claims.
   */
  wayPast(t, unit, picked, tentative) {
    const c = unit.chain;
    if (c.lanes >= 2 && picked.length === 1) {
      const { sec, dir, lane } = picked[0];
      const s = this.sections[sec];
      for (let l = 0; l < s.lanes; l++) {
        if (l === lane) continue;
        const L = this.state.lanes[laneKey(sec, l)];
        if (!L || !L.holders.length || L.dir !== dir) return true;
      }
      return false;
    }
    const from = this.exitIL(picked.at(-1).sec, picked.at(-1).dir);
    const to = this.entryIL(picked[0].sec, picked[0].dir);
    const avoid = new Set(c.sections.map((x) => x.sec));
    const limit = c.length * 1.5 + 2000;
    const ok = (sec, dir) => {
      const s = this.sections[sec];
      if (s.kind !== 'main' && s.kind !== 'siding') return false;
      for (let l = 0; l < s.lanes; l++) {
        const k = laneKey(sec, l);
        const tent = tentative.get(k);
        if (tent !== undefined && tent !== dir) continue;
        if (this.laneCompatible(sec, l, dir)) return true;
      }
      return false;
    };
    const dist = new Map();
    const heap = new MinHeap();
    for (const end of this.net.interlockings[from].sectionEnds) {
      const dir = end.side === 'a' ? 1 : -1;
      if (avoid.has(end.sec) || !ok(end.sec, dir)) continue;
      const d = this.sections[end.sec].length;
      if (d <= limit) { dist.set(`${end.sec}:${dir}`, d); heap.push(d, { sec: end.sec, dir }); }
    }
    while (heap.size) {
      const [d, st] = heap.pop();
      if (d > dist.get(`${st.sec}:${st.dir}`)) continue;
      const exit = this.exitIL(st.sec, st.dir);
      if (exit === to) return true;
      if (this.net.interlockings[exit].kind === 'yard') continue;
      for (const tr of this.net.transitions[`${st.sec}:${st.dir > 0 ? 'b' : 'a'}`] || []) {
        const nd = tr.side === 'a' ? 1 : -1;
        if (avoid.has(tr.sec) || !ok(tr.sec, nd)) continue;
        const total = d + this.sections[tr.sec].length;
        const key = `${tr.sec}:${nd}`;
        if (total <= limit && (!dist.has(key) || total < dist.get(key))) { dist.set(key, total); heap.push(total, { sec: tr.sec, dir: nd }); }
      }
    }
    return false;
  }

  grant(t, run, endsAt = null) {
    this.state.laneVersion = (this.state.laneVersion || 0) + 1;
    t.refusedAt = null;
    if (t.inYard) { delete this.state.yards[t.inYard]?.trains[t.id]; t.inYard = null; }
    let start = this.pathEnd(t);
    const via = t.via || [];
    for (const r of run) {
      const len = this.sections[r.sec].length;
      const prev = t.legs.at(-1);
      const leg = { sec: r.sec, lane: r.lane, dir: r.dir, start, len };
      // Diverging route into this leg: turnout speed limit while the train goes through.
      if (prev) {
        const tr = (this.net.transitions[`${prev.sec}:${prev.dir > 0 ? 'b' : 'a'}`] || []).find((x) => x.sec === r.sec && (x.side === 'a') === (r.dir > 0));
        if (tr?.diverging) leg.turnoutMph = this.turnoutMph(tr.turnoutDeg);
      }
      t.legs.push(leg);
      while (t.viaDone < via.length && (via[t.viaDone] === r.sec || this.exitIL(r.sec, r.dir) === via[t.viaDone])) t.viaDone++;
      const L = this.lane(r.sec, r.lane);
      L.dir = r.dir;
      L.holders.push(t.id);
      start += len;
    }
    if (t.wait) this.log(t.id, `released after ${Math.round(this.state.time - t.wait.since)}s`);
    t.wait = null;
    t.status = 'running';
    this.state.lastProgress = this.state.time;
    const to = this.exitIL(run[run.length - 1].sec, run[run.length - 1].dir);
    if (endsAt === 'reverse') t.reverseAt = run.at(-1).sec;
    if (endsAt === 'yardturn') t.yardTurn = to;
    if (to === t.dest && !endsAt && this.net.interlockings[to].kind === 'yard') {
      ((this.state.yards[to] ||= { trains: {}, inbound: {} }).inbound)[t.id] = t.length;
    }
    this.log(t.id, `run granted to ${this.ilName(to)} (${run.length} section${run.length > 1 ? 's' : ''})${endsAt === 'reverse' ? ', to reverse' : ''}`);
    return true;
  }

  turnoutMph(deg) {
    if (!deg) return this.opts.crossoverMph;
    for (const [max, mph] of this.opts.turnoutMph) if (deg <= max) return mph;
    return this.opts.turnoutMph.at(-1)[1];
  }

  // ---------------------------------------------------------------- yards

  yardCapacity(il) {
    const c = this.net.interlockings[il]?.capacity;
    return c ? c.standingLength || c.trackLength || 0 : 0;
  }

  /** Why a train can't be sent into yard il right now (or null if it can). */
  yardFull(t, il) {
    if (this.net.interlockings[il]?.kind !== 'yard' || il !== t.dest) return null;
    const cap = this.yardCapacity(il);
    if (!cap) return null;
    const y = this.state.yards[il] || { trains: {}, inbound: {} };
    let used = 0;
    // Trains already waiting to depart don't count: they are about to free their space,
    // and an inbound train held outside could be standing in their way (gridlock).
    for (const [id, len] of Object.entries(y.trains)) if (id !== t.id && this.state.trains[id]?.status !== 'staged') used += len;
    for (const [id, len] of Object.entries(y.inbound)) if (id !== t.id) used += len;
    // An empty yard always takes a train, even one longer than its tracks (it would
    // double over), so small yards can't strand trains forever.
    if (used === 0 || used + t.length <= cap) return null;
    return `${this.ilName(il)} is full (${(used / 1000).toFixed(1)} of ${(cap / 1000).toFixed(1)} km in use)`;
  }

  /** Put a train that finished dwelling back on the board for its onward trip. */
  restage(t) {
    const next = t.then;
    t.then = next.then || null;
    Object.assign(t, {
      from: t.dest, dest: next.to, status: 'staged', legs: [], head: 0, speed: 0, authEnd: 0,
      blocks: [], locks: [], plan: null, via: next.via || [], viaDone: 0, allowReverse: false,
      reverseAt: null, nextRequestAt: 0, refusedAt: null, wait: null,
    });
    this.log(t.id, `departing ${this.ilName(t.from)} for ${this.ilName(t.dest)}`);
  }

  // ---------------------------------------------------------------- reversing moves

  /** Once stopped at the end of its run on a reversal section, change ends and go back. */
  maybeReverse(t) {
    if (!t.reverseAt || t.speed > 0.3 || t.head < this.pathEnd(t) - this.opts.stopMargin - 1) return;
    if (!t.reverseReadyAt) { t.reverseReadyAt = this.state.time + this.opts.reverseDwell; this.log(t.id, `stopped to reverse on ${t.reverseAt}`); return; }
    if (this.state.time < t.reverseReadyAt) return;
    const leg = t.legs.at(-1);
    const L = this.state.lanes[laneKey(leg.sec, leg.lane)];
    if (L && L.holders.some((h) => h !== t.id)) { this.noteWait(t, `waiting for ${leg.sec} to clear before reversing`); return; }
    if (t.head - t.length < leg.start - 1e-6) return; // not fully on the section yet
    const s = this.sections[leg.sec];
    const tailLocal = t.head - t.length - leg.start; // in old travel direction
    this.releaseAll(t);
    const nleg = { sec: leg.sec, lane: leg.lane, dir: -leg.dir, start: 0, len: leg.len };
    t.legs = [nleg];
    const NL = this.lane(leg.sec, leg.lane);
    NL.dir = nleg.dir;
    NL.holders.push(t.id);
    t.head = leg.len - tailLocal;
    t.speed = 0;
    // Re-take the blocks the train stands on, in the new direction.
    t.blocks = [];
    const first = Math.floor(Math.max(0, t.head - t.length) / s.blockLength);
    const last = Math.min(s.blockCount - 1, Math.floor((t.head - 1e-6) / s.blockLength));
    for (let k = first; k <= last; k++) {
      const i = nleg.dir > 0 ? k : s.blockCount - 1 - k;
      const key = blockKey(leg.sec, leg.lane, i);
      this.state.blocks[key] = t.id;
      t.blocks.push({ key, start: k * s.blockLength, end: Math.min((k + 1) * s.blockLength, leg.len) });
    }
    t.authEnd = t.blocks.at(-1).end;
    t.reverseAt = null;
    t.reverseReadyAt = null;
    t.reversals = (t.reversals || 0) + 1;
    this.state.laneVersion = (this.state.laneVersion || 0) + 1;
    this.log(t.id, `reversed on ${leg.sec}`);
  }

  // ---------------------------------------------------------------- signals

  /**
   * What the signals show this train. Signals stand at every block boundary and at each
   * interlocking. The next signal shows Stop if the train has no authority past it,
   * Approach if one block is clear beyond it, Advance Approach for two, Clear for three
   * or more; "diverging" if the route at that signal takes a turnout. "governing" is the
   * aspect of the last signal passed, which sets the speed now.
   */
  signalView(t) {
    if (!t.legs.length) return { next: null, governing: 'stop' };
    const end = this.pathEnd(t);
    const at = (pos) => {
      const leg = t.legs.find((l) => pos >= l.start - 1e-6 && pos < l.start + l.len - 1e-6);
      if (!leg) return null;
      const s = this.sections[leg.sec];
      const idx = Math.floor((pos - leg.start + 1e-6) / s.blockLength);
      return { leg, s, idx, key: blockKey(leg.sec, leg.lane, leg.dir > 0 ? idx : s.blockCount - 1 - idx), end: Math.min(leg.start + (idx + 1) * s.blockLength, leg.start + leg.len) };
    };
    const cur = at(Math.min(t.head, end - 1e-3));
    if (!cur) return { next: null, governing: 'stop' };
    let clear = 0;
    let pos = cur.end;
    // A held train's signals stay at Stop beyond what it already has.
    const limit = t.held ? t.authEnd : end;
    while (clear < 3 && pos < limit - 1e-6) {
      const b = at(pos);
      if (!b) break;
      const h = this.state.blocks[b.key];
      if (h && h !== t.id) break;
      clear++;
      pos = b.end;
    }
    const names = ['stop', 'approach', 'advance-approach', 'clear'];
    const nextLeg = t.legs.find((l) => Math.abs(l.start - cur.end) < 1e-3);
    return {
      next: { pos: cur.end, distance: cur.end - t.head, aspect: names[Math.min(clear, 3)], diverging: !!nextLeg?.turnoutMph, speedMph: nextLeg?.turnoutMph || null },
      governing: names[Math.min(clear + 1, 3)],
    };
  }

  /** Each running train's next signal, with position, for drawing. */
  signalStates() {
    const out = [];
    for (const t of Object.values(this.state.trains)) {
      if (!t.legs.length || ['arrived', 'noroute', 'dwelling'].includes(t.status)) continue;
      const v = this.signalView(t);
      if (!v.next) continue;
      const leg = this.legAt(t, Math.min(v.next.pos - 0.5, this.pathEnd(t)));
      const d = v.next.pos - leg.start;
      const p = pointAlong(this.sections[leg.sec].coords, leg.dir > 0 ? d : leg.len - d);
      out.push({ train: t.id, lat: p[0], lon: p[1], ...v.next, governing: v.governing });
    }
    return out;
  }

  lookahead(t) {
    return (t.maxSpeed * t.maxSpeed) / (2 * t.decel) + 400;
  }

  atHold(t) { return t.holdAt && t.legs.length && this.exitIL(t.legs.at(-1).sec, t.legs.at(-1).dir) === t.holdAt; }

  extendAuthority(t) {
    if (t.held) { this.noteWait(t, 'held by dispatcher'); return; }
    const want = t.head + this.lookahead(t);
    for (let guard = 0; guard < 64 && t.authEnd < want; guard++) {
      // Need more legs?
      if (t.authEnd >= this.pathEnd(t) - 1e-6) {
        const atDest = t.legs.length && this.exitIL(t.legs.at(-1).sec, t.legs.at(-1).dir) === t.dest;
        if (atDest) return;
        if (t.reverseAt || t.yardTurn) return; // stops here and changes ends first
        if (this.atHold(t)) { this.noteWait(t, `held at ${this.ilName(t.holdAt)} by dispatcher`); return; }
        if (this.state.time < t.nextRequestAt) return;
        // Nothing has been granted or released since this train was last refused:
        // the answer would be the same, so don't redo the route search.
        if (t.refusedAt === (this.state.laneVersion || 0)) return;
        if (!this.requestRun(t)) {
          t.nextRequestAt = this.state.time + this.opts.retryInterval;
          // Yields time out, so those refusals can't be cached.
          if (t.status !== 'noroute' && !t.wait?.reason?.startsWith('yielding')) t.refusedAt = this.state.laneVersion || 0;
          return;
        }
      }
      // Next step: one block, or, when entering an interlocking, every block needed to
      // get the whole train clear of it. A train never takes an interlocking it can't
      // clear, so it never sits across one blocking crossing moves.
      let step = this.nextStep(t);
      if (!step) return;
      if (step.short) {
        // Granted track ends before the train would be clear of the interlocking ahead:
        // get the next run first, rather than stop across the interlocking.
        if (this.state.time < t.nextRequestAt || t.refusedAt === (this.state.laneVersion || 0) || !this.requestRun(t)) {
          if (t.status !== 'noroute' && !t.wait?.reason?.startsWith('yielding')) t.refusedAt = this.state.laneVersion || 0;
          t.nextRequestAt = Math.max(t.nextRequestAt, this.state.time + this.opts.retryInterval);
          this.noteWait(t, t.wait?.reason || 'waiting for room to clear the interlocking ahead');
          return;
        }
        step = this.nextStep(t);
        if (!step || step.short) return;
      }
      for (const b of step.blocks) {
        const holder = this.state.blocks[b.key];
        if (holder && holder !== t.id) { this.noteWait(t, `block ahead occupied by ${holder}`); return; }
      }
      for (const l of step.locks) {
        const lock = this.state.locks[l.id];
        if (lock && lock !== t.id) { this.noteWait(t, `waiting on ${this.ilName(l.id)}`); return; }
      }
      for (const l of step.locks) if (this.state.locks[l.id] !== t.id) { this.state.locks[l.id] = t.id; t.locks.push(l); }
      for (const b of step.blocks) { this.state.blocks[b.key] = t.id; t.blocks.push(b); }
      t.authEnd = step.blocks.at(-1).end;
      t.wait = null;
    }
  }

  /** Blocks (and interlocking locks) for the train's next authority step. */
  nextStep(t) {
    const blocks = [];
    const locks = [];
    const end = this.pathEnd(t);
    const last = t.legs.at(-1);
    // Only where the run deliberately ends short (destination, a reversal, a dispatcher
    // hold) may the train stop without its whole length clear of an interlocking.
    const final = last && (this.exitIL(last.sec, last.dir) === t.dest || t.reverseAt || t.yardTurn || this.atHold(t));
    const clearLen = t.length + this.opts.stopMargin + this.opts.clearGap;
    let pos = t.authEnd;
    let reqEnd = pos; // the step must reach here: clear of every interlocking it takes
    for (let guard = 0; guard < 2000; guard++) {
      const leg = t.legs.find((l) => pos >= l.start - 1e-6 && pos < l.start + l.len - 1e-6);
      if (!leg) break;
      const s = this.sections[leg.sec];
      const local = pos - leg.start;
      if (local < 1e-6) {
        const il = this.entryIL(leg.sec, leg.dir);
        // Yards are locked per lead, so trains can use different leads at once.
        const id = this.net.interlockings[il]?.kind === 'yard' ? `${il}@${leg.sec}` : il;
        locks.push({ id, pos: leg.start });
        reqEnd = Math.max(reqEnd, final ? Math.min(leg.start + clearLen, end) : leg.start + clearLen);
      }
      const idxTravel = Math.floor((local + 1e-6) / s.blockLength);
      const i = leg.dir > 0 ? idxTravel : s.blockCount - 1 - idxTravel;
      const bEnd = Math.min(leg.start + (idxTravel + 1) * s.blockLength, leg.start + leg.len);
      blocks.push({ key: blockKey(leg.sec, leg.lane, i), start: pos, end: bEnd });
      pos = bEnd;
      if (pos >= reqEnd - 1e-6) break;
    }
    if (!blocks.length) return null;
    return { blocks, locks, short: pos < reqEnd - 1e-6 };
  }

  noteWait(t, reason) {
    if (!t.wait) t.wait = { since: this.state.time, reason };
    else t.wait.reason = reason;
  }

  /**
   * Speed: the lowest of the train's top speed, the track speed (with slow orders) and
   * any turnout limit anywhere under the train, Approach speed after passing an Approach
   * signal, and braking curves for slower track, turnouts, an Approach signal and the
   * end of authority ahead.
   */
  move(t, dt) {
    if (!t.legs.length) return;
    const tail = t.head - t.length;
    let target = t.maxSpeed;
    for (const leg of t.legs) {
      const a = leg.start;
      const b = leg.start + leg.len;
      if (b > tail && a <= t.head) {
        target = Math.min(target, this.speedOf(leg.sec));
        if (leg.turnoutMph && a >= tail - 1e-6) target = Math.min(target, leg.turnoutMph * MPH);
      } else if (a > t.head) {
        let lim = this.speedOf(leg.sec);
        if (leg.turnoutMph) lim = Math.min(lim, leg.turnoutMph * MPH);
        target = Math.min(target, Math.sqrt(lim * lim + 2 * t.decel * Math.max(0, a - t.head - 5)));
      }
    }
    const sig = this.signalView(t);
    t.aspect = sig.next?.aspect || 'stop';
    const appr = this.opts.approachMph * MPH;
    if (sig.governing === 'approach') target = Math.min(target, appr);
    if (sig.next?.aspect === 'approach') target = Math.min(target, Math.sqrt(appr * appr + 2 * t.decel * Math.max(0, sig.next.distance - 5)));
    const dist = Math.max(0, t.authEnd - t.head - this.opts.stopMargin);
    target = Math.min(target, Math.sqrt(2 * t.decel * dist));
    if (t.speed < target) t.speed = Math.min(target, t.speed + t.accel * dt);
    else t.speed = Math.max(target, t.speed - t.decel * 2 * dt);
    t.head = Math.min(t.authEnd, t.head + t.speed * dt);
  }

  releaseBehind(t) {
    const tail = t.head - t.length;
    t.blocks = t.blocks.filter((b) => {
      if (b.end > tail) return true;
      if (this.state.blocks[b.key] === t.id) delete this.state.blocks[b.key];
      return false;
    });
    t.locks = t.locks.filter((l) => {
      if (l.pos > tail) return true;
      if (this.state.locks[l.id] === t.id) delete this.state.locks[l.id];
      return false;
    });
    while (t.legs.length > 1 && t.legs[0].start + t.legs[0].len <= tail) this.releaseLeg(t, t.legs.shift());
  }

  releaseLeg(t, leg) {
    const L = this.state.lanes[laneKey(leg.sec, leg.lane)];
    if (!L) return;
    this.state.laneVersion = (this.state.laneVersion || 0) + 1;
    L.holders = L.holders.filter((id) => id !== t.id);
    if (!L.holders.length) L.dir = 0;
  }

  releaseAll(t) {
    for (const b of t.blocks) if (this.state.blocks[b.key] === t.id) delete this.state.blocks[b.key];
    for (const l of t.locks) if (this.state.locks[l.id] === t.id) delete this.state.locks[l.id];
    for (const leg of t.legs) this.releaseLeg(t, leg);
    t.blocks = [];
    t.locks = [];
    t.legs = [];
  }

  checkArrival(t) {
    if (!t.legs.length) return;
    const last = t.legs.at(-1);
    if (t.yardTurn && this.exitIL(last.sec, last.dir) === t.yardTurn && t.head >= this.pathEnd(t) - this.opts.stopMargin - 1 && t.speed <= 0.5) {
      // Pulled into the yard to turn: come back out after changing ends.
      const yard = t.yardTurn;
      this.releaseAll(t);
      t.yardTurn = null;
      t.reversals = (t.reversals || 0) + 1;
      t.then = { to: t.dest, dwell: this.opts.reverseDwell, via: (t.via || []).slice(t.viaDone || 0), then: t.then };
      t.dest = yard;
      t.status = 'dwelling';
      t.departAt = this.state.time + this.opts.reverseDwell;
      t.speed = 0;
      this.log(t.id, `turning in ${this.ilName(yard)}`);
      return;
    }
    if (this.exitIL(last.sec, last.dir) !== t.dest) return;
    if (t.head < this.pathEnd(t) - this.opts.stopMargin - 1) return;
    if (t.speed > 0.5) return;
    this.releaseAll(t);
    t.status = 'arrived';
    t.speed = 0;
    t.arrivedAt = this.state.time;
    this.log(t.id, `arrived at ${this.ilName(t.dest)}`);
    if (this.net.interlockings[t.dest].kind === 'yard') {
      const y = (this.state.yards[t.dest] ||= { trains: {}, inbound: {} });
      delete y.inbound[t.id];
      y.trains[t.id] = t.length;
      t.inYard = t.dest;
      if (t.then) { t.status = 'dwelling'; t.departAt = this.state.time + (t.then.dwell || 0); }
    }
  }
}

/** Small binary min-heap of [priority, value] pairs. */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    for (let i = a.length - 1; i > 0; ) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
