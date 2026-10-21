# HighIron TCS

A basic traffic control system and railnet built from OpenStreetMap rail data. Plain ES modules, no build step, no dependencies. It turns an Overpass export into two layers:

- **Track network** (TCS): control points, sections, passing locations, signal blocks, yards and portals, with a dispatcher that grants trains authority so they follow each other, meet on sidings or double track, and never collide. It shows signal aspects, enforces track, turnout and approach speeds, takes dispatcher commands (holds, priorities, routing, slow orders, track out of service), enforces yard capacity, and makes reversing moves when there's no other way.
- **Railnet**: the coarse map and economy layer of junctions, yards and portals joined by named lines, with length, run time, single or double track, sidings and the industries along each line. Every railnet line keeps the TCS section ids it covers.

The Jacksonville, FL area is the reference data set: 970 km of track, 12 yards, 7 lines leaving the map, and CSX, NS, FEC, Talleyrand and the port railroad.

## Layout

```
src/geo.js          distance, bearing and polyline helpers ([lat, lon] arrays, metres)
src/osm-import.js   Overpass JSON -> raw track graph (edges split at switches/junctions)
src/network.js      raw graph -> TCS network (JSON-serialisable, cacheable in localStorage)
src/railnet.js      TCS network -> coarse railnet (junctions, yards, portals, named lines)
src/dispatcher.js   trains, routing, run authority, signal blocks, movement, save/restore
tools/build-railnet.js  offline build: Overpass export -> network + railnet JSON, with a report
tools/pilot.js      fixed dispatch scenarios between two places (following, opposing, mixed)
tools/chaos.js      random traffic plus random holds, slow orders and closures; checks safety and completion
data/               Jacksonville Overpass export, a supplementary areas export (Moncrief works), and the prebuilt railnet file
demo/               Leaflet harness: load Jacksonville, the sample line or a file; add trains; switch views
fixtures/           synthetic test line + the script that generates it
test/               node:test suite: synthetic line, randomised stress, and Jacksonville real-data tests
```

`package.json` exists only so Node treats the files as ES modules for the tests.

## Running

```
npm test                                         # or: node --test   (about 20 s)
node tools/chaos.js data/jacksonville.railnet.json 1 6   # 6 chaos trials; run after any dispatcher change
npm run build:jax                                # rebuild data/jacksonville.railnet.json from both data files
python3 -m http.server 8000                      # from this folder, then open http://localhost:8000/demo/
```

The game should load the prebuilt `*.railnet.json` (about 1.5 MB for Jacksonville) rather than importing Overpass data in the browser. It holds `{ network, railnet }`; give `network` to `new Dispatcher()` and draw from `railnet` or `network.sections`.

ES modules don't load from `file://`, so the demo needs to be served over HTTP.

## Getting real track data

Run this on overpass-turbo.eu (or POST it to the Overpass API), export the raw JSON, and open it in the demo or pass it to `importOverpass()`:

```
[out:json][timeout:180];
way["railway"="rail"]({{bbox}})->.r;
.r out body;
node(w.r);
out body qt;
```

Add these lines to also get subdivision names, stations, junction labels and yard areas (this is the query that produced the Jacksonville file):

```
rel(bw.r)["route"~"^(railway|train)$"];
out body;
nwr["railway"~"^(station|halt|junction|yard)$"]({{bbox}});
out geom;
nwr["landuse"="railway"]({{bbox}});
out geom;
```

The last line must be `nwr`, not `way`: many yard and works outlines are multipolygon relations, and `out geom` gives them their outlines. The original Jacksonville export used `way` and missed Moncrief's works area, which is why it sits in a separate file, `data/jacksonville-areas.osm.json`. The build accepts any number of files and merges them, so a supplementary export like that one is the easy way to add missing areas or fixes:

```
node tools/build-railnet.js data/jacksonville.osm.json data/jacksonville-areas.osm.json --out=data/jacksonville.railnet.json
```

`out geom;` output also works for the track. Then run `tools/build-railnet.js` on the export and read its report before using the result (see "Checking a new area").

## Usage

```js
import { importOverpass } from './src/osm-import.js';
import { buildNetwork } from './src/network.js';
import { buildRailnet } from './src/railnet.js';
import { Dispatcher } from './src/dispatcher.js';

const net = buildNetwork(importOverpass(overpassJson));   // or load a prebuilt file's .network
const railnet = buildRailnet(net);
const disp = new Dispatcher(net);
disp.addTrain({ from: 'I0', to: 'I11', length: 1500, maxSpeed: 26.8 }); // metres, m/s
setInterval(() => disp.tick(1), 50);           // 1 simulated second per tick
disp.trainGeometry(train);                     // tail->head polyline for drawing
localStorage.setItem('net', JSON.stringify(net));
localStorage.setItem('state', JSON.stringify(disp.toJSON()));
const restored = Dispatcher.fromJSON(net, JSON.parse(localStorage.getItem('state')));
```

Keep `tick(dt)` at 1–2 seconds and call it more often to run faster; large steps make the stopping kinematics coarse.

## The model

**Import.** Ways tagged `railway=rail` are split wherever they meet another way or have a `railway=switch` node. Each piece gets a kind from `service` (siding, crossover, spur, yard) or `usage=industrial` (spur), a speed from `maxspeed` (bare numbers are km/h, per OSM), a lane count from `tracks=N`, and a line name from the smallest `route=railway` relation it belongs to (so "Nahunta Subdivision" wins over "CSX"). Yard, junction, station and industry (`spur_junction`) labels are collected for naming.

**Gaps.** A dead-end way end that points at other track within 3 m is joined to it. Ends 3–25 m from track are only reported, because parallel yard tracks sit about 4.5 m apart and look like gaps at that range. Buffer stops are never treated as gaps. Confirmed gaps can be joined by hand with `--connect=from:to` (OSM node ids) on the build script, or `connect` in the import options. Disconnected pieces under 500 m are dropped and reported.

**Control points** are nodes where the topology changes: switches, track ends, and points where the number of tracks or the kind of track changes. **Sections** are the track between two control points. Control points joined by a crossover or by a main or siding section shorter than `interlockingRadius` (250 m) merge into one **interlocking**, which is how double track mapped as two separate ways with crossovers comes out right: the two tracks become parallel sections between the same pair of interlockings.

**Yards** (including works and terminals) are folded into one interlocking each. A track belongs to a facility if it's tagged `service=yard`, or if it's any non-main track whose midpoint lies inside a facility area. Facility areas are `railway=yard`, `railway=container_terminal`, anything with `works=*` (a shop or maintenance facility), and plain `landuse=railway` areas that hold at least 1 km of `service=yard` track. That last condition keeps out the many `landuse=railway` areas that only outline a station, a junction or a main-line corridor (Orange Park Station, Callahan, Clark Street). Leads that touch other track stay as ordinary sections, so main-line switches stay separate from the yard. All clusters inside one facility area become one yard.

A yard is named from a named area containing it, else the nearest yard label within 1.5 km, else "Railroad works" for an unnamed works area; a yard name always beats a switch name. Clusters with the same name within 3 km are merged (Acorn Yard was six pieces). Yards are flagged `works` or `terminal` when they contain such an area: Moncrief contains the unnamed `works=railroad` relation, so it's flagged as having railroad works.

**Yard size.** Each yard interlocking (and its railnet node) has `capacity`: `trackLength` (all track folded into the yard), `standingTracks` and `standingLength` (pieces of at least 150 m, long enough to hold cars), `longestTrack`, `cars` (standing length ÷ 18.3 m per car), `leads` (connections to the network), and `areaKm2` (mapped area, when there is one). A track split by a crossover counts as two pieces, so `standingTracks` overstates the number of tracks, but the lengths are right. Capacity is enforced by the dispatcher (see "Yards" below). Trains can be sent to a yard as a destination. **Portals** are main-track dead ends that aren't buffer stops, which in an Overpass export means track that continues off the map; they're named after their line and compass direction and make natural spawn and exit points.

**Transitions** record which section ends connect through each interlocking. A move is allowed only if it deviates less than `turnLimitDeg` (70°) from straight at every node, so trains can take a diverging switch but can't make a V-turn from a siding back onto the parallel main. Each transition is flagged `diverging` when, at some switch, it takes a leg other than the straightest one, with `turnoutDeg`, the measured turnout angle, used for turnout speed limits.

**Passing groups** collect all sections between the same two interlockings. The dispatcher uses **chains** instead (see rule 2); groups are kept for the railnet.

**Railnet.** Industry spurs are pruned first and credited to the line or node they hang off. A control point becomes a railnet node only if it is a yard, portal, diamond or end, if its legs head off in three or more different directions, or if the number of main tracks changes there (where double track begins or ends). Leg direction is judged by where each leg is 800 m and 2.5 km out rather than by switch angle, so a crossover between the two tracks of double track is not mistaken for a junction. Lines are found by flooding each node's corridor to the next nodes; edges between the same nodes that run side by side are merged into one double-track line.

**Run times.** Each railnet line stores `profile`, its track speeds along the shortest path (`[[metres, mph], ...]`, from `a` to `b`), and `runTimes`, a table of stop-to-stop seconds for train top speeds from 5 to 80 mph in 5 mph steps (higher if any track in the network is faster; the list is in `railnet.timing.speedClasses`). Each entry runs the train at the lower of its own top speed and the track speed, accelerating at 0.15 m/s² from a stand, braking at 0.3 m/s² in time for slower track ahead, and stopping at the far end. `lineSpeedTime` is the old figure (distance ÷ track speed, no acceleration), kept as a lower bound. For a trip over several lines use `routeTime(railnet, nodeIds, mph)`, which runs one profile end to end so the train doesn't stop at every junction; adding up the per-line table entries would overcount. On Moncrief to Bowden, `routeTime` gives 17.3 minutes at 50 mph; the dispatcher's simulated trip takes 21.6, because the tables don't yet include turnout speed limits (see limitations).

**Signal blocks** subdivide main-track sections at roughly braking distance × 1.2 for the track speed (0.15 m/s² deceleration), clamped to 0.8–4 km. Sidings and spurs are a single block.

## Dispatcher rules

1. **Direction authority per lane.** A lane held in one direction only admits trains moving that way. Following trains stack behind each other block by block; opposing trains never share a lane.
2. **Runs.** A train is granted everything from where it is to the next place it can clear, or to its destination. All lanes in the run take its direction at once, so two trains can't enter the same single track from opposite ends. Places to clear are found along **chains**: track between two anchors (junctions, yards, crossovers), joined through switches that only lead to industry spurs. The train clears on the furthest section of a chain it fits on by itself (counted in whole signal blocks, with its stop margin), so it never stands across a switch inside the chain.
3. **Keep a way past.** A train may only clear in a chain if an opposing train would still have a way past it: another lane of a multi-track section, or a route from the chain's far end back to its near end that avoids the chain, runs on main or siding track, is at most 1.5× the chain's length plus 2 km, and isn't held against it, counting the run being planned. This works for passing sidings and for double track however its switches fall. The first version only recognised double track when both tracks ran between the same pair of control points, which real data often doesn't do: on the FEC between Moncrief and Bowden, one track has extra switches for industries and the other doesn't, so the dispatcher treated it as two separate single tracks and made opposing trains wait for each other.
4. **No claiming past a leader.** A follower's run can't extend beyond the authority of a same-direction train ahead of it on the same track, not even to its destination. If it did, the leader would see the follower holding track ahead of it, take it for a train in front, and wait for it forever (the chaos test found this).
5. **Re-route around opposition.** If the best route runs into opposing authority, that section is banned and the route recomputed, so a train will take the other track of a passing group rather than wait.
6. **Blocks and interlockings.** Inside its run a train acquires blocks ahead within its braking lookahead, and stops at the boundary of a block another train holds. An interlocking admits one train at a time (a yard, one per lead). A train only enters an interlocking when it can take every block needed to get its whole length clear of it *and of every other interlocking it passes on the way*, and if its granted track ends too soon it gets its next run first. So a train never stops across an interlocking, which would block crossing moves. The only exceptions are where a run deliberately ends: the destination, a reversal, or a dispatcher hold. (Each part of this rule was added after a deadlock in the stress or chaos tests, on dense terminal trackage where several interlockings fit within one train length.)
7. **Routes never loop.** A route never uses the same section twice, except for a reversing move (rule 8). Each train keeps its last good route and falls back to waiting for it when re-routing finds nothing, so it can't get stranded on the main.
8. **Reversing only when needed.** Before a train takes any track, the dispatcher checks its destination is reachable going forward. Only if it isn't does it allow reversing moves (see "Reversing moves"), so trains never reverse just to dodge traffic. With `allowReversing: false` such trains are refused with status `noroute`.

`checkInvariants()` verifies that no two trains overlap on a lane and every train is on a lane held in its direction. `stalled(seconds)` reports a probable deadlock if nothing has moved or been granted for that long. `tools/pilot.js` runs fixed scenarios between two named places and reports each train's minutes lost against running alone. Moncrief to Bowden, 1,500 m trains at up to 50 mph (21.6 minutes alone, with turnout and signal speeds): two trains released together lose 12.4 minutes for the second, which waits for the first to clear the yard leads and then runs under Approach signals; two trains 10 minutes apart lose 2.4; an opposing pair loses 0.9 minutes for one train; two following plus one opposing lose 12.4 and 1.9. Before the chain change the opposing train lost a full trip.

Testing: the synthetic stress test runs 40 scenarios of 6–11 trains; the Jacksonville test runs 4 scenarios of 12 trains between random portals and yards; `tools/chaos.js` adds random priorities, onward trips, holds, slow orders and track closures. All assert no overlaps and no stalls. During development the chaos test ran 72 trials of 14 trains on Jacksonville without a failure after the last fixes. Rules 1–8 are a heuristic rather than a proof; the stress and chaos tests are the safety net, so keep running them as rules change.

## Dispatcher controls

All commands are methods on the `Dispatcher`, logged to `state.events`, and saved with the state.

| Command | Effect |
|---|---|
| `hold(id)` / `release(id)` | A held train gets no more track and stops at the end of what it already has. Its signals show Stop. Held trains don't count as stalled. `release` also clears a hold-at. |
| `holdAt(id, interlockingId)` | The train's runs end at that control point; it stops there and waits for `release`. Use it to make a meet happen at a chosen siding. |
| `setPriority(id, n)` | Higher priority (default 0) is served first each tick, and lower-priority trains defer on track a waiting higher-priority train needs, for at most `yieldLimit` (15 min) so yields can't stall the railroad. Also `priority` in `addTrain`. |
| `setRoute(id, via)` | Route via waypoints in order: interlocking ids (pass that control point or yard) or section ids (use that track, e.g. a particular siding). Also `via` in `addTrain`. |
| `slowOrder(sectionId, mph)` | Speed restriction on a section; `null` lifts it. Routing accounts for it. |
| `setOutOfService(sectionId, true/false)` | Nothing new is routed over it. Trains already granted it clear it. Trains with no other way wait (not `noroute`) until it's back. |
| `departYard(id, to, { dwell })` / `breakUp(id)` | Send a train standing in a yard onward, or break it up so it stops taking yard space. |

The demo has Hold/Release and priority buttons on each train, and a popup on any track for slow orders and out-of-service.

## Signals and speeds

Signals stand at every block boundary and at each interlocking. `signalView(train)` gives the train's next signal: Stop if it has no authority past it, Approach if one block is clear beyond it, Advance Approach for two, Clear for three or more, and whether the route there is diverging (with its speed). Aspects come from granted, unoccupied track, so a held train sees Stop. `signalStates()` gives every running train's next signal with its position, for drawing.

A train's speed is the lowest of its top speed, the track speed (with slow orders), the turnout limit for any diverging route anywhere under the train until its tail clears, and 30 mph (`approachMph`) after passing an Approach signal. It brakes in time for each of those ahead, and for the end of its authority. Turnout limits come from the measured turnout angle: 40 mph up to 3°, 30 mph up to 5°, 20 mph up to 8°, 10 mph beyond (`turnoutMph`), and 30 mph through a crossover with no measured angle (`crossoverMph`). The angle is measured 25 m from the switch point, so treat these as rough; real turnout numbers could come from OSM `railway:switch` tags where they exist.

## Yards

- **Capacity.** A train can only be granted the run into its destination yard if the trains standing there plus those already on their way fit in `capacity.standingLength` (or `trackLength`). Otherwise it waits where it is with "Yard X is full". An empty yard always takes a train, so a small yard can't strand a long one. Trains waiting to depart don't count, since an inbound train held outside could be standing in their way.
- **Arriving, dwelling and departing.** A train that arrives at a yard stays there, taking space, until it's broken up (`breakUp`) or sent on (`departYard`, or `then: { to, dwell }` in `addTrain`, which departs automatically after `dwell` seconds). Space is freed when it leaves.
- **Leads.** A yard is locked per lead, so trains can leave or pass through by different leads at once. Movement inside the yard still takes no time.
- `yardStatus(interlockingId)` gives capacity, length standing and inbound, and which trains. The demo shows it in the yard tooltip.

## Reversing moves

When a destination can't be reached going forward (a trailing-point spur, a yard reached only through a wye), the route search may reverse:

- **On a section the train fits on.** It runs fully onto the section, stops, waits `reverseDwell` (2 min) to change ends, and comes back the other way, possibly retracing the track it came in on to take the other leg of the switch. A reversal is only planned onto a section no other train holds when the train gets there.
- **In a yard.** It pulls into the yard, changes ends and departs again.

Each reversal costs `reverseCost` (10 min) in route search, and is only used when there's no forward route. In Jacksonville that's the four trips involving Yard 1 or Yard 4; each takes one reversal.

## Checking a new area

Run `tools/build-railnet.js` and read the report. The things to check, in order:

1. **Connected pieces** should be one big component. More means something is cut off; look at where the smaller pieces are.
2. **Possible gaps** lists dead ends 3–25 m from other track. Most are real track ends; check the few on main or branch lines in OSM and join real ones with `--connect`.
3. **Portals** should be exactly the lines you expect to leave the map. A portal in the middle of town is a main track missing its buffer stop tag or a broken connection.
4. **Yards** named "Yard N" had no OSM label nearby. Add a name in your game data or in OSM. The build prints each yard's track length, car capacity and connections; a yard whose numbers look too big or too small usually has an area drawn too wide or tracks tagged as spurs or sidings.
5. In the demo's railnet view, look for lines drawn as two thin parallel lines where you'd expect one thick double-track line, and for junctions where there is no real junction.

## Known limitations and next steps

- **Acceleration and braking are one fixed pair of values** (0.15 m/s² and 0.3 m/s²) for every train, in both the run-time tables and the dispatcher. They should come from train size and weight: tonnage, horsepower per ton, number of cars, and later grade. A heavy unit train accelerates and brakes far more slowly than a short local, so its run times are longer and it needs longer signal spacing. Adding a per-train-class `accel`/`decel` (or computing them from tons and horsepower) and passing them to `profileTime()` and `addTrain()` is the place to start; the run-time table could then gain a weight dimension alongside speed.

- **Run-time tables leave out turnout limits.** `runTimes` and `routeTime` use track speeds only, so a trip through several diverging moves runs longer in the dispatcher than the tables say (Moncrief to Bowden: 17.3 vs 21.6 minutes). Adding the diverging moves of each line's shortest path to its profile would close most of the gap.
- **Followers are conservative.** Rule 6 makes a following train wait until it can clear every interlocking ahead, which costs time in dense terminals (the second of two trains released together from Moncrief loses 12.4 minutes). It's the price of never stopping across an interlocking.
- **Inside yards** movements take no time and tracks aren't modelled individually; capacity is a total length. A train longer than a yard's tracks can still enter an empty yard.
- **Reversing moves** are run as stop, change ends, go back. Run-arounds (moving the locomotive to the other end) and shoving moves with restricted speed aren't modelled separately.
- **Dispatcher holds can cause deadlocks.** The dispatcher won't stop you holding a train on single track where another train needs to pass. `stalled()` ignores held trains, so a hold left on forever shows up as trains waiting, not as a stall.
- **Facility membership uses each track's midpoint.** A long spur that starts inside a yard area and runs well outside it is counted as yard track. Baldwin is the case to check: its mapped area is a 5 km strip, and with its spur-tagged tracks it now measures 57.8 km of track (previously 2.3 km, when only `service=yard` counted). That's either right (its tracks are mistagged) or the area is drawn too generously.
- **Routes through industrial trackage.** Some connections in OSM are tagged `service=spur` even when they're the only link between lines (West Jacksonville Yard is reached that way). The router uses them, but at four times the cost of main track.
- **`tracks=2` on one way** gets two lanes but no crossovers inside it; trains can only change tracks at its ends.
- **Mapped signals** (`railway=signal`, 197 in Jacksonville) are ignored. Where they exist, they could replace the computed block boundaries. Computed blocks are sized from braking distance at track speed, with a minimum of 800 m, so a 6 km double-track chain at 25 mph has about eight.
- **Run times assume level track** and ignore curves, dwell at stations, and time spent at crew changes or inspections.
- **No schedules.** Priority and holds exist, but there's no timetable: trains run when released. A schedule layer that releases trains at set times and sets priorities by train type is a natural game-layer addition.
- **Railnet nodes** include some unnamed "CP n" junctions in complex terminal areas (99 in Jacksonville). Naming them, or merging the busiest clusters into named terminals, is a data or game-design pass.
- **Drawing** puts both lanes of a `tracks=2` section on one line.

## Integrating with HighIron

The modules have no DOM or Leaflet dependency, so `src/` can drop into the game as-is. The integration points are:

- **Loading:** fetch the prebuilt `*.railnet.json` once at startup.
- **Simulation:** call `tick()` in the game loop (1 s steps; call it more often to run faster).
- **Player controls:** wire game UI to the commands in "Dispatcher controls"; read `signalView()` / `signalStates()` for signals and `yardStatus()` for yards.
- **Drawing:** use `trainGeometry()` or `headPoint()` for trains, `railnet.edges[].coords` for the map, and `network.sections[].coords` when zoomed in.
- **Origins and destinations:** use interlocking ids. Portals and yards are the obvious ones; `railnet.nodes[].interlockings` maps a railnet node to them.
- **Saves:** use `toJSON()`/`fromJSON()` alongside the game's existing localStorage saves. Store only dispatcher state there, since the network is static and reloaded from the file.
