// Project state, track graph, undo/redo and persistence.
import { TRACK_BY_ID, buildGeometry, BOARD_PRESETS } from './catalog.js';
import { toWorld, routeEnd, routeLen, sampleRoute, poseAt, norm, dist } from './geometry.js';

let nextId = 1;
export const uid = (p) => `${p}${(nextId++).toString(36)}`;

export function newProject() {
  const preset = BOARD_PRESETS.myL;
  return {
    version: 1,
    name: 'My HO layout',
    units: 'in',
    board: { outline: preset.make(preset.fields), thickness: 0.75, color: '#c9a66b' },
    levels: [
      { id: 'L0', name: 'Lower level', elevation: 0, visible: true, color: '#3f6fb5' },
      { id: 'L1', name: 'Upper level', elevation: 4, visible: true, color: '#b5523f' },
    ],
    activeLevel: 'L0',
    settings: { minRadius: 18, maxGrade: 2.5, clearance: 3.5, carHeight: 3, deckThickness: 0.5, carLength: 8, maxEffGrade: 3, snap: true, grid: 1 },
    pieces: [],
    devices: [],
    scenery: [],
  };
}

export const state = {
  project: newProject(),
  selection: new Set(), // ids
  target: null, // {pieceId, ep} selected free endpoint to attach to
  lastAttach: null,
  grade: 0, // % grade applied when laying new track
  listeners: new Set(),
};

export function emit(what = 'all') { for (const f of state.listeners) f(what); }

// ---------- undo ----------
const undo = [], redo = [];
export function commit() {
  undo.push(JSON.stringify(state.project));
  if (undo.length > 150) undo.shift();
  redo.length = 0;
  invalidate();
  autosave();
}
export function doUndo() {
  if (!undo.length) return;
  redo.push(JSON.stringify(state.project));
  state.project = JSON.parse(undo.pop());
  state.selection.clear(); state.target = null;
  invalidate(); autosave(); emit();
}
export function doRedo() {
  if (!redo.length) return;
  undo.push(JSON.stringify(state.project));
  state.project = JSON.parse(redo.pop());
  state.selection.clear(); state.target = null;
  invalidate(); autosave(); emit();
}
// Snapshot BEFORE a change: call begin() then mutate then emit.
export function begin() {
  undo.push(JSON.stringify(state.project));
  if (undo.length > 150) undo.shift();
  redo.length = 0;
}
export function changed(what) { invalidate(); autosave(); emit(what); }

// ---------- geometry cache ----------
let cache = null;
export function invalidate() { cache = null; }

export function pieceGeom(pc) {
  const g = buildGeometry(pc.kind, pc.params);
  g.routes.forEach((r) => (r.len = routeLen(r)));
  return g;
}

// Endpoints of a piece in world coords, deduplicated.
// Each: {x,y,h(outward),z, refs:[{route, end:'s'|'e'}]}
export function pieceEndpoints(pc, g = pieceGeom(pc)) {
  const eps = [];
  const add = (lp, h, z, ref) => {
    const w = toWorld(pc, lp);
    const found = eps.find((e) => Math.hypot(e.x - w.x, e.y - w.y) < 0.02 && Math.abs(norm(e.h - (h + pc.rot))) < 1);
    if (found) found.refs.push(ref);
    else eps.push({ x: w.x, y: w.y, h: norm(h + pc.rot), z, refs: [ref] });
  };
  g.routes.forEach((r, i) => {
    if (r.ends !== 'end') add(r.start, r.start.h + 180, pc.z, { route: i, end: 's' });
    if (r.ends !== 'start') { const e = routeEnd(r); add(e, e.h, pc.z + (pc.grade / 100) * r.len, { route: i, end: 'e' }); }
  });
  return eps;
}

export function getCache() {
  if (cache) return cache;
  const P = state.project;
  const map = new Map();
  for (const pc of P.pieces) {
    const g = pieceGeom(pc);
    const eps = pieceEndpoints(pc, g);
    const samples = g.routes.map((r) => sampleRoute(r, 0.5).map((s) => {
      const w = toWorld(pc, s);
      return { x: w.x, y: w.y, h: w.h, z: pc.z + (pc.grade / 100) * s.d, d: s.d };
    }));
    map.set(pc.id, { pc, g, eps, samples, links: eps.map(() => null) });
  }
  // connections
  const all = [];
  for (const c of map.values()) c.eps.forEach((e, i) => all.push({ c, e, i }));
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const A = all[a], B = all[b];
      if (A.c === B.c) continue;
      if (Math.abs(A.e.x - B.e.x) > 0.06 || Math.abs(A.e.y - B.e.y) > 0.06) continue;
      if (Math.abs(Math.abs(norm(A.e.h - B.e.h)) - 180) > 1.5) continue;
      if (Math.abs(A.e.z - B.e.z) > 0.1) continue;
      A.c.links[A.i] = { id: B.c.pc.id, ep: B.i };
      B.c.links[B.i] = { id: A.c.pc.id, ep: A.i };
    }
  }
  cache = { map };
  return cache;
}

export function freeEndpoints(excludeId) {
  const out = [];
  for (const c of getCache().map.values()) {
    if (c.pc.id === excludeId) continue;
    // an end joined only to the excluded piece counts as free: while dragging, the piece's own
    // snap must not "use up" the end it is snapping to (otherwise the next mouse move drops the
    // snap and the piece falls back to its old height)
    c.eps.forEach((e, i) => { const l = c.links[i]; if (!l || l.id === excludeId) out.push({ pieceId: c.pc.id, ep: i, ...e }); });
  }
  return out;
}

// ---------- track operations ----------
export function makePiece(catId, level) {
  const cat = TRACK_BY_ID[catId];
  const lv = state.project.levels.find((l) => l.id === (level || state.project.activeLevel));
  return {
    id: uid('t'), cat: catId, kind: cat.kind, params: { ...cat.params },
    x: 0, y: 0, rot: 0, z: lv ? lv.elevation : 0, grade: 0,
    level: lv ? lv.id : 'L0', state: 0, props: { name: '', address: '', motor: '' },
  };
}

const gradeable = (pc) => pc.kind === 'straight' || pc.kind === 'curve';

// Align piece endpoint k to world endpoint T (outward heading T.h)
export function alignTo(pc, k, T, gradePct = 0, keepGrade = false) {
  const g0 = pc.grade;
  pc.rot = 0; pc.x = 0; pc.y = 0; pc.z = 0; pc.grade = 0;
  let eps = pieceEndpoints(pc);
  const e = eps[k % eps.length];
  pc.rot = norm(T.h + 180 - e.h);
  eps = pieceEndpoints(pc);
  const e2 = eps[k % eps.length];
  pc.x += T.x - e2.x; pc.y += T.y - e2.y;
  const ref = e2.refs[0];
  if (keepGrade) pc.grade = g0;
  else if (gradeable(pc) && gradePct) pc.grade = ref.end === 's' ? gradePct : -gradePct;
  const len = pieceGeom(pc).routes[ref.route].len;
  pc.z = T.z - (ref.end === 'e' ? (pc.grade / 100) * len : 0);
}

// Slope (%) of the track as you travel OUT of a piece through endpoint `epIndex`
// (positive = still climbing in that direction).
export function slopeOut(c, epIndex) {
  const r = c?.eps[epIndex]?.refs[0];
  return r ? (r.end === 'e' ? 1 : -1) * c.pc.grade : 0;
}
// Laying grade for the next piece. state.grade is 'auto' (keep following the grade of the track
// you're extending) or a target grade in %. The grade moves towards the target by at most
// GRADE_STEP per piece, so levelling off or turning downhill builds a vertical easement
// instead of a kink.
export const GRADE_STEP = 1.0;
export function nextGrade(fromSlope) {
  const from = Math.round((fromSlope || 0) * 1000) / 1000;
  if (state.grade === 'auto' || state.grade === undefined || state.grade === null || Number.isNaN(+state.grade)) return from;
  const target = +state.grade, d = target - from;
  return Math.abs(d) <= GRADE_STEP + 1e-9 ? target : from + Math.sign(d) * GRADE_STEP;
}

export function addPiece(catId, at) {
  begin();
  const P = state.project;
  const pc = makePiece(catId);
  if (state.target) {
    const c = getCache().map.get(state.target.pieceId);
    const T = c && c.eps[state.target.ep];
    if (T) {
      const g = nextGrade(slopeOut(c, state.target.ep));
      alignTo(pc, 0, T, g);
      pc.level = P.activeLevel;
      state.lastAttach = { id: pc.id, T: { ...T }, k: 0, g };
    }
  } else if (at) {
    pc.x = at.x; pc.y = at.y;
    state.lastAttach = null;
  }
  P.pieces.push(pc);
  invalidate();
  advanceTarget(pc, state.lastAttach ? state.lastAttach.T : null);
  state.selection = new Set([pc.id]);
  changed();
  return pc;
}

// After placing, select the farthest free endpoint so the user can keep laying track
export function advanceTarget(pc, from) {
  const c = getCache().map.get(pc.id);
  let best = null, bd = -1;
  c.eps.forEach((e, i) => {
    if (c.links[i]) return;
    const d = from ? dist(e, from) : i;
    if (d > bd) { bd = d; best = i; }
  });
  state.target = best === null ? null : { pieceId: pc.id, ep: best };
}

// Cycle which endpoint of the last placed piece is attached (F key)
export function flipLast() {
  const la = state.lastAttach;
  if (!la) return false;
  const pc = state.project.pieces.find((p) => p.id === la.id);
  if (!pc) return false;
  begin();
  const n = pieceEndpoints(pc).length;
  la.k = (la.k + 1) % n;
  alignTo(pc, la.k, la.T, la.g ?? 0);
  invalidate();
  advanceTarget(pc, la.T);
  changed();
  return true;
}

export function deleteSelection() {
  const P = state.project;
  if (!state.selection.size) return;
  begin();
  const s = state.selection;
  P.pieces = P.pieces.filter((x) => !s.has(x.id));
  P.devices = P.devices.filter((x) => !s.has(x.id) && !s.has(x.pieceId));
  P.scenery = P.scenery.filter((x) => !s.has(x.id));
  s.clear();
  state.target = null;
  changed();
}

export function findItem(id) {
  const P = state.project;
  return P.pieces.find((x) => x.id === id) || P.devices.find((x) => x.id === id) || P.scenery.find((x) => x.id === id);
}
export function itemType(id) {
  const P = state.project;
  if (P.pieces.some((x) => x.id === id)) return 'piece';
  if (P.devices.some((x) => x.id === id)) return 'device';
  if (P.scenery.some((x) => x.id === id)) return 'scenery';
  return null;
}

// Nearest point on any track centerline
export function nearestTrack(pt, maxD = 3) {
  let best = null;
  for (const c of getCache().map.values()) {
    const lv = state.project.levels.find((l) => l.id === c.pc.level);
    if (lv && !lv.visible) continue;
    c.samples.forEach((arr, ri) => arr.forEach((s) => {
      const d = Math.hypot(s.x - pt.x, s.y - pt.y);
      if (d < maxD && (!best || d < best.d)) best = { d, pc: c.pc, route: ri, s };
    }));
  }
  return best;
}

export function routeSampleWorld(pc, routeIdx, d) {
  const g = pieceGeom(pc);
  const r = g.routes[routeIdx];
  const lp = poseAt(r, d);
  const w = toWorld(pc, lp);
  return { ...w, z: pc.z + (pc.grade / 100) * d, len: r.len };
}

// ---------- persistence ----------
const KEY = 'ho-layout-designer:autosave';
export function autosave() { try { localStorage.setItem(KEY, JSON.stringify(state.project)); } catch (e) { /* ignore */ } }
export function loadAutosave() {
  try {
    const s = localStorage.getItem(KEY);
    if (s) { loadProject(JSON.parse(s)); return true; }
  } catch (e) { /* ignore */ }
  return false;
}
export function loadProject(obj) {
  const base = newProject();
  const P = { ...base, ...obj, settings: { ...base.settings, ...(obj.settings || {}) } };
  P.pieces = P.pieces || []; P.devices = P.devices || []; P.scenery = P.scenery || [];
  // keep generated ids unique
  for (const arr of [P.pieces, P.devices, P.scenery]) for (const it of arr) {
    const n = parseInt(String(it.id).slice(1), 36);
    if (!isNaN(n) && n >= nextId) nextId = n + 1;
  }
  state.project = P;
  state.selection.clear(); state.target = null; state.lastAttach = null;
  invalidate();
}
export function resetProject() { begin(); loadProject(newProject()); changed(); }
