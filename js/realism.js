// Realism rules shared by the design checks, the 3D view and the test train.
//
// Everything here is plain geometry (no DOM / three.js) so it can be unit-tested in Node.
// Rules of thumb used (HO scale, inches):
//  * Overhead clearance: the tallest car (default 3" above the rail, NMRA's classic HO figure)
//    must clear the UNDERSIDE of anything above, so rail-to-rail separation must be at least
//    car height + thickness of the upper deck (track + roadbed + subroadbed).
//  * Curve drag: a curve adds about 32/R % of grade (John Allen's rule), so a 2% grade on a
//    24" curve behaves like 3.3%. Builders aim for <= 3% effective.
//  * Vertical easements: grade should change gradually (over ~1.5 car lengths). An abrupt
//    change at one joint is a kink that uncouples or derails cars.
//  * S-curves: reverse curves need a straight at least one car long between them unless
//    the curves are broad (30"+ radius).
//  * Track centres >= 2" on parallel track; cars overhang ~0.95" either side of centre.
import { state, getCache } from './model.js';
import { advance, segLen, toWorld, norm, DEG } from './geometry.js';

export const REAL_DEFAULTS = {
  carHeight: 3.0, // tallest car, top of rail to roof (in)
  deckThickness: 0.5, // track + roadbed + subroadbed of an upper level (in)
  carLength: 8, // longest car over couplers (in) ~ 58 scale ft
  maxEffGrade: 3.0, // warn above this effective (curve-compensated) grade (%)
};
export const R = {
  carHalfWidth: 0.95, // half the swept width of a car incl. curve overhang
  postHalf: 0.4, // half width of a support post
  sCurveRadius: 30, // reverse curves at or above this radius don't need a tangent
  kinkWarn: 1.0, // grade change at one joint that deserves an easement (%)
  kinkDerail: 2.0, // grade change at one joint that derails / uncouples (%)
  stallGrade: 4.0, // effective grade a typical train can't climb (%)
  minCentres: 2.0, // parallel track centres (in)
};
export const TURNOUT_KINDS = ['turnout', 'wye', 'curvedTurnout'];
export const settings = () => ({ ...REAL_DEFAULTS, ...state.project.settings });
export const neededHeadroom = (S = settings()) => S.carHeight + S.deckThickness;
export const tunnelCover = (S = settings()) => S.carHeight + 0.6; // bore + rock above it

// ---------------------------------------------------------------- track samples & index
function routeSamples(pc, route, step = 0.5) {
  const out = [];
  let p = { ...route.start }, d0 = 0;
  for (const s of route.segs) {
    const L = segLen(s), n = Math.max(1, Math.ceil(L / step));
    const k = s.r ? Math.sign(s.a) / s.r : 0;
    for (let i = out.length ? 1 : 0; i <= n; i++) {
      const f = i / n;
      const q = s.s !== undefined ? advance(p, { s: s.s * f }) : advance(p, { r: s.r, a: s.a * f });
      const w = toWorld(pc, q), d = d0 + L * f;
      out.push({ x: w.x, y: w.y, h: w.h, d, z: pc.z + (pc.grade / 100) * d, k: i === 0 && out.length ? out[out.length - 1].k : k });
    }
    p = advance(p, s); d0 += L;
  }
  return out;
}

const idxCache = new WeakMap();
export function trackIndex() {
  const C = getCache();
  if (idxCache.has(C)) return idxCache.get(C);
  const all = [], per = new Map(), grid = new Map(), cell = 3;
  for (const c of C.map.values()) {
    if (c.pc.kind === 'turntable') continue;
    c.g.routes.forEach((r, ri) => {
      const ss = routeSamples(c.pc, r);
      ss.forEach((s) => { s.id = c.pc.id; s.route = ri; all.push(s); });
      per.set(c.pc.id + '|' + ri, ss);
    });
  }
  for (const s of all) {
    const k = Math.floor(s.x / cell) + ',' + Math.floor(s.y / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const near = (x, y, rad) => {
    const out = [];
    for (let gx = Math.floor((x - rad) / cell); gx <= Math.floor((x + rad) / cell); gx++)
      for (let gy = Math.floor((y - rad) / cell); gy <= Math.floor((y + rad) / cell); gy++)
        for (const s of grid.get(gx + ',' + gy) || []) if (Math.hypot(s.x - x, s.y - y) <= rad) out.push(s);
    return out;
  };
  // pieces within n connections of each other (turnout throats, ladders, sidings converge legitimately)
  const hopCache = new Map();
  const hops = (id, n = 3) => {
    if (hopCache.has(id)) return hopCache.get(id);
    const seen = new Set([id]);
    let front = [id];
    for (let i = 0; i < n; i++) {
      const next = [];
      for (const f of front) for (const l of C.map.get(f)?.links || []) if (l && !seen.has(l.id)) { seen.add(l.id); next.push(l.id); }
      front = next;
    }
    hopCache.set(id, seen);
    return seen;
  };
  const idx = { all, per, near, hops, C };
  idxCache.set(C, idx);
  return idx;
}

// ---------------------------------------------------------------- terrain (hills & mountains)
export function hillBase(o, x, y) {
  const c = Math.cos(-(o.rot || 0) * DEG), s = Math.sin(-(o.rot || 0) * DEG);
  const dx = x - o.x, dy = y - o.y;
  const lx = (dx * c - dy * s) / (o.w / 2), ly = (dx * s + dy * c) / (o.d / 2);
  const q = 1 - lx * lx - ly * ly;
  // paraboloid: rounded summit, flanks that steepen towards the foot (~50° for a typical
  // mountain) but no vertical cliff at the edge the way a hemisphere would have
  return q > 0 ? (o.base || 0) + o.h * q : 0;
}
// within `pad` inches of a hill's footprint
const nearHill = (o, p, pad = 12) => { // covers the terrain mesh (+6") and the reach of fill slopes
  const c = Math.cos(-(o.rot || 0) * DEG), s = Math.sin(-(o.rot || 0) * DEG);
  const dx = p.x - o.x, dy = p.y - o.y;
  const lx = (dx * c - dy * s) / (o.w / 2 + pad), ly = (dx * s + dy * c) / (o.d / 2 + pad);
  return lx * lx + ly * ly <= 1;
};
// Deep enough under the hill to be a tunnel (bore height + some rock above it)
export const inTunnel = (o, s, S = settings()) => hillBase(o, s.x, s.y) > s.z + tunnelCover(S);

// ---- tunnels & cuttings, classified along whole connected runs of track
// Track is followed piece to piece (through plain track; turnouts end a run) so tunnels are
// judged by their length, not sample by sample:
//   T = tunnel (enough rock above for the bore), C = cutting (the slope covers the track but not
//   deep enough for a tunnel), F = free (track clear of the hill).
// Daylight gaps shorter than TUNNEL.mergeGap inside a tunnel are bored through; tunnels shorter
// than TUNNEL.minLength are opened out into a cutting. Mouths are where T meets C/F.
export const TUNNEL = { mergeGap: 16, minLength: 10 };

function trackChains(I) {
  const C = I.C, seen = new Set(), out = [];
  const plain = (c) => c && c.g.routes.length === 1 && ['straight', 'curve'].includes(c.pc.kind);
  const pts = (id, rev) => { const a = I.per.get(id + '|0'); return rev ? [...a].reverse() : a; };
  for (const c of C.map.values()) {
    c.g.routes.forEach((r, ri) => {
      const key = c.pc.id + '|' + ri;
      if (seen.has(key) || !I.per.has(key)) return;
      seen.add(key);
      if (!plain(c)) { out.push(I.per.get(key)); return; }
      // extend from the 'e' end forwards and from the 's' end backwards
      const walk = (startEnd) => {
        const list = [];
        let cur = c, end = startEnd;
        for (let guard = 0; guard < 2000; guard++) {
          const epi = cur.eps.findIndex((e) => e.refs.some((q) => q.end === end));
          const l = epi >= 0 ? cur.links[epi] : null;
          if (!l) break;
          const nc = C.map.get(l.id);
          if (!plain(nc) || seen.has(nc.pc.id + '|0')) break;
          seen.add(nc.pc.id + '|0');
          const inAt = nc.eps[l.ep].refs[0].end; // entering at 's' -> forward
          list.push({ id: nc.pc.id, rev: inAt === 'e' });
          cur = nc; end = inAt === 's' ? 'e' : 's';
        }
        return list;
      };
      const fwd = walk('e'), back = walk('s');
      const seq = [...back.reverse().map((q) => ({ id: q.id, rev: !q.rev })), { id: c.pc.id, rev: false }, ...fwd];
      const chain = [];
      for (const q of seq) for (const p of pts(q.id, q.rev)) chain.push(q.rev ? { ...p, h: p.h + 180 } : p);
      out.push(chain);
    });
  }
  for (const ch of out) { let acc = 0; ch.forEach((p, i) => { if (i) acc += Math.hypot(p.x - ch[i - 1].x, p.y - ch[i - 1].y); p.s = acc; }); }
  return out;
}

const tunCache = new WeakMap();
// For every hill: classified track samples and the tunnel mouths {x,y,z,h (heading out of the tunnel)}
export function tunnelInfo() {
  const I = trackIndex(), S = settings();
  const key = JSON.stringify(state.project.scenery.filter((o) => o.shape === 'hill')) + S.carHeight;
  const c = tunCache.get(I);
  if (c && c.key === key) return c.res;
  const cover = tunnelCover(S), chains = trackChains(I), res = new Map();
  for (const o of state.project.scenery) {
    if (o.shape !== 'hill') continue;
    const tun = [], cut = [], mouths = [];
    for (const ch of chains) {
      const st = ch.map((p) => { const b = hillBase(o, p.x, p.y); return b > p.z + cover ? 'T' : b > p.z - 0.3 ? 'C' : 'F'; });
      // 'cut' = every open (non-tunnel) sample near the hill: the ground is kept below its rails
      if (!st.includes('T')) { ch.forEach((p) => nearHill(o, p) && cut.push(p)); continue; }
      const runs = [];
      st.forEach((v, i) => { const t = v === 'T'; if (!runs.length || runs[runs.length - 1].t !== t) runs.push({ t, a: i, b: i }); else runs[runs.length - 1].b = i; });
      const len = (r) => ch[r.b].s - ch[r.a].s;
      runs.forEach((r, k) => { if (!r.t && k > 0 && k < runs.length - 1 && len(r) < TUNNEL.mergeGap) r.t = true; }); // bore through short daylight
      const merged = [];
      for (const r of runs) { const m = merged[merged.length - 1]; if (m && m.t === r.t) m.b = r.b; else merged.push({ ...r }); }
      for (const r of merged) if (r.t && len(r) < TUNNEL.minLength) r.t = false; // too short: open cutting
      for (const r of merged) for (let i = r.a; i <= r.b; i++) {
        const p = ch[i];
        if (r.t) tun.push(p); else if (nearHill(o, p)) cut.push(p);
      }
      merged.forEach((r, k) => {
        if (!r.t) return;
        if (k > 0) { const p = ch[r.a - 1] || ch[r.a]; mouths.push({ x: p.x, y: p.y, z: p.z, h: p.h + 180, hill: o.id }); }
        if (k < merged.length - 1) { const p = ch[r.b + 1] || ch[r.b]; mouths.push({ x: p.x, y: p.y, z: p.z, h: p.h, hill: o.id }); }
      });
    }
    for (const p of cut) { const b = hillBase(o, p.x, p.y); p.onSlope = b > 0.2 && b > p.z - 2.5; }
    res.set(o.id, { tun, cut, mouths });
  }
  tunCache.set(I, { key, res });
  return res;
}
// Portals the 3D view draws at every tunnel mouth (same size the clearance checks use)
export function autoPortals() {
  const out = [];
  for (const [, t] of tunnelInfo()) for (const m of t.mouths)
    out.push({ id: 'auto-' + m.hill + '-' + Math.round(m.x) + ',' + Math.round(m.y), type: 'portal', shape: 'portal', name: 'Tunnel portal', x: m.x, y: m.y, rot: norm(m.h + 90), w: 4.2, d: 1, h: 4.2, base: m.z, color: '#80786c', props: { name: 'Tunnel portal' }, auto: true });
  return out;
}

// Terrain height: the hill (with some rock texture), with railway earthworks: hillside fill,
// rock cuttings that stop at the portal face, and rock kept above every tunnel bore.
const rock = (o, x, y) => (Math.sin(x * 0.9) * Math.cos(y * 0.7) + Math.sin(x * 0.31 + y * 0.53) + 2) * 0.03 * o.h;
export function hillHeightFn(o) {
  const S = settings(), cover = tunnelCover(S);
  const info = tunnelInfo().get(o.id) || { tun: [], cut: [] };
  const bucket = (list) => { const g = new Map(); for (const p of list) { const k = Math.floor(p.x / 4) + ',' + Math.floor(p.y / 4); if (!g.has(k)) g.set(k, []); g.get(k).push(p); } return g; };
  const T = bucket(info.tun), Cg = bucket(info.cut);
  const around = (g, x, y, fn, cone = false) => {
    // window large enough for every slope to run out to natural ground (rock cut up to the
    // summit of a 26" mountain at 1:0.5 reaches ~15")
    for (let gx = Math.floor((x - 16) / 4); gx <= Math.floor((x + 16) / 4); gx++)
      for (let gy = Math.floor((y - 16) / 4); gy <= Math.floor((y + 16) / 4); gy++)
        for (const p of g.get(gx + ',' + gy) || []) {
          const dx = x - p.x, dy = y - p.y;
          if (dx * dx + dy * dy > 256) continue;
          const c = Math.cos(p.h * DEG), s = Math.sin(p.h * DEG);
          const along = dx * c + dy * s;
          const lat = Math.abs(-dx * s + dy * c);
          // cross-section of the track at this sample (widening with distance so strips still
          // overlap on the outside of curves – no slivers of hill left standing between them)
          if (cone) { fn(p, Math.hypot(dx, dy)); continue; }
          if (Math.abs(along) > 0.3 + lat * 0.06) continue;
          fn(p, lat);
        }
  };
  return (x, y) => {
    let h = hillBase(o, x, y);
    if (h > 0) h += rock(o, x, y) * Math.min(1, h / 6); // texture fades out towards the foot
    // Earthworks in the order a railway builds them:
    // 1) on a hillside the downhill side is built up as an embankment (1:1.5 fill slope) so the
    //    track bed sits on ground, not on a ledge hanging over the slope
    //    (measured as a plain distance, so an embankment also ends in a sloped end, not a wall)
    around(Cg, x, y, (p, dist) => { if (p.onSlope) { const fill = p.z - 0.15 - Math.max(0, dist - 1.6) * 0.67; if (fill > h) h = fill; } }, true);
    // 2) cuttings: formation 3.2" wide; rock-cut sides at 1:0.5 (63°), as railways cut through
    //    mountains, so the cut meets the natural slope instead of carving away the hill
    around(Cg, x, y, (p, lat) => { const allowed = p.z - 0.15 + Math.max(0, lat - 1.6) * 2; if (allowed < h) h = allowed; });
    // 3) tunnels: rock (or a retaining wall) stays above the bore, even next to another cutting
    around(T, x, y, (p, lat) => { const need = p.z + cover + 0.4 - Math.max(0, lat - 2.4) * 2; if (need > h) h = need; });
    // 4) the formation of every open track stays clear
    around(Cg, x, y, (p, lat) => { if (lat <= 1.6 && h > p.z - 0.15) h = p.z - 0.15; });
    return Math.max(0, h);
  };
}

// Ground height at a point (board = 0, hills with their earthworks)
const hfCache = new WeakMap();
export function groundAt(x, y) {
  const info = tunnelInfo();
  let fns = hfCache.get(info);
  if (!fns) { fns = state.project.scenery.filter((o) => o.shape === 'hill').map((o) => hillHeightFn(o)); hfCache.set(info, fns); }
  let g = 0;
  for (const f of fns) g = Math.max(g, f(x, y));
  return g;
}
// Buildings, trees and lights stand on the ground: a base below the terrain is raised to it
const SITS = ['box', 'cyl', 'pine', 'tree', 'light'];
export function seated(o) {
  if (!SITS.includes(o.shape)) return o;
  const g = groundAt(o.x, o.y);
  return g > (o.base || 0) + 0.05 ? { ...o, base: Math.round(g * 100) / 100 } : o;
}

// ---------------------------------------------------------------- structures
const SPANS = ['bridge', 'trestle'];
function toLocalObj(o, x, y) {
  const c = Math.cos(-(o.rot || 0) * DEG), s = Math.sin(-(o.rot || 0) * DEG);
  const dx = x - o.x, dy = y - o.y;
  return { lx: dx * c - dy * s, ly: dx * s + dy * c };
}
export function underSpan(p) {
  for (const o of state.project.scenery) {
    if (!SPANS.includes(o.shape)) continue;
    const { lx, ly } = toLocalObj(o, p.x, p.y);
    if (Math.abs(lx) <= o.w / 2 + 0.5 && Math.abs(ly) <= o.d / 2 + 0.5 && Math.abs((o.base || 0) - p.z) < 0.6) return o;
  }
  return null;
}
export const trestleBents = (o) => {
  const n = Math.max(2, Math.round(o.w / 1.8));
  return Array.from({ length: n + 1 }, (_, i) => -o.w / 2 + (o.w * i) / n);
};
export const trestleSpread = (o) => Math.min(1.6, 0.25 + Math.max(0, (o.base || 0) - 0.8) * 0.12);

// Solid parts of a scenery item as boxes in the item's local frame:
// {lx, ly, hw, hd, z0, z1, part}. Used for "does the train hit this?".
export function obstacleBoxes(o) {
  const b = o.base || 0, out = [];
  const box = (lx, ly, hw, hd, z0, z1, part) => out.push({ lx, ly, hw, hd, z0, z1, part });
  switch (o.shape) {
    case 'box': case 'cyl': box(0, 0, o.w / 2, o.d / 2, b, b + o.h, ''); break;
    case 'pine': case 'tree': box(0, 0, o.w * 0.35, o.d * 0.35, b, b + o.h, ''); break;
    case 'light': box(0, 0, 0.25, 0.25, b, b + o.h, ''); break;
    case 'portal': {
      const ow = portalOpening(o);
      const side = (o.w - ow.w) / 4;
      box(-(ow.w / 2 + side), 0, side, o.d / 2, b, b + o.h, ' (side wall)');
      box(ow.w / 2 + side, 0, side, o.d / 2, b, b + o.h, ' (side wall)');
      box(0, 0, o.w / 2, o.d / 2, b + ow.h, b + o.h, ' (arch)');
      break;
    }
    case 'bridge': {
      if (b > 0.9) for (const sx of [-1, 1]) box(sx * o.w / 2, 0, 0.6, o.d / 2 + 0.4, 0, b - 0.6, ' (abutment)');
      if (o.style === 'truss') {
        const top = Math.max(2, o.h);
        for (const sy of [-1, 1]) box(0, sy * o.d / 2, o.w / 2, 0.12, b - 0.6, b - 0.6 + top, ' (truss side)');
        box(0, 0, o.w / 2 - Math.max(3, o.w / Math.max(3, Math.round(o.w / 3))), o.d / 2, b - 0.6 + top - 0.1, b - 0.6 + top + 0.1, ' (overhead bracing)');
      } else {
        const gh = Math.max(0.8, o.h);
        for (const sy of [-1, 1]) box(0, sy * o.d / 2, o.w / 2, 0.1, b - 0.75, b - 0.75 + gh, ' (girder)');
      }
      break;
    }
    case 'trestle': {
      if (b < 0.9) break;
      const spread = trestleSpread(o);
      for (const x of trestleBents(o)) box(x, 0, 0.12, o.d / 2 + 0.2 + spread, 0, b - 0.8, ' (bent)');
      break;
    }
  }
  return out;
}
export const portalOpening = (o) => ({ w: Math.min(o.w - 0.6, Math.max(o.w * 0.6, 0)), h: Math.max(0, o.h - 0.85) });

// ---------------------------------------------------------------- supports under raised track
// A post straight down is used where it is clear of every track below; otherwise a bent with a
// post either side (like a real helix or a deck above a deck); otherwise a single bracket.
const postFouls = (I, x, y, top, selfId) => I.near(x, y, R.carHalfWidth + R.postHalf + 0.05)
  .some((q) => q.z < top - 0.25 && !(q.id === selfId && Math.abs(q.z - top) < 1));

// true where a hill carries the track (cutting, hillside shelf or embankment): no roadbed or posts
export function onTerrain(p) {
  return state.project.scenery.some((o) => o.shape === 'hill' && hillBase(o, p.x, p.y) > p.z - 2.5);
}

export function supports() {
  const I = trackIndex(), S = settings(), out = [], gaps = [];
  const hills = state.project.scenery.filter((o) => o.shape === 'hill');
  for (const [key, pts] of I.per) {
    const id = key.split('|')[0];
    let lastD = null;
    for (let i = 0; i < pts.length; i += 16) {
      const p = pts[i];
      if (p.z < 0.8) { lastD = p.d; continue; }
      if (underSpan(p) || hills.some((o) => hillBase(o, p.x, p.y) > p.z - 2.5)) { lastD = p.d; continue; }
      const top = p.z - 0.6;
      const nx = -Math.sin(p.h * DEG), ny = Math.cos(p.h * DEG);
      if (!postFouls(I, p.x, p.y, top, id)) { out.push({ posts: [{ x: p.x, y: p.y }], top, at: p }); lastD = p.d; continue; }
      const off = 2.3;
      const sides = [1, -1].map((s) => ({ x: p.x + nx * off * s, y: p.y + ny * off * s })).filter((q) => !postFouls(I, q.x, q.y, top, id));
      if (sides.length) { out.push({ posts: sides, top, at: p, cap: sides.length === 2 ? sides : [p, sides[0]] }); lastD = p.d; }
      else if (lastD !== null && p.d - lastD > 30) { gaps.push({ id, at: p, len: p.d - lastD }); lastD = p.d; }
    }
  }
  return { supports: out, gaps, S };
}

// ---------------------------------------------------------------- hazards / analysis
const kindAt = (t) => (t === 'derail' ? 'error' : t === 'stop' ? 'warn' : 'info');
const anaCache = new WeakMap();

// Returns { issues:[{level,msg,at,id}], hazards: Map('id|route' -> [{d0,d1,type,msg,at,climb}]) }
export function analyse() {
  const C = getCache();
  const key = JSON.stringify(state.project.settings) + JSON.stringify(state.project.scenery);
  const cached = anaCache.get(C);
  if (cached && cached.key === key) return cached.res;
  const P = state.project, S = settings(), I = trackIndex();
  const issues = [], hz = new Map();
  const need = neededHeadroom(S);
  const addHz = (s, type, msg, extra = {}) => {
    const k = s.id + '|' + s.route;
    if (!hz.has(k)) hz.set(k, []);
    const list = hz.get(k);
    const same = list.find((h) => h.msg === msg && s.d >= h.d0 - 1.01 && s.d <= h.d1 + 1.01);
    if (same) { same.d0 = Math.min(same.d0, s.d); same.d1 = Math.max(same.d1, s.d); return; }
    list.push({ d0: s.d, d1: s.d, type, msg, at: { x: s.x, y: s.y, z: s.z }, ...extra });
  };
  const issueOnce = new Set();
  const issue = (level, msg, at, id, dedupe = msg + id) => { if (issueOnce.has(dedupe)) return; issueOnce.add(dedupe); issues.push({ level, msg, at, id }); };

  for (const s of I.all) {
    // overhead: anything above whose underside is lower than the tallest car
    for (const q of I.near(s.x, s.y, 1.9)) {
      if (q.id === s.id) continue;
      const dz = q.z - s.z;
      if (dz > 0.3 && dz < need) {
        const msg = `Train hits the track above: only ${(dz - S.deckThickness).toFixed(2)}" under the upper deck, tallest car needs ${S.carHeight}" (${need.toFixed(2)}" rail to rail)`;
        addHz(s, 'derail', msg);
        issue('error', msg, s, s.id, 'oh' + s.id + q.id);
        break;
      }
    }
    // effective grade on curves (climbing direction matters for the train)
    const pc = I.C.map.get(s.id).pc;
    const eff = Math.abs(pc.grade) + 32 * Math.abs(s.k);
    if (pc.grade && s.k && eff > S.maxEffGrade + 0.005)
      issue('warn', `Effective grade ${eff.toFixed(2)}% on this R${(1 / Math.abs(s.k)).toFixed(0)}" curve (${Math.abs(pc.grade).toFixed(2)}% + 32/R curve drag) is over ${S.maxEffGrade}%`, s, s.id, 'eff' + s.id);
    if (eff > R.stallGrade && pc.grade) addHz(s, 'stop', `Train stalls: ${eff.toFixed(1)}% effective grade (${Math.abs(pc.grade).toFixed(1)}% grade${s.k ? ` + ${(32 * Math.abs(s.k)).toFixed(1)}% curve drag` : ''})`, { climb: Math.sign(pc.grade) });
    // radius below minimum: long cars derail
    if (s.k && 1 / Math.abs(s.k) < S.minRadius - 0.01) addHz(s, 'derail', `Derailed on a ${(1 / Math.abs(s.k)).toFixed(0)}" radius curve – long cars need at least ${S.minRadius}"`);
  }

  // parallel tracks too close (sideswipe), excluding tracks that legitimately converge at turnouts
  for (const s of I.all) {
    if (Math.round(s.d * 2) % 4) continue; // every 2"
    for (const q of I.near(s.x, s.y, R.minCentres - 0.15)) {
      if (q.id === s.id || I.hops(s.id).has(q.id) || Math.abs(q.z - s.z) >= S.carHeight) continue;
      if (Math.abs(Math.sin((q.h - s.h) * DEG)) > 0.34) continue; // crossing, handled elsewhere
      issue('warn', `Track centres only ${Math.hypot(q.x - s.x, q.y - s.y).toFixed(2)}" apart – cars on these tracks would sideswipe (need ${R.minCentres}")`, s, s.id, 'sw' + [s.id, q.id].sort().join());
      break;
    }
  }

  // vertical kinks at joints
  for (const c of I.C.map.values()) {
    c.eps.forEach((e, i) => {
      const l = c.links[i];
      if (!l || l.id < c.pc.id) return; // each joint once
      const o = I.C.map.get(l.id);
      const r1 = e.refs[0], r2 = o.eps[l.ep].refs[0];
      const out1 = (r1.end === 'e' ? 1 : -1) * c.pc.grade, in2 = (r2.end === 's' ? 1 : -1) * o.pc.grade;
      const dg = Math.abs(out1 - in2);
      if (dg > R.kinkWarn + 0.01) issue(dg > R.kinkDerail ? 'error' : 'warn', `Vertical kink: grade changes ${dg.toFixed(2)}% at one joint – add a vertical easement (spread the change over ~${(S.carLength * 1.5).toFixed(0)}")`, e, c.pc.id);
    });
  }

  // S-curves (probe walk across every piece in both directions)
  for (const c of I.C.map.values()) {
    if (c.pc.kind === 'turntable' || c.pc.kind === 'bumper') continue;
    c.g.routes.forEach((r, ri) => {
      for (const dir of [1, -1]) {
        const t = { pieceId: c.pc.id, route: ri, d: dir > 0 ? 0 : r.len, dir, curv: null, straight: Infinity, probe: true };
        const ev = runFor(t, r.len + S.carLength * 1.2, { hz: new Map(), S, I, geomOnly: true });
        if (ev && ev.kind === 'scurve') issue('warn', ev.msg, ev.at, ev.id, 'sc' + Math.round(ev.at.x) + ',' + Math.round(ev.at.y));
      }
    });
  }

  // scenery: fouling, floating, bridges, water (auto portals at tunnel mouths included)
  for (const o of [...P.scenery.map(seated), ...autoPortals()]) {
    const label = o.props?.name || o.name;
    const boxes = obstacleBoxes(o);
    const reach = Math.max(o.w, o.d) / 2 + 4;
    const nearby = I.near(o.x, o.y, reach);
    for (const b of boxes) {
      for (const s of nearby) {
        const { lx, ly } = toLocalObj(o, s.x, s.y);
        if (Math.abs(lx - b.lx) > b.hw + R.carHalfWidth || Math.abs(ly - b.ly) > b.hd + R.carHalfWidth) continue;
        if (b.z1 <= s.z + 0.05 || b.z0 >= s.z + S.carHeight) continue;
        const msg = `${label}${b.part} is in the way of the train`;
        addHz(s, 'derail', `Hit ${label}${b.part}`);
        issue('error', msg, s, o.id, 'foul' + o.id + b.part + s.id);
      }
    }
    if (SPANS.includes(o.shape)) {
      const carried = nearby.some((s) => { const { lx, ly } = toLocalObj(o, s.x, s.y); return Math.abs(lx) <= o.w / 2 && Math.abs(ly) < 0.6 && Math.abs(s.z - (o.base || 0)) < 0.5; });
      if (!carried) issue('warn', `${label} doesn't carry any track – line it up with the track and set its base to the track height`, o, o.id);
    }
    if (['box', 'cyl', 'pine', 'tree', 'light'].includes(o.shape) && (o.base || 0) > 0.5) {
      const onTrackLevel = I.near(o.x, o.y, 14).some((s) => Math.abs(s.z - o.base) < 1.2);
      const onHill = groundAt(o.x, o.y) >= o.base - 0.5;
      if (!onTrackLevel && !onHill) issue('warn', `${label} is floating ${o.base}" in the air – nothing at that height supports it`, o, o.id);
    }
    if (o.shape === 'water' || o.shape === 'river') {
      for (const s of nearby) {
        if (s.z > 0.4 || underSpan(s)) continue;
        const { lx, ly } = toLocalObj(o, s.x, s.y);
        const inside = o.shape === 'river' ? Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.d / 2 : (lx / (o.w / 2)) ** 2 + (ly / (o.d / 2)) ** 2 <= 1;
        if (!inside) continue;
        addHz(s, 'stop', `Track runs into ${label} – it needs a bridge`);
        issue('warn', `Track runs through ${label} – raise it on a bridge or move the water`, s, o.id, 'wet' + o.id);
      }
    }
  }

  // raised track with no room for supports
  for (const g of supports().gaps) issue('info', `About ${g.len.toFixed(0)}" of raised track has no room for supports below – use a bridge here`, g.at, g.id);

  for (const list of hz.values()) list.sort((a, b) => a.d0 - b.d0);
  const res = { issues, hazards: hz };
  anaCache.set(C, { key, res });
  return res;
}

// ---------------------------------------------------------------- train movement
// t: {pieceId, route, d, dir, curv, straight}. Moves t by `dist` along the track following
// turnout settings. Returns null or an event {kind, msg, at, id}:
//   kind 'end'    – reached a bumper / stall end; the train reverses (not a failure)
//   kind 'derail' – derailment or collision; 'stop' – train cannot continue (stall, water)
//   kind 'scurve' – (also a derail) reported separately so checks can label it
// opts.autoAlign: line trailing turnouts for the train (like a dispatcher) instead of running through them
export function moveTrain(t, dist, opts = {}) {
  const { hazards } = analyse();
  return runFor(t, dist, { hz: hazards, S: settings(), I: trackIndex(), ...opts });
}

function curvatureAt(c, route, d) {
  const r = c.g.routes[route];
  let acc = 0;
  for (const s of r.segs) { const L = segLen(s); if (d <= acc + L + 1e-9) return s.r ? Math.sign(s.a) / s.r : 0; acc += L; }
  return 0;
}
function posOf(I, id, route, d) {
  const pts = I.per.get(id + '|' + route);
  if (!pts) return { x: 0, y: 0, z: 0 };
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.d - d) < Math.abs(best.d - d)) best = p;
  return { x: best.x, y: best.y, z: best.z };
}

function runFor(t, dist, ctx) {
  const { I, S, hz } = ctx;
  const C = I.C;
  let left = dist, guard = 0;
  while (left > 1e-6 && guard++ < 5000) {
    let c = C.map.get(t.pieceId);
    if (!c) return { kind: 'derail', msg: 'Track removed under the train', at: { x: 0, y: 0, z: 0 } };
    const L = c.g.routes[t.route].len;
    const stepLen = Math.min(left, 0.5);
    let nd = t.d + stepLen * t.dir;
    if (nd >= -1e-9 && nd <= L + 1e-9) {
      nd = Math.max(0, Math.min(L, nd));
      const ev = atPoint(t, c, nd, stepLen, ctx);
      t.d = nd; left -= stepLen;
      if (ev) return ev;
      continue;
    }
    // crossing a joint
    const used = t.dir > 0 ? L - t.d : t.d;
    left -= Math.max(0, used);
    t.d = t.dir > 0 ? L : 0;
    const end = t.dir > 0 ? 'e' : 's';
    const epi = c.eps.findIndex((e) => e.refs.some((r) => r.route === t.route && r.end === end));
    const here = posOf(I, c.pc.id, t.route, t.d);
    if (epi < 0) { // bumper or turntable stall end
      t.dir *= -1;
      return ctx.geomOnly ? null : { kind: 'end', msg: c.pc.kind === 'bumper' ? 'Stopped at the bumper' : 'End of the line', at: here, id: c.pc.id };
    }
    const link = c.links[epi];
    if (!link) {
      if (ctx.geomOnly) return null;
      const e = c.eps[epi];
      let near = null;
      for (const o of C.map.values()) if (o !== c) o.eps.forEach((q, k) => { if (!o.links[k] && Math.hypot(q.x - e.x, q.y - e.y) < 1 && Math.abs(q.z - e.z) < 1.5) near = { q, o }; });
      const msg = near
        ? `Derailed at a bad joint: rails are ${Math.hypot(near.q.x - e.x, near.q.y - e.y).toFixed(2)}" apart, ${Math.abs(Math.abs(norm(near.q.h - e.h)) - 180).toFixed(1)}° out of line, ${Math.abs(near.q.z - e.z).toFixed(2)}" height step`
        : 'Ran off the end of the track (no bumper)';
      return { kind: 'derail', msg, at: here, id: c.pc.id };
    }
    const nc = C.map.get(link.id);
    const ep = nc.eps[link.ep];
    const st = nc.pc.state || 0;
    const ref = ep.refs.find((r) => r.route === st) || ep.refs[0];
    // grade change at the joint
    const slopeOut = t.dir * c.pc.grade;
    const newDir = ref.end === 's' ? 1 : -1;
    const slopeIn = newDir * nc.pc.grade;
    let enteringLeg = ep.refs.length === 1 && TURNOUT_KINDS.includes(nc.pc.kind) && ref.route !== st;
    if (enteringLeg && ctx.autoAlign) { nc.pc.state = ref.route; enteringLeg = false; }
    t.pieceId = nc.pc.id; t.route = ref.route; t.dir = newDir;
    t.d = ref.end === 's' ? 0 : nc.g.routes[ref.route].len;
    if (ctx.geomOnly) continue;
    if (enteringLeg) return { kind: 'derail', msg: `Ran through turnout ${nc.pc.props?.name || ''} set against the train – throw it before a trailing move`, at: here, id: nc.pc.id };
    if (Math.abs(slopeOut - slopeIn) > R.kinkDerail + 0.01) return { kind: 'derail', msg: `Uncoupled/derailed at a vertical kink: grade jumps ${Math.abs(slopeOut - slopeIn).toFixed(1)}% at one joint`, at: here, id: nc.pc.id };
  }
  return null;
}

function atPoint(t, c, d, stepLen, ctx) {
  const { S, hz, I } = ctx;
  // S-curve memory
  const k = curvatureAt(c, t.route, d) * t.dir;
  if (k) {
    const sg = Math.sign(k), r = 1 / Math.abs(k);
    if (t.curv && t.curv.sign !== sg && t.straight < S.carLength && Math.min(r, t.curv.r) < R.sCurveRadius) {
      const at = posOf(I, c.pc.id, t.route, d);
      const msg = `S-curve: R${t.curv.r.toFixed(0)}" and R${r.toFixed(0)}" reverse curves with only ${t.straight.toFixed(1)}" of straight between – long cars derail (need ≥ ${S.carLength}")`;
      t.curv = { sign: sg, r }; t.straight = 0;
      return { kind: ctx.geomOnly ? 'scurve' : 'derail', msg, at, id: c.pc.id };
    }
    t.curv = { sign: sg, r }; t.straight = 0;
  } else if (t.curv) t.straight += stepLen;
  if (ctx.geomOnly) return null;
  for (const h of hz.get(c.pc.id + '|' + t.route) || []) {
    if (d < h.d0 - 0.26 || d > h.d1 + 0.26) continue;
    if (h.climb && h.climb !== t.dir) continue; // stalls only when climbing
    return { kind: h.type, msg: h.msg, at: h.at, id: c.pc.id };
  }
  return null;
}

// Issues for the Checks panel
export function realismIssues() { return analyse().issues; }
