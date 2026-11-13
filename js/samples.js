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
      const k = Math.max(1, Math.ceil(len / max - 1e-9)), L = len / k;
      let last;
      for (let i = 0; i < k; i++) {
        last = piece(straightCat(round(L)), 'straight', { len: round(L) }, this.pose, this.z, grade, this.level);
        this.move({ s: L }); this.z += (grade / 100) * L;
      }
      return last;
    }
    // curve, a > 0 turns left, a < 0 turns right; split into pieces of at most `step` degrees
    c(r, a, grade = 0, step = 30) {
      const k = Math.max(1, Math.ceil(Math.abs(a) / step - 1e-9)), A = a / k, L = Math.abs(A) * DEG * r;
      let last;
      for (let i = 0; i < k; i++) {
        const start = this.pose, z0 = this.z;
        this.move({ r, a: A }); this.z += (grade / 100) * L;
        const absA = round(Math.abs(A));
        const cat = curveCat(r, absA);
        if (A > 0) last = piece(cat, 'curve', { r, angle: absA }, start, z0, grade, this.level);
        else last = piece(cat, 'curve', { r, angle: absA }, { x: this.x, y: this.y, h: this.h + 180 }, this.z, -grade, this.level);
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
  // Tunnel portals wherever track passes into / out of a hill or mountain
  function portals(hill, clearance = 3.6) {
    const c = Math.cos(-hill.rot * DEG), s = Math.sin(-hill.rot * DEG);
    const surf = (p) => {
      const dx = p.x - hill.x, dy = p.y - hill.y;
      const lx = (dx * c - dy * s) / (hill.w / 2), ly = (dx * s + dy * c) / (hill.d / 2);
      const q = 1 - lx * lx - ly * ly;
      return q > 0 ? (hill.base || 0) + hill.h * Math.sqrt(q) : -1;
    };
    const out = [];
    for (const pc of P.pieces) {
      if (pc.kind !== 'straight' && pc.kind !== 'curve') continue;
      const g = buildGeometry(pc.kind, pc.params);
      const pts = sampleRoute(g.routes[0], 0.25).map((lp) => ({ ...toWorld(pc, lp), z: pc.z + (pc.grade / 100) * lp.d }));
      let prev = null;
      for (const p of pts) {
        const inside = surf(p) > p.z + clearance;
        if (prev && inside !== prev.inside) {
          // portal face sits on the outside of the hill, facing along the track
          const at = inside ? p : prev.p;
          out.push(sc('portal', at.x, at.y, { rot: round(norm(at.h + 90)), base: round(at.z) }));
        }
        prev = { p, inside };
      }
    }
    return out;
  }
  return { Turtle, piece, sc, dev, spanOn, portals, passingSiding, ladder, routeEndWorld };
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

// 1) Over-and-under figure 8 – the classic "first layout with a bridge".
function figure8() {
  const P = base('Sample – Over & under figure 8 (13×5 ft)', [[0, 0], [156, 0], [156, 60], [0, 60]], [
    { id: 'L0', name: 'Ground', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'High line', elevation: 4.25, visible: true, color: '#b5523f' },
  ], { minRadius: 24, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  const R = 24, D = 96, th = Math.asin((2 * R) / D) / DEG; // 30°
  const T = Math.sqrt((D / 2) ** 2 - R * R);
  const arc = 180 + 2 * th, H = 4.25;
  const g = (H / (2 * T + R * arc * DEG)) * 100;
  const O = { x: 78, y: 30 };
  const t = new B.Turtle(O.x, O.y, th, 0);
  const climb1 = t.s(T, g, 48);
  t.c(R, -arc, g); t.on('L1');
  const high = t.s(T, g, 48);
  const top = t.s(T, -g, 48);
  t.on('L0');
  t.c(R, arc, -g);
  const last = t.s(T, -g, 48);

  // scenery: mountain over the west loop, girder bridge at the crossing, trestle approach
  const mtn = B.sc('mountain', O.x - D / 2, O.y, { w: 56, d: 54, h: 14, name: 'Bald Knob' });
  B.portals(mtn);
  B.spanOn('girder', high, T, { w: 14, name: 'Crossing girder' });
  B.spanOn('trestle', high, T - 20, { w: 18, name: 'Gully trestle' });
  B.sc('water', 110, 47, { w: 16, d: 7, name: 'Mill pond' });
  B.sc('station', 112, 10, { rot: 0, name: 'Figure Eight Jct' });
  B.sc('platform', 112, 13.5, { w: 16 });
  for (const [x, y, r] of [[120, 26, 0], [128, 32, 90], [132, 24, 0], [124, 38, 0]]) B.sc('house', x, y, { rot: r });
  B.sc('tower', 140, 30);
  for (const [x, y] of [[62, 52], [70, 8], [92, 52], [100, 6], [146, 52], [150, 8], [8, 55], [52, 4]]) B.sc('pine', x, y);
  B.sc('oak', 96, 44); B.sc('oak', 60, 44);
  B.dev('signal3', climb1, 3, { name: 'SIG1', address: 'D4' });
  B.dev('signal3', top, 3, { name: 'SIG2', address: 'D5' });
  B.dev('sensor', last, 10, { name: 'PS1', address: 'A0' });
  B.dev('feeder', climb1, 8, { name: 'F1' });
  return P;
}

// 2) Spiral loop mountain division – inspired by the Tehachapi Loop, where a train passes over
// its own tail. Lower-level double-ended oval with passing siding and yard; a branch climbs
// a spiral loop inside a mountain, crosses over itself and ends in a mining town.
function spiralLoop() {
  const P = base('Sample – Spiral loop mountain division (16×8 ft)', [[0, 0], [192, 0], [192, 96], [0, 96]], [
    { id: 'L0', name: 'Valley (main)', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'Loop & branch', elevation: 2, visible: true, color: '#c08a2e' },
    { id: 'L2', name: 'Mine town', elevation: 7, visible: true, color: '#b5523f' },
  ], { minRadius: 22, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  const R = 30;
  // --- main oval, built anticlockwise from the branch junction on the front straight
  const m = new B.Turtle(44, 18, 0, 0);
  const jn = m.to('n6L', { name: 'T1 Loop jct' });
  const s1 = jn.main.s(14);
  const sid = B.passingSiding(jn.main, 'R', 44); // passing siding on the aisle side
  const main = sid.main;
  main.sTo('x', 152);
  main.c(R, 180, 0, 15); // east end
  // back straight with the yard ladder on the outside (north)
  main.s(4);
  const yard = B.ladder(main, 'R', 3, 'x', 58);
  const back = yard.main;
  const s2 = back.sTo('x', 40);
  back.c(R, 180, 0, 15); // west end
  back.join({ x: 44, y: 18, h: 180, z: 0 }); // closes the oval on the junction turnout

  // --- branch: up through the spiral loop
  const br = jn.div; br.on('L1');
  const gB = 2.4;
  br.c(R, 30 - N6.angle, gB);
  // straight to the crossing point O on y = 48
  const O = { x: br.x + (48 - br.y) / Math.tan(30 * DEG), y: 48 };
  const ap = br.s(Math.hypot(O.x - br.x, O.y - br.y), gB, 40);
  const LR = 22, beta = 30, tt = (LR / Math.sin(beta * DEG)) * Math.cos(beta * DEG);
  const in1 = br.s(tt, gB);
  br.c(LR, -(180 + 2 * beta), gB);
  const out1 = br.s(tt, gB); // arrives back over O
  br.on('L2');
  const after = br.s(14, gB);
  br.c(R, 30, gB);
  // west along the back of the interior to the mine town (flat)
  const runIn = br.s(10, 0);
  const zTown = br.z;
  const town = B.ladder(br, 'L', 1, 'x', 20);
  town.main.sTo('x', 20); const mineBump = town.main.bumper();

  // --- scenery
  const mtn = B.sc('mountain', O.x + tt / Math.cos(beta * DEG), 48, { w: 56, d: 52, h: 18, name: 'Spiral Mountain' });
  B.portals(mtn);
  B.spanOn('girder', out1, tt, { w: 12, name: 'Loop crossing' });
  const tr = B.spanOn('trestle', after, 7, { w: 13, name: 'Canyon trestle' });
  B.sc('river', tr.x, tr.y, { w: 13, d: 3.5, rot: tr.rot + 90, name: 'Canyon creek' });
  B.sc('station', 96, 6, { name: 'Valley City' });
  B.sc('platform', 96, 10.2, { w: 22 });
  B.sc('road', 60, 4, { w: 30 }); B.sc('road', 130, 4, { w: 30 });
  for (const [x, y] of [[66, 7], [74, 7], [120, 7], [128, 7]]) B.sc('house', x, y);
  for (const x of [60, 84, 108, 136]) B.sc('light', x, 2.5);
  B.sc('enginehouse', 46, 90, { name: 'Engine house' });
  B.sc('tower', 70, 91);
  B.sc('factory', 30, 69, { w: 12, d: 6, h: 6, base: zTown, name: 'Gold mine', color: '#7d6b55' });
  B.sc('house', 44, 74, { base: zTown }); B.sc('house', 52, 74, { base: zTown, rot: 90 });
  for (const [x, y] of [[90, 30], [86, 40], [100, 64], [112, 70], [16, 30], [22, 44], [182, 8], [182, 88], [8, 8], [8, 88], [124, 30], [126, 66]]) B.sc('pine', x, y);
  B.sc('water', 26, 34, { w: 12, d: 7, name: 'Valley lake' });

  // --- control
  B.dev('signal3', s1, 3, { name: 'SIG1', address: 'D4' });
  B.dev('signal3', s2, 3, { name: 'SIG2', address: 'D5' });
  B.dev('signal2', ap, 4, { name: 'SIG3', address: 'D6' });
  B.dev('sensor', in1, 6, { name: 'PS1', address: 'A0' });
  B.dev('sensor', runIn, 5, { name: 'PS2', address: 'A1' });
  B.dev('block', sid.mid, 10, { name: 'BLK siding', address: 'A2' });
  yard.tracks.forEach((t, i) => B.dev('home', t.b, 1, { name: `H${i + 1}`, address: `D${10 + i}` }));
  B.dev('feeder', s1, 8, { name: 'F main' });
  B.dev('feeder', ap, 10, { name: 'F branch' });
  B.dev('gap', ap, 0.5, { name: 'G branch' });
  return P;
}

// 3) Two-deck around-the-walls railroad joined by a 3¾-turn helix (inspired by
// multi-deck designs such as those in Tony Koester's books): lower-deck yard on the
// left wall, main along the back wall into a helix in the corner, and an upper-deck
// logging/mining terminal stacked above the lower deck.
function helixTwoDeck() {
  const outline = [[0, 0], [30, 0], [30, 102], [104, 102], [104, 57], [168, 57], [168, 132], [0, 132]];
  const P = base('Sample – Two-deck helix railroad (14×11 ft room)', outline, [
    { id: 'L0', name: 'Lower deck', elevation: 0, visible: true, color: '#3f6fb5' },
    { id: 'L1', name: 'Helix', elevation: 4, visible: true, color: '#7d5fb0' },
    { id: 'L2', name: 'Upper deck', elevation: 15.2, visible: true, color: '#b5523f' },
  ], { minRadius: 24, maxGrade: 2.5, clearance: 3.5 });
  const B = builder(P);
  // lower-deck yard: throat at the north end, tracks run south to bumpers
  const ys = new B.Turtle(19, 66, 270, 0);
  const yard = B.ladder(ys, 'L', 2, 'y', 8);
  const ad = yard.main; const adLast = ad.sTo('y', 8); ad.bumper(); // arrival/departure track
  // main north along the left wall, round the corner, along the back wall
  const m = new B.Turtle(19, 66, 90, 0);
  const m1 = m.s(21);
  m.c(30, -90, 0, 15);
  const m2 = m.sTo('x', 136);
  // helix: R28, 3.75 turns clockwise, 2.3% -> ~4" per turn
  const HR = 28, turns = 3.75, gH = 2.3;
  m.on('L1');
  const hx = [];
  for (let i = 0; i < turns * 4; i++) hx.push(m.c(HR, -90, gH, 30));
  m.on('L2');
  const zTop = m.z;
  // upper deck: north out of the helix, curve west, along the back wall above the lower deck
  const u1 = m.s(9);
  m.c(24, 90);
  const u2 = m.sTo('x', 32);
  m.c(24, 90);
  const u3 = m.sTo('y', 70);
  const town = B.ladder(m, 'L', 1, 'y', 10);
  const uEnd = town.main; uEnd.sTo('y', 10); uEnd.bumper();

  // scenery – lower deck town and yard
  B.sc('station', 50, 108, { name: 'Junction City' });
  B.sc('platform', 50, 113.6, { w: 18 });
  B.sc('factory', 76, 108, { w: 14, d: 7 });
  for (const [x, y] of [[90, 107], [97, 107]]) B.sc('house', x, y);
  // helix scenery: trees around the corner, a "Cascade" creek in front of it
  for (const [x, y] of [[110, 62], [162, 62], [162, 126], [110, 126], [136, 89], [130, 95], [142, 83]]) B.sc('pine', x, y);
  B.sc('river', 136, 60, { w: 50, d: 4, name: 'Cascade creek' });
  // upper deck: trestle over the corner, mine and logging camp at the terminal
  B.spanOn('trestle', u1, 4.5, { w: 9, name: 'Helix trestle' });
  B.spanOn('truss', u2, 20, { w: 18, name: 'Back-wall truss' });
  // the upper deck is a shelf along the walls, so its buildings sit on the wall side of its track
  B.sc('factory', 3.8, 28, { base: zTop, rot: 90, w: 10, d: 6.5, h: 6, color: '#7d6b55', name: 'Copper mine' });
  B.sc('house', 3.5, 44, { base: zTop, rot: 90, name: 'Bunkhouse' });
  B.sc('tower', 3.5, 58, { base: zTop });
  for (const [x, y] of [[3, 16], [3, 82], [40, 128.5], [70, 128.5], [95, 128.5]]) B.sc('pine', x, y, { base: zTop });
  B.sc('enginehouse', 26.5, 92, { rot: 90, w: 12, d: 5, name: 'Engine house' });

  // control
  B.dev('signal3', m1, 3, { name: 'SIG1', address: 'D4' });
  B.dev('signal3', m2, 4, { name: 'SIG2', address: 'D5' });
  B.dev('sensor', hx[0], 2, { name: 'PS helix in', address: 'A0' });
  B.dev('sensor', hx[hx.length - 1], 10, { name: 'PS helix out', address: 'A1' });
  B.dev('signal2', u1, 6, { name: 'SIG3', address: 'D6' });
  B.dev('block', u3, 10, { name: 'BLK upper', address: 'A2' });
  yard.tracks.forEach((t, i) => B.dev('home', t.b, 1, { name: `H${i + 1}`, address: `D${10 + i}` }));
  B.dev('home', town.tracks[0].b, 1, { name: 'H mine', address: 'D13' });
  B.dev('feeder', m1, 8, { name: 'F lower' });
  B.dev('feeder', u2, 10, { name: 'F upper' });
  return P;
}

export const SAMPLES = [
  {
    id: 'figure8', name: 'Over & under figure 8', size: '13 × 5 ft table',
    blurb: 'A figure 8 where one half climbs 4¼" so the track crosses over itself on a girder bridge. The low loop tunnels under a mountain; a trestle carries the climb across a gully.',
    features: ['2.3% continuous grade', 'girder bridge', 'trestle', 'tunnel through mountain'],
    build: figure8,
  },
  {
    id: 'spiral', name: 'Spiral loop mountain division', size: '16 × 8 ft island',
    blurb: 'Inspired by the Tehachapi Loop: a branch leaves the valley main, spirals through a mountain and passes over its own track before climbing on a canyon trestle to a mining town. The valley has a continuous main, passing siding, yard and engine terminal.',
    features: ['3 levels', 'track crosses over itself', 'tunnels', 'passing siding', '4-track yard', 'signals & sensors'],
    build: spiralLoop,
  },
  {
    id: 'helix', name: 'Two-deck helix railroad', size: '14 × 11 ft room',
    blurb: 'An around-the-walls, two-deck railroad. The lower-deck yard and main run along the walls into a 3¾-turn R28" helix in the corner; the upper deck crosses a trestle and a truss bridge and runs above the lower deck to a mine terminal.',
    features: ['helix (15" rise)', 'stacked decks', 'truss bridge', 'trestle', 'stub yards'],
    build: helixTwoDeck,
  },
];
