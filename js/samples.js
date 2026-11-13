// Larger, more elaborate sample layouts, built in code so every loop closes exactly.
// Each sample returns a complete project object (same format as a saved .json file).
//
// Track is laid with a small "turtle": it keeps a pose {x,y,h} and an elevation z and
// drops generic flex / sectional pieces as it moves. Right-hand curves are stored as a
// left-hand curve laid in reverse, which is how the editor stores flipped curves too.
import { newProject } from './model.js';
import { TRACK, TRACK_BY_ID, SCENERY_BY_ID, DEVICE_BY_ID, buildGeometry } from './catalog.js';
import { advance, routeEnd, routeLen, toWorld, sampleRoute, norm, DEG } from './geometry.js';

const N6 = { len: 11, r: 40, angle: 9.46, tail: 4.49 }; // #6 turnout geometry (catalog n6L/n6R)
const YARD_GAP = 2.7; // straight between ladder turnouts -> ~2.25" track centres

// ---------------------------------------------------------------- builder
function builder(P) {
  let n = 0, tNo = 0, sNo = 0;
  const id = (p) => p + 'x' + (++n).toString(36);
  const curveCat = (r, a) => TRACK.find((t) => t.kind === 'curve' && !t.flex && t.params.r === r && Math.abs(t.params.angle - a) < 1e-6)?.id || 'cflex';
  const straightCat = (len) => TRACK.find((t) => t.kind === 'straight' && !t.flex && Math.abs(t.params.len - len) < 1e-6)?.id || 'flex';
  const round = (v) => Math.round(v * 1e4) / 1e4;

  function piece(cat, kind, params, pose, z, grade, level, props = {}) {
    const pc = {
      id: id('t'), cat, kind, params, x: round(pose.x), y: round(pose.y), rot: round(norm(pose.h)),
      z: round(z), grade: Math.round(grade * 100) / 100, level, state: 0, props: { name: '', address: '', motor: '', ...props },
    };
    P.pieces.push(pc);
    return pc;
  }
  // world pose of a route end of a placed piece
  const routeEndWorld = (pc, ri) => {
    const g = buildGeometry(pc.kind, pc.params);
    const r = g.routes[ri];
    const e = toWorld(pc, routeEnd(r));
    return { x: e.x, y: e.y, h: e.h, z: pc.z + (pc.grade / 100) * routeLen(r) };
  };

  class Turtle {
    constructor(x, y, h, z = 0, level = 'L0') { Object.assign(this, { x, y, h, z, level }); }
    get pose() { return { x: this.x, y: this.y, h: this.h }; }
    clone() { return new Turtle(this.x, this.y, this.h, this.z, this.level); }
    on(level) { this.level = level; return this; }
    move(seg) { const p = advance(this.pose, seg); this.x = p.x; this.y = p.y; this.h = p.h; }

    // straight, split into flex lengths of at most 36"
    s(len, grade = 0, max = 36) {
      if (this.log) max = Math.min(max, 6);
      const k = Math.max(1, Math.ceil(len / max - 1e-9)), L = len / k;
      let last;
      for (let i = 0; i < k; i++) {
        last = piece(straightCat(round(L)), 'straight', { len: round(L) }, this.pose, this.z, grade, this.level);
        this.record(last, L, false, grade);
        this.move({ s: L }); this.z += (grade / 100) * L;
      }
      return last;
    }
    // when a path log is active, remember each piece's place along the path (for profile())
    record(pc, len, rev, grade) {
      if (!this.log) return;
      this.log.push({ pc, s0: this.dist, len, rev, g: grade });
      this.dist += len;
    }
    // curve, a > 0 turns left, a < 0 turns right; split into pieces of at most `step` degrees
    c(r, a, grade = 0, step = 30) {
      if (this.log) step = Math.min(step, 12);
      const k = Math.max(1, Math.ceil(Math.abs(a) / step - 1e-9)), A = a / k, L = Math.abs(A) * DEG * r;
      let last;
      for (let i = 0; i < k; i++) {
        const start = this.pose, z0 = this.z;
        this.move({ r, a: A }); this.z += (grade / 100) * L;
        const absA = round(Math.abs(A));
        const cat = curveCat(r, absA);
        if (A > 0) last = piece(cat, 'curve', { r, angle: absA }, start, z0, grade, this.level);
        else last = piece(cat, 'curve', { r, angle: absA }, { x: this.x, y: this.y, h: this.h + 180 }, this.z, -grade, this.level);
        this.record(last, L, A < 0, grade);
      }
      return last;
    }
    // facing-point turnout; returns { pc, main, div } where main/div are turtles at the two exits
    to(cat, props = {}) {
      const t = TRACK_BY_ID[cat];
      const pc = piece(cat, t.kind, { ...t.params }, this.pose, this.z, 0, this.level, nextTurnout(props));
      const m = routeEndWorld(pc, 0), d = routeEndWorld(pc, 1);
      return { pc, main: new Turtle(m.x, m.y, m.h, this.z, this.level), div: new Turtle(d.x, d.y, d.h, this.z, this.level) };
    }
    // trailing-point turnout: the turtle enters on the straight leg at the frog end.
    // `cat` is the hand as seen from the points (so a siding on the right of travel uses a Left turnout).
    trail(cat, props = {}) {
      const t = TRACK_BY_ID[cat];
      const far = advance(this.pose, { s: t.params.len });
      const pc = piece(cat, t.kind, { ...t.params }, { ...far, h: this.h + 180 }, this.z, 0, this.level, nextTurnout(props));
      const d = routeEndWorld(pc, 1);
      this.x = far.x; this.y = far.y;
      return { pc, main: this, div: new Turtle(d.x, d.y, d.h, this.z, this.level) };
    }
    bumper() { return piece('bumper', 'bumper', { len: 2 }, this.pose, this.z, 0, this.level); }
    // lay a straight from here to an open end (pose heading outward from that end), matching heights
    join(end) {
      const dx = end.x - this.x, dy = end.y - this.y;
      const len = Math.hypot(dx, dy);
      const lat = Math.abs(-Math.sin(this.h * DEG) * dx + Math.cos(this.h * DEG) * dy);
      const herr = Math.abs(norm(end.h + 180 - this.h));
      if (lat > 0.02 || herr > 0.05) throw new Error(`join misaligned: lateral ${lat.toFixed(3)} heading ${herr.toFixed(3)}`);
      const z1 = end.z ?? this.z;
      return this.s(len, ((z1 - this.z) / len) * 100);
    }
    // straight until the projection along the current heading reaches `coord` on axis 'x' or 'y'
    sTo(axis, coord, grade = 0) {
      const c = axis === 'x' ? Math.cos(this.h * DEG) : Math.sin(this.h * DEG);
      const len = (coord - this[axis]) / c;
      if (len < 0.5) throw new Error(`sTo: negative length ${len}`);
      return this.s(len, grade);
    }
  }

  function nextTurnout(props) {
    tNo++;
    return { name: `T${tNo}`, address: `Servo ${tNo}`, motor: 'Servo (Arduino/PCA9685)', ...props };
  }

  // Passing siding on the `side` ('L'|'R') of a straight main. Returns {main, siding:[pcs], a, b}
  function passingSiding(main, side, length) {
    const sg = side === 'L' ? 1 : -1;
    const A = main.to(side === 'L' ? 'n6L' : 'n6R');
    const sd = A.div; sd.s(YARD_GAP); sd.c(N6.r, -sg * N6.angle);
    const m = A.main; m.s(length);
    const B = m.trail(side === 'L' ? 'n6R' : 'n6L');
    const back = B.div; back.s(YARD_GAP); back.c(N6.r, sg * N6.angle);
    const mid = sd.join({ ...back.pose, z: back.z });
    return { main: m, a: A.pc, b: B.pc, mid };
  }

  // Stub yard ladder off a straight main. Tracks run parallel to the main on `side`
  // and end with bumpers where their projection reaches `endCoord` on `axis`.
  function ladder(main, side, count, axis, endCoord) {
    const sg = side === 'L' ? 1 : -1;
    const A = main.to(side === 'L' ? 'n6L' : 'n6R');
    let diag = A.div;
    const tracks = [];
    for (let i = 0; i < count; i++) {
      diag.s(YARD_GAP);
      const B = diag.to(side === 'L' ? 'n6R' : 'n6L');
      tracks.push(B.div);
      diag = B.main;
    }
    diag.s(YARD_GAP); diag.c(N6.r, -sg * N6.angle);
    tracks.push(diag);
    const ends = tracks.map((t) => { const last = t.sTo(axis, endCoord); const b = t.bumper(); return { t, last, b }; });
    return { main: A.main, turnout: A.pc, tracks: ends };
  }

  // ---- scenery & devices
  function sc(type, x, y, extra = {}) {
    const c = SCENERY_BY_ID[type];
    const { name = '', ...rest } = extra;
    const o = {
      id: id('o'), type, name: c.name, shape: c.shape, x: round(x), y: round(y), rot: 0, w: c.w, d: c.d, h: c.h,
      roof: c.roof || 'flat', color: c.color, base: 0, ...(c.style ? { style: c.style } : {}), ...rest, props: { name },
    };
    P.scenery.push(o);
    return o;
  }
  function dev(type, pc, d, props = {}, extra = {}) {
    const cat = DEVICE_BY_ID[type];
    sNo++;
    const o = {
      id: id('d'), type, name: cat.name, x: 0, y: 0, rot: 0, side: 1, flip: false, pieceId: pc.id, route: 0, d,
      props: { name: `${cat.icon}${sNo}`, address: '', notes: '', ...cat.props, ...props }, ...extra,
    };
    P.devices.push(o);
    return o;
  }
  // Bridge / trestle centred on a point of a piece, aligned with the track at that point
  function spanOn(type, pc, d, extra = {}) {
    const g = buildGeometry(pc.kind, pc.params);
    const pts = sampleRoute(g.routes[0], 0.25);
    const lp = pts.reduce((a, b) => (Math.abs(b.d - d) < Math.abs(a.d - d) ? b : a));
    const w = toWorld(pc, lp);
    return sc(type, w.x, w.y, { rot: round(norm(w.h)), base: round(pc.z + (pc.grade / 100) * lp.d), ...extra });
  }
  // Start logging a turtle's path so its elevations can be set afterwards with profile().
  function path(t) { t.log = []; t.dist = 0; return t.log; }
  // Turn the nominal grades given while laying (in %) into a smooth elevation profile:
  // grades are averaged over `ease` inches (box filter), which gives every change of grade a
  // vertical easement. `rise` rescales the grades so the profile spans exactly that height;
  // `wrap` treats the path as a closed loop. Sets z / grade on every logged piece.
  function profile(t, { ease = 24, z0 = 0, rise = null, wrap = false } = {}) {
    const log = t.log, L = t.dist, step = 0.25, n = Math.ceil(L / step);
    const nominal = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) { const s = (i + 0.5) * step; while (j < log.length - 1 && s > log[j].s0 + log[j].len) j++; nominal[i] = log[j].g; }
    const w = Math.round(ease / step / 2), sm = new Float64Array(n);
    const at = (i) => (wrap ? nominal[((i % n) + n) % n] : i < 0 || i >= n ? 0 : nominal[i]);
    let acc = 0;
    for (let i = -w; i <= w; i++) acc += at(i);
    for (let i = 0; i < n; i++) { sm[i] = acc / (2 * w + 1); acc += at(i + w + 1) - at(i - w); }
    const z = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) z[i + 1] = z[i] + (sm[i] / 100) * step;
    let lo = Math.min(...z), hi = Math.max(...z);
    const k = rise ? rise / (hi - lo) : 1;
    const zAt = (s) => { const f = Math.max(0, Math.min(n, s / step)), i = Math.floor(f); const v = i >= n ? z[n] : z[i] + (z[i + 1] - z[i]) * (f - i); return z0 + (v - (rise ? lo : 0)) * k; };
    for (const e of log) {
      const za = zAt(e.s0), zb = zAt(e.s0 + e.len), g = Math.round(((zb - za) / e.len) * 10000) / 100;
      e.pc.grade = e.rev ? -g : g;
      e.pc.z = round(e.rev ? za + (g / 100) * e.len : za);
    }
    t.log = null;
    t.z = zAt(L);
    return { zAt, length: L, log };
  }
  // piece and distance-along-piece at path distance s
  function at(log, s) {
    const e = log.find((q) => s <= q.s0 + q.len + 1e-9) || log[log.length - 1];
    const d = Math.max(0, Math.min(e.len, s - e.s0));
    return { pc: e.pc, d: e.rev ? e.len - d : d };
  }
  const spanAt = (type, log, s, extra) => { const a = at(log, s); return spanOn(type, a.pc, a.d, extra); };
  const devAt = (type, log, s, props) => { const a = at(log, s); return dev(type, a.pc, a.d, props); };
  return { Turtle, piece, sc, dev, spanOn, passingSiding, ladder, routeEndWorld, path, profile, at, spanAt, devAt };
}

function base(name, outline, levels, settings = {}) {
  const P = newProject();
  P.name = name;
  P.board.outline = outline.map(([x, y]) => ({ x, y }));
  P.levels = levels;
  P.activeLevel = levels[0].id;
  P.settings = { ...P.settings, ...settings };
  P.pieces = []; P.devices = []; P.scenery = [];
  return P;
}

// ================================================================ samples
// Design targets used for every sample (see js/realism.js):
//  * effective grade (grade + 32/R curve drag) <= 3%, raw grade <= 2.5%
//  * >= 3.5" rail-to-rail where tracks cross (3" car + 0.5" deck)
//  * every grade change eased over 24" (3 car lengths), turnouts on level track
//  * no S-curves sharper than 30" without a car-length straight, 2"+ track centres
//  * structures, buildings and trees clear of the tracks; tunnels get portals and cuttings
//    automatically (js/realism.js tunnelInfo) with rock above every bore

const setLevels = (P, fn) => P.pieces.forEach((pc) => { pc.level = fn(pc.z + Math.max(0, (pc.grade / 100) * 6)); });

// 1) Over-and-under figure 8 – the classic "first layout with a bridge".
function figure8() {
  const P = base('Sample – Over & under figure 8 (16×6 ft)', [[0, 0], [192, 0], [192, 72], [0, 72]], [
    { id: 'L0', name: 'Ground', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'High line', elevation: 3.9, visible: true, color: '#b5523f' },
  ], { minRadius: 24, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  const R = 30, D = 120, th = Math.asin((2 * R) / D) / DEG; // 30° crossing
  const T = Math.sqrt((D / 2) ** 2 - R * R), arc = 180 + 2 * th;
  const O = { x: 96, y: 36 };
  const t = new B.Turtle(O.x, O.y, th, 0);
  B.path(t);
  t.s(T, 1); t.c(R, -arc, 1); t.s(T, 1); // climb: out of O, round the east loop, back over O
  t.s(T, -1); t.c(R, arc, -1); t.s(T, -1); // descend round the west loop, under the bridge
  const prof = B.profile(t, { ease: 24, rise: 3.9, wrap: true }); // girder hangs 0.75" below its rails
  const L = prof.length, log = prof.log;
  setLevels(P, (z) => (z > 1.85 ? 'L1' : 'L0'));

  B.sc('mountain', O.x - D / 2, O.y, { w: 70, d: 68, h: 24, name: 'Bald Knob' });
  B.spanAt('girder', log, L / 2, { w: 14, name: 'Crossing girder' });
  B.spanAt('trestle', log, L / 2 - 22, { w: 16, name: 'Gully trestle' });
  B.sc('water', 96, 63, { w: 14, d: 6, name: 'Mill pond' });
  for (const [x, y, r] of [[150, 30, 0], [160, 41, 90], [148, 43, 0], [164, 28, 0]]) B.sc('house', x, y, { rot: r });
  B.sc('tower', 156, 35);
  for (const [x, y] of [[96, 50], [80, 8], [112, 8], [186, 66], [186, 6], [126, 66], [126, 6], [96, 22]]) B.sc('pine', x, y);
  B.devAt('signal3', log, 4, { name: 'SIG1', address: 'D4' });
  B.devAt('signal3', log, L / 2 + 4, { name: 'SIG2', address: 'D5' });
  B.devAt('sensor', log, L - 10, { name: 'PS1', address: 'A0' });
  B.devAt('feeder', log, 12, { name: 'F1' });
  return P;
}

// 2) Spiral loop mountain division – after the Tehachapi Loop, where a train passes over
// its own tail. A valley oval with passing siding and yard; a branch climbs through a spiral
// loop on a mountainside, crosses over itself on a girder bridge and ends in a mining town.
function spiralLoop() {
  const P = base('Sample – Spiral loop mountain division (17½×8½ ft)', [[0, 0], [210, 0], [210, 102], [0, 102]], [
    { id: 'L0', name: 'Valley (main)', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'Loop & branch', elevation: 2, visible: true, color: '#c08a2e' },
    { id: 'L2', name: 'Mine town', elevation: 5.5, visible: true, color: '#b5523f' },
  ], { minRadius: 24, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  const R = 30, RM = 33, EAST = 172, MID = 51; // R33 oval ends leave 5" between main and loop
  // --- main oval, anticlockwise from the branch junction on the front straight
  const jn = new B.Turtle(44, 18, 0, 0).to('n6L', { name: 'T1 Loop jct' });
  const s1 = jn.main.s(14);
  const sid = B.passingSiding(jn.main, 'R', 44); // passing siding on the aisle side
  const main = sid.main;
  main.sTo('x', EAST);
  main.c(RM, 180, 0, 15); // east end: in tunnel under Spiral Mountain
  main.sTo('x', 136); // yard throat clear of the mountain's foot
  const yard = B.ladder(main, 'R', 3, 'x', 58);
  const back = yard.main;
  const s2 = back.sTo('x', 40);
  back.c(RM, 180, 0, 15);
  back.join({ x: 44, y: 18, h: 180, z: 0 });

  // --- branch: 1.8% (2.94% effective on the R28 loop), eased at both ends
  const g = 1.8, LR = 28, beta = 30;
  const br = jn.div;
  B.path(br);
  br.c(R, beta - 9.46, 0); // level off the turnout; the climb eases in from here
  const O = { x: br.x + (MID - br.y) / Math.tan(beta * DEG), y: MID };
  br.s(Math.hypot(O.x - br.x, O.y - br.y), g);
  const sO1 = br.dist;
  const tt = (LR / Math.sin(beta * DEG)) * Math.cos(beta * DEG);
  br.s(tt, g); br.c(LR, -(180 + 2 * beta), g); br.s(tt, g);
  const sO2 = br.dist;
  br.s(18, g); br.c(R, 30, g);
  const sTown = br.dist;
  br.s(16, 0); // level run-in so the town turnouts sit on level track
  const prof = B.profile(br, { ease: 24 });
  const zTown = br.z, log = prof.log;
  setLevels(P, (z) => (z < 0.2 ? 'L0' : z < zTown - 0.2 ? 'L1' : 'L2'));
  br.on('L2');
  const town = B.ladder(br, 'L', 1, 'x', 20);
  town.main.sTo('x', 20); town.main.bumper();

  // --- scenery
  const cx = O.x + LR / Math.sin(beta * DEG);
  // the mountain covers the whole east end: the loop spirals inside it in tunnel and only comes
  // out near the crossing; the main tunnels under its foot round the east curve
  B.sc('mountain', cx, MID, { w: 80, d: 84, h: 26, name: 'Spiral Mountain' }); // stays on the benchwork
  for (const [dx, dy] of [[-8, -30], [6, -32], [20, -26], [-10, 30], [8, 33], [22, 26], [30, -8], [32, 10], [-2, -8], [4, 12]]) B.sc('pine', cx + dx, MID + dy);
  B.spanAt('girder', log, sO2, { w: 12, name: 'Loop crossing' });
  const tr = B.spanAt('trestle', log, sO2 + 10, { w: 10, name: 'Canyon trestle' });
  B.sc('river', tr.x, tr.y, { w: 12, d: 3.5, rot: tr.rot + 90, name: 'Canyon creek' });
  B.sc('station', 96, 10, { name: 'Valley City' });
  B.sc('platform', 96, 13.2, { w: 22 });
  B.sc('road', 60, 4, { w: 30 }); B.sc('road', 136, 4, { w: 30 });
  for (const [x, y] of [[66, 7], [74, 7], [120, 7], [128, 7]]) B.sc('house', x, y);
  for (const x of [60, 84, 108, 136]) B.sc('light', x, 2.5);
  B.sc('enginehouse', 46, 97, { name: 'Engine house' });
  B.sc('tower', 70, 98.5);
  const ty = town.tracks[0].t.y;
  B.sc('factory', 34, ty + 8, { w: 12, d: 6, h: 6, base: zTown, name: 'Gold mine', color: '#7d6b55' });
  B.sc('house', 50, ty + 7, { base: zTown }); B.sc('house', 58, ty + 7, { base: zTown, rot: 90 });
  B.sc('water', 28, 40, { w: 12, d: 7, name: 'Valley lake' });
  for (const [x, y] of [[90, 32], [100, 74], [22, 44], [26, 54], [200, 8], [204, 96], [8, 8], [8, 96], [124, 32], [76, 44]]) B.sc('pine', x, y);

  // --- control
  B.dev('signal3', s1, 3, { name: 'SIG1', address: 'D4' });
  B.dev('signal3', s2, 3, { name: 'SIG2', address: 'D5' });
  B.devAt('signal2', log, sO1 - 20, { name: 'SIG3', address: 'D6' });
  B.devAt('sensor', log, sO1 + 30, { name: 'PS1', address: 'A0' });
  B.devAt('sensor', log, sTown + 4, { name: 'PS2', address: 'A1' });
  B.dev('block', sid.mid, 10, { name: 'BLK siding', address: 'A2' });
  yard.tracks.forEach((t, i) => B.dev('home', t.b, 1, { name: `H${i + 1}`, address: `D${10 + i}` }));
  B.dev('feeder', s1, 8, { name: 'F main' });
  B.devAt('feeder', log, 30, { name: 'F branch' });
  B.devAt('gap', log, 0.5, { name: 'G branch' });
  return P;
}

// 3) Two-deck around-the-walls railroad joined by a 3¾-turn helix (after the multi-deck designs
// in Tony Koester's books). Lower-deck yard and main run along the walls into an R32 helix in the
// corner; the upper deck runs above the lower deck along the back wall to a mine terminal.
function helixTwoDeck() {
  const outline = [[0, 0], [30, 0], [30, 102], [100, 102], [100, 49], [172, 49], [172, 132], [0, 132]];
  const P = base('Sample – Two-deck helix railroad (14½×11 ft room)', outline, [
    { id: 'L0', name: 'Lower deck', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'Helix', elevation: 4, visible: true, color: '#7d5fb0' },
    { id: 'L2', name: 'Upper deck', elevation: 14.3, visible: true, color: '#b5523f' },
  ], { minRadius: 24, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  // lower-deck yard: throat at the north end, tracks run south to bumpers
  const yard = B.ladder(new B.Turtle(19, 66, 270, 0), 'L', 2, 'y', 8);
  yard.main.sTo('y', 8); yard.main.bumper();
  // main north along the left wall, round the corner, along the back wall
  const m = new B.Turtle(19, 66, 90, 0);
  const m1 = m.s(21);
  m.c(30, -90, 0, 15);
  const m2 = m.sTo('x', 112);
  // helix: R32, 1.9% (2.9% effective), 3.82" per turn, eased in and out
  const HR = 32, turns = 3.75, gH = 1.9;
  B.path(m);
  m.s(24, 0);
  const sIn = m.dist;
  for (let i = 0; i < turns * 4; i++) m.c(HR, -90, gH);
  const sOut = m.dist;
  m.s(15, 0);
  const prof = B.profile(m, { ease: 24 });
  const zTop = m.z, log = prof.log;
  setLevels(P, (z) => (z < 0.2 ? 'L0' : z < zTop - 0.2 ? 'L1' : 'L2'));
  m.on('L2');
  // upper deck: curve west and run along the back wall above the lower deck, then down the left wall
  m.c(24, 90);
  const u2 = m.sTo('x', 32);
  m.c(24, 90);
  const u3 = m.sTo('y', 70);
  const town = B.ladder(m, 'L', 1, 'y', 10);
  town.main.sTo('y', 10); town.main.bumper();

  // scenery – lower deck
  B.sc('enginehouse', 26.5, 92, { rot: 90, w: 12, d: 5, name: 'Engine house' });
  B.sc('station', 60, 110.6, { name: 'Junction City' });
  B.sc('platform', 60, 114.4, { w: 18 });
  B.sc('factory', 84, 107.5, { w: 14, d: 7 });
  for (const [x, y] of [[40, 106], [46, 106]]) B.sc('house', x, y);
  for (const [x, y] of [[106, 55], [166, 55], [166, 126], [136, 85], [128, 92], [144, 78]]) B.sc('pine', x, y);
  B.sc('river', 136, 51, { w: 50, d: 3.5, name: 'Cascade creek' });
  // upper deck: truss over a gorge, mine and camp on the wall side of the shelf
  const tb = B.spanOn('truss', u2, 12, { w: 18, name: 'Gorge truss' });
  B.sc('river', tb.x, tb.y, { w: 10, d: 3, rot: 90, name: 'Gorge creek' });
  B.sc('factory', 3.3, 28, { base: zTop, rot: 90, w: 10, d: 6, h: 6, color: '#7d6b55', name: 'Copper mine' });
  B.sc('house', 3.3, 44, { base: zTop, rot: 90, name: 'Bunkhouse' });
  B.sc('tower', 3, 58, { base: zTop });
  for (const [x, y] of [[3, 16], [3, 84], [44, 129], [60, 129], [95, 129]]) B.sc('pine', x, y, { base: zTop });

  // control
  B.dev('signal3', m1, 3, { name: 'SIG1', address: 'D4' });
  B.dev('signal3', m2, 4, { name: 'SIG2', address: 'D5' });
  B.devAt('sensor', log, sIn + 2, { name: 'PS helix in', address: 'A0' });
  B.devAt('sensor', log, sOut + 4, { name: 'PS helix out', address: 'A1' });
  B.dev('signal2', u2, 6, { name: 'SIG3', address: 'D6' });
  B.dev('block', u3, 10, { name: 'BLK upper', address: 'A2' });
  yard.tracks.forEach((t, i) => B.dev('home', t.b, 1, { name: `H${i + 1}`, address: `D${10 + i}` }));
  B.dev('home', town.tracks[0].b, 1, { name: 'H mine', address: 'D13' });
  B.dev('feeder', m1, 8, { name: 'F lower' });
  B.dev('feeder', u2, 10, { name: 'F upper' });
  return P;
}

export const SAMPLES = [
  {
    id: 'figure8', name: 'Over & under figure 8', size: '16 × 6 ft table',
    blurb: 'A figure 8 on R30" curves where one half climbs 3.9" so the track crosses over itself on a girder bridge. Grades are eased top and bottom (1.8%, 2.9% effective), the west loop tunnels through a mountain with cuttings at the portals, and a trestle carries the climb over a gully.',
    features: ['eased 1.8% grade', 'girder bridge', 'trestle', 'tunnel + cuttings'],
    build: figure8,
  },
  {
    id: 'spiral', name: 'Spiral loop mountain division', size: '17½ × 8½ ft island',
    blurb: 'After the Tehachapi Loop: a branch leaves the valley main, spirals up inside a mountain in tunnel (R28", 1.8% = 2.94% effective), comes out and passes over its own track on a girder bridge and crosses a canyon trestle to a mining town. The valley main also tunnels under the foot of the mountain; there is a passing siding, 4-track yard and engine terminal.',
    features: ['3 levels', 'spiral tunnel', 'track crosses over itself', 'main-line tunnel', 'passing siding', '4-track yard', 'signals & sensors'],
    build: spiralLoop,
  },
  {
    id: 'helix', name: 'Two-deck helix railroad', size: '14½ × 11 ft room',
    blurb: 'An around-the-walls, two-deck railroad. The lower-deck yard and main run along the walls into a 3¾-turn R32" helix (1.9%, 3.8" per turn, 2.9% effective) in the corner; the upper deck runs above the lower deck, over a truss bridge, to a mine terminal. Helix posts stand beside the track like a real helix.',
    features: ['helix (14" rise)', 'stacked decks', 'truss bridge', 'stub yards'],
    build: helixTwoDeck,
  },
];
