// 2D plan editor on a <canvas>: pan/zoom, track laying, snapping, board editing, placing items.
import { state, getCache, begin, changed, invalidate, freeEndpoints, alignTo, pieceEndpoints, nearestTrack, routeSampleWorld, findItem, itemType, uid, emit } from './model.js';
import { HO, DEVICE_BY_ID, SCENERY_BY_ID, TRACK_BY_ID, buildGeometry } from './catalog.js';
import { DEG, dist, distToSeg, sampleRoute, toWorld, toLocal, routeLen } from './geometry.js';

export const ed = {
  canvas: null, ctx: null, s: 8, tx: 40, ty: 600,
  mode: 'select', place: null, // place: {kind:'device'|'scenery', id}
  mouse: { x: 0, y: 0 }, drag: null, hover: null, measure: null, draft: null,
  issues: [], showElev: true, dimOthers: true, showIssues: true,
  onStatus: () => {}, onSelect: () => {},
};

const W2S = (p) => ({ x: p.x * ed.s + ed.tx, y: -p.y * ed.s + ed.ty });
const S2W = (x, y) => ({ x: (x - ed.tx) / ed.s, y: -(y - ed.ty) / ed.s });

export function initEditor(canvas) {
  ed.canvas = canvas;
  ed.ctx = canvas.getContext('2d');
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas.parentElement);
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('contextmenu', onContext);
  resize();
}

function resize() {
  const r = ed.canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ed.canvas.width = r.width * dpr; ed.canvas.height = r.height * dpr;
  ed.canvas.style.width = r.width + 'px'; ed.canvas.style.height = r.height + 'px';
  ed.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ed.w = r.width; ed.h = r.height;
  draw();
}

export function fitView() {
  const pts = state.project.board.outline;
  if (!pts.length) return;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 40;
  ed.s = Math.min((ed.w - pad * 2) / (maxX - minX || 1), (ed.h - pad * 2) / (maxY - minY || 1));
  ed.tx = (ed.w - (maxX - minX) * ed.s) / 2 - minX * ed.s;
  ed.ty = (ed.h + (maxY - minY) * ed.s) / 2 + minY * ed.s;
  draw();
}

export function setMode(mode, place = null) {
  ed.mode = mode; ed.place = place; ed.draft = mode === 'drawBoard' ? [] : null; ed.measure = null;
  ed.canvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  draw();
}

// ---------- units ----------
export function fmt(inches, prec = 1) {
  if (state.project.units === 'cm') return (inches * 2.54).toFixed(prec) + ' cm';
  const v = Math.abs(inches);
  if (v >= 24) { const ft = Math.floor(v / 12); return `${inches < 0 ? '-' : ''}${ft}' ${(v - ft * 12).toFixed(prec)}"`; }
  return inches.toFixed(prec) + '"';
}

// ---------- hit testing ----------
function levelOf(id) { return state.project.levels.find((l) => l.id === id); }
function visiblePiece(pc) { const l = levelOf(pc.level); return !l || l.visible; }

export function devicePose(d) {
  if (d.pieceId) {
    const pc = state.project.pieces.find((p) => p.id === d.pieceId);
    if (pc) {
      const w = routeSampleWorld(pc, d.route || 0, Math.min(d.d || 0, routeLen(buildGeometry(pc.kind, pc.params).routes[d.route || 0] || { segs: [] })));
      const side = d.side || 1;
      const off = d.type.startsWith('signal') || d.type === 'dwarf' || d.type === 'gate' ? 1.4 : 0;
      const h = w.h + (d.flip ? 180 : 0);
      return { x: w.x + Math.cos((h - 90 * side) * DEG) * off, y: w.y + Math.sin((h - 90 * side) * DEG) * off, h, z: w.z, track: w };
    }
  }
  return { x: d.x, y: d.y, h: d.rot || 0, z: 0 };
}

function hitScenery(pt) {
  const list = state.project.scenery;
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    const l = toLocal(o, pt);
    if (Math.abs(l.x) <= o.w / 2 + 0.3 && Math.abs(l.y) <= o.d / 2 + 0.3) return o;
  }
  return null;
}
function hitDevice(pt) {
  const r = Math.max(0.7, 8 / ed.s);
  for (const d of state.project.devices) if (dist(devicePose(d), pt) < r) return d;
  return null;
}
function hitEndpoint(pt) {
  const r = Math.max(0.6, 7 / ed.s);
  let best = null;
  for (const c of getCache().map.values()) {
    if (!visiblePiece(c.pc)) continue;
    c.eps.forEach((e, i) => {
      if (c.links[i]) return;
      const d = dist(e, pt);
      if (d < r && (!best || d < best.d)) best = { d, pieceId: c.pc.id, ep: i };
    });
  }
  return best;
}
function hitPiece(pt) {
  const n = nearestTrack(pt, Math.max(HO.ballastW / 2, 6 / ed.s));
  return n ? n.pc : null;
}

// ---------- mouse ----------
function evPt(e) { const r = ed.canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
function snapGrid(p) {
  const g = state.project.settings.grid || 1;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

function onDown(e) {
  const { sx, sy } = evPt(e);
  const pt = S2W(sx, sy);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) { ed.drag = { type: 'pan', sx, sy, tx: ed.tx, ty: ed.ty }; return; }
  if (e.button !== 0) return;
  const P = state.project;

  if (ed.mode === 'place') { placeItem(pt); return; }
  if (ed.mode === 'measure') { ed.measure = { a: pt, b: pt, active: true }; return; }
  if (ed.mode === 'drawBoard') {
    const q = snapGrid(pt);
    if (ed.draft.length > 2 && dist(q, ed.draft[0]) < 10 / ed.s) return finishDraft();
    ed.draft.push(q); draw(); return;
  }
  if (ed.mode === 'board') {
    const vi = P.board.outline.findIndex((v) => dist(v, pt) < 8 / ed.s);
    if (vi >= 0) { begin(); ed.drag = { type: 'vertex', i: vi }; return; }
    ed.drag = { type: 'pan', sx, sy, tx: ed.tx, ty: ed.ty }; return;
  }

  // select mode
  const ep = hitEndpoint(pt);
  if (ep) {
    const same = state.target && state.target.pieceId === ep.pieceId && state.target.ep === ep.ep;
    state.target = same ? null : { pieceId: ep.pieceId, ep: ep.ep };
    state.lastAttach = null;
    emit('target'); draw(); return;
  }
  const hit = hitDevice(pt) || hitScenery(pt) || hitPiece(pt);
  if (hit) {
    if (e.shiftKey) { state.selection.has(hit.id) ? state.selection.delete(hit.id) : state.selection.add(hit.id); }
    else if (!state.selection.has(hit.id)) state.selection = new Set([hit.id]);
    const start = new Map();
    for (const id of state.selection) {
      const it = findItem(id); if (!it) continue;
      const dp = itemType(id) === 'device' ? devicePose(it) : it;
      start.set(id, { x: it.x, y: it.y, px: dp.x, py: dp.y, rot: it.rot, z: it.z, grade: it.grade });
    }
    ed.drag = { type: 'move', from: pt, start, moved: false, hitId: hit.id };
    ed.onSelect(); draw(); return;
  }
  if (!e.shiftKey) { state.selection.clear(); ed.onSelect(); }
  ed.drag = { type: 'pan', sx, sy, tx: ed.tx, ty: ed.ty };
  draw();
}

function onMove(e) {
  if (!ed.canvas) return;
  const { sx, sy } = evPt(e);
  const pt = S2W(sx, sy);
  ed.mouse = pt;
  const D = ed.drag;
  if (D?.type === 'pan') { ed.tx = D.tx + sx - D.sx; ed.ty = D.ty + sy - D.sy; draw(); return; }
  if (D?.type === 'vertex') { state.project.board.outline[D.i] = snapGrid(pt); invalidate(); draw(); return; }
  if (D?.type === 'move') {
    let dx = pt.x - D.from.x, dy = pt.y - D.from.y;
    if (!D.moved && Math.hypot(dx, dy) * ed.s < 3) return;
    if (!D.moved) { begin(); D.moved = true; }
    for (const [id, st] of D.start) {
      const it = findItem(id); const t = itemType(id);
      if (t === 'device') {
        const np = { x: st.px + dx, y: st.py + dy };
        attachDevice(it, nearestTrack(np, 3), np);
        continue;
      }
      it.x = st.x + dx; it.y = st.y + dy;
      if (t === 'piece') { it.z = st.z; it.grade = st.grade; it.rot = st.rot; }
    }
    // snap a single moved piece to a free endpoint
    if (D.start.size === 1 && itemType(D.hitId) === 'piece' && state.project.settings.snap) snapPiece(findItem(D.hitId));
    invalidate(); draw(); return;
  }
  if (ed.measure?.active) { ed.measure.b = pt; draw(); return; }
  if (ed.mode === 'place' || ed.mode === 'drawBoard') draw();
  ed.onStatus(pt);
}

function onUp() {
  const D = ed.drag;
  ed.drag = null;
  if (ed.measure) ed.measure.active = false;
  if (D?.type === 'vertex') changed('board');
  if (D?.type === 'move' && D.moved) changed();
}

function onWheel(e) {
  e.preventDefault();
  const { sx, sy } = evPt(e);
  const before = S2W(sx, sy);
  const f = Math.exp(-e.deltaY * 0.0015);
  ed.s = Math.min(120, Math.max(0.5, ed.s * f));
  ed.tx = sx - before.x * ed.s; ed.ty = sy + before.y * ed.s;
  draw();
}

function onDbl(e) {
  const { sx, sy } = evPt(e);
  const pt = S2W(sx, sy);
  if (ed.mode === 'drawBoard') return finishDraft();
  if (ed.mode === 'board') {
    const O = state.project.board.outline;
    for (let i = 0; i < O.length; i++) {
      const a = O[i], b = O[(i + 1) % O.length];
      if (distToSeg(pt, a, b).d < 8 / ed.s) { begin(); O.splice(i + 1, 0, snapGrid(pt)); changed('board'); return; }
    }
    return;
  }
  const pc = hitPiece(pt);
  if (pc && pc.kind !== 'straight' && pc.kind !== 'curve') toggleTurnout(pc);
}

function onContext(e) {
  e.preventDefault();
  if (ed.mode !== 'board') return;
  const { sx, sy } = evPt(e);
  const pt = S2W(sx, sy);
  const O = state.project.board.outline;
  const vi = O.findIndex((v) => dist(v, pt) < 8 / ed.s);
  if (vi >= 0 && O.length > 3) { begin(); O.splice(vi, 1); changed('board'); }
}

export function toggleTurnout(pc) {
  const n = buildGeometry(pc.kind, pc.params).routes.length;
  if (n < 2) return;
  begin(); pc.state = ((pc.state || 0) + 1) % n; changed('state');
}

function finishDraft() {
  if (ed.draft.length >= 3) { begin(); state.project.board.outline = ed.draft; changed('board'); }
  setMode('board');
}

// Snap the moving piece so one of its endpoints meets a nearby free endpoint
function snapPiece(pc) {
  const tol = Math.max(1.0, 14 / ed.s);
  const eps = pieceEndpoints(pc);
  const free = freeEndpoints(pc.id).filter((f) => visiblePiece(state.project.pieces.find((p) => p.id === f.pieceId)));
  let best = null;
  eps.forEach((e, k) => free.forEach((f) => {
    const d = dist(e, f);
    if (d < tol && (!best || d < best.d)) best = { d, k, f };
  }));
  if (best) alignTo(pc, best.k, best.f, 0, true);
}

function attachDevice(d, near, fallback) {
  if (near) {
    d.pieceId = near.pc.id; d.route = near.route; d.d = near.s.d;
  } else {
    d.pieceId = null; d.x = fallback.x; d.y = fallback.y;
  }
}

function placeItem(pt) {
  const P = state.project;
  begin();
  if (ed.place.kind === 'device') {
    const cat = DEVICE_BY_ID[ed.place.id];
    const n = nearestTrack(pt, 4);
    const count = P.devices.filter((d) => d.type === cat.id).length + 1;
    const d = { id: uid('d'), type: cat.id, name: cat.name, x: pt.x, y: pt.y, rot: 0, side: 1, flip: false, props: { name: `${cat.icon}${count}`, address: '', notes: '', ...cat.props } };
    attachDevice(d, n, pt);
    P.devices.push(d);
    state.selection = new Set([d.id]);
  } else {
    const cat = SCENERY_BY_ID[ed.place.id];
    const o = { id: uid('o'), type: cat.id, name: cat.name, shape: cat.shape, x: pt.x, y: pt.y, rot: 0, w: cat.w, d: cat.d, h: cat.h, roof: cat.roof || 'flat', color: cat.color, base: 0, props: { name: '' } };
    P.scenery.push(o);
    state.selection = new Set([o.id]);
  }
  changed();
  ed.onSelect();
}

// ---------- drawing ----------
let raf = 0;
export function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

const tieCache = new WeakMap();
function tiesFor(c) {
  if (tieCache.has(c)) return tieCache.get(c);
  const out = c.g.routes.map((r) => {
    const L = routeLen(r), pts = [];
    const loc = sampleRoute(r, HO.tieSpacing);
    for (const p of loc) if (p.d <= L) pts.push(toWorld(c.pc, p));
    return pts;
  });
  tieCache.set(c, out);
  return out;
}

function render() {
  const { ctx, w, h } = ed;
  if (!ctx) return;
  const P = state.project;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1e2329'; ctx.fillRect(0, 0, w, h);
  drawGrid();
  drawBoard();
  for (const o of P.scenery.filter((o) => ['flat', 'water', 'hill'].includes(o.shape))) drawScenery(o);

  const C = getCache();
  const list = [...C.map.values()].filter((c) => visiblePiece(c.pc)).sort((a, b) => a.pc.z - b.pc.z);
  for (const c of list) drawPiece(c);
  for (const o of P.scenery.filter((o) => !['flat', 'water', 'hill'].includes(o.shape))) drawScenery(o);
  for (const d of P.devices) drawDevice(d);
  for (const c of list) drawEndpoints(c);
  if (ed.showIssues) drawIssues();
  drawOverlays();
  drawScaleBar();
}

function drawGrid() {
  const { ctx, w, h } = ed;
  const metric = state.project.units === 'cm';
  const minor = metric ? 10 / 2.54 : 1, major = metric ? 100 / 2.54 : 12;
  const a = S2W(0, h), b = S2W(w, 0);
  const line = (step, col, lw) => {
    if (step * ed.s < 6) return;
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    for (let x = Math.floor(a.x / step) * step; x <= b.x; x += step) { const sx = x * ed.s + ed.tx; ctx.moveTo(sx, 0); ctx.lineTo(sx, h); }
    for (let y = Math.floor(a.y / step) * step; y <= b.y; y += step) { const sy = -y * ed.s + ed.ty; ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
    ctx.stroke();
  };
  line(minor, 'rgba(255,255,255,0.04)', 1);
  line(major, 'rgba(255,255,255,0.10)', 1);
}

function pathPoly(pts) {
  const { ctx } = ed;
  ctx.beginPath();
  pts.forEach((p, i) => { const s = W2S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
  ctx.closePath();
}

function drawBoard() {
  const { ctx } = ed;
  const B = state.project.board;
  if (B.outline.length < 3) return;
  pathPoly(B.outline);
  ctx.fillStyle = B.color || '#c9a66b'; ctx.fill();
  ctx.strokeStyle = '#7a5a2a'; ctx.lineWidth = 2; ctx.stroke();
  // edge dimensions
  ctx.font = '11px system-ui'; ctx.fillStyle = '#f4e6c8'; ctx.textAlign = 'center';
  B.outline.forEach((a, i) => {
    const b = B.outline[(i + 1) % B.outline.length];
    const L = dist(a, b);
    if (L * ed.s < 40) return;
    const m = W2S({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(Math.abs(ang) > Math.PI / 2 ? ang + Math.PI : ang);
    ctx.fillText(fmt(L, 1), 0, -5); ctx.restore();
  });
  if (ed.mode === 'board') {
    B.outline.forEach((v) => { const s = W2S(v); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.rect(s.x - 5, s.y - 5, 10, 10); ctx.fill(); ctx.stroke(); });
  }
}

function polyline(pts, off = 0) {
  const { ctx } = ed;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const nx = -Math.sin(p.h * DEG) * off, ny = Math.cos(p.h * DEG) * off;
    const s = W2S({ x: p.x + nx, y: p.y + ny });
    i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
  });
}

function drawPiece(c) {
  const { ctx } = ed;
  const pc = c.pc, P = state.project;
  const lv = levelOf(pc.level);
  const dim = ed.dimOthers && pc.level !== P.activeLevel;
  ctx.globalAlpha = dim ? 0.35 : 1;
  const sel = state.selection.has(pc.id);
  const col = lv?.color || '#3f6fb5';
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  if (c.g.pit) {
    const s = W2S(pc);
    ctx.fillStyle = '#555'; ctx.strokeStyle = sel ? '#33e1ff' : '#222'; ctx.lineWidth = sel ? 3 : 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, c.g.pit * ed.s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // ballast
  if (!c.g.pit) c.samples.forEach((pts) => {
    if (sel) { polyline(pts); ctx.strokeStyle = '#33e1ff'; ctx.lineWidth = (HO.ballastW + 0.6) * ed.s; ctx.stroke(); }
    polyline(pts); ctx.strokeStyle = shade(col, pc.z); ctx.lineWidth = HO.ballastW * ed.s; ctx.stroke();
  });
  // ties
  if (ed.s > 5) {
    ctx.strokeStyle = '#5b4632'; ctx.lineWidth = Math.max(1, 0.12 * ed.s);
    const T = tiesFor(c);
    ctx.beginPath();
    T.forEach((pts) => pts.forEach((p) => {
      const nx = -Math.sin(p.h * DEG) * HO.tieLen / 2, ny = Math.cos(p.h * DEG) * HO.tieLen / 2;
      const a = W2S({ x: p.x + nx, y: p.y + ny }), b = W2S({ x: p.x - nx, y: p.y - ny });
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }));
    ctx.stroke();
  }
  // rails, active route last
  const order = c.samples.map((_, i) => i).sort((a, b) => (a === (pc.state || 0)) - (b === (pc.state || 0)));
  for (const ri of order) {
    const active = c.samples.length < 2 || ri === (pc.state || 0) || pc.kind === 'crossing' || pc.kind === 'turntable';
    ctx.strokeStyle = active ? '#d9d9d9' : 'rgba(200,200,200,0.35)';
    ctx.lineWidth = Math.max(1, 0.09 * ed.s);
    polyline(c.samples[ri], HO.gauge / 2); ctx.stroke();
    polyline(c.samples[ri], -HO.gauge / 2); ctx.stroke();
  }
  // elevation label
  if (ed.showElev && (Math.abs(pc.z) > 0.01 || pc.grade) && (sel || pc.grade || ed.s > 14)) {
    const mid = c.samples[0][Math.floor(c.samples[0].length / 2)];
    const s = W2S(mid);
    const txt = `${fmt(mid.z, 2)}${pc.grade ? `  ${pc.grade > 0 ? '↑' : '↓'}${Math.abs(pc.grade)}%` : ''}`;
    ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    const tw = ctx.measureText(txt).width + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(s.x - tw / 2, s.y - 7, tw, 13);
    ctx.fillStyle = '#ffe28a'; ctx.fillText(txt, s.x, s.y + 3);
  }
  ctx.globalAlpha = 1;
}

function shade(hex, z) {
  // ballast tinted with level colour; lighter when higher
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const k = Math.min(0.35, Math.max(0, z / 30));
  r = r + (255 - r) * k; g = g + (255 - g) * k; b = b + (255 - b) * k;
  return `rgb(${(r * 0.55 + 70) | 0},${(g * 0.55 + 70) | 0},${(b * 0.55 + 70) | 0})`;
}

function drawEndpoints(c) {
  const { ctx } = ed;
  c.eps.forEach((e, i) => {
    const isT = state.target && state.target.pieceId === c.pc.id && state.target.ep === i;
    if (c.links[i] && !isT) return;
    const s = W2S(e);
    const r = Math.max(3, Math.min(7, 0.35 * ed.s));
    if (isT) {
      ctx.strokeStyle = '#3cff7a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2); ctx.stroke();
      const ax = s.x + Math.cos(e.h * DEG) * 22, ay = s.y - Math.sin(e.h * DEG) * 22;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ax, ay); ctx.stroke();
    }
    ctx.fillStyle = isT ? '#3cff7a' : '#ff5a5a';
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
  });
}

function drawDevice(d) {
  const { ctx } = ed;
  const cat = DEVICE_BY_ID[d.type];
  const p = devicePose(d);
  const s = W2S(p);
  const r = Math.max(6, 0.55 * ed.s);
  const sel = state.selection.has(d.id);
  if (d.type === 'gap' && p.track) {
    const t = p.track;
    const nx = -Math.sin(t.h * DEG), ny = Math.cos(t.h * DEG);
    const a = W2S({ x: t.x + nx, y: t.y + ny }), b = W2S({ x: t.x - nx, y: t.y - ny });
    ctx.strokeStyle = sel ? '#33e1ff' : '#000'; ctx.lineWidth = Math.max(2, 0.25 * ed.s);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    return;
  }
  ctx.fillStyle = cat?.color || '#888';
  ctx.strokeStyle = sel ? '#33e1ff' : '#111'; ctx.lineWidth = sel ? 3 : 1.5;
  ctx.beginPath();
  if (d.type === 'sensor' || d.type === 'home') { ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath(); }
  else ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  if (d.type.startsWith('signal') || d.type === 'dwarf') {
    // facing arrow
    const ax = s.x + Math.cos(p.h * DEG) * r * 1.8, ay = s.y - Math.sin(p.h * DEG) * r * 1.8;
    ctx.strokeStyle = cat.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ax, ay); ctx.stroke();
    const asp = { Red: '#ff3b3b', Yellow: '#ffd23b', Green: '#3bff6a' }[d.props.aspect] || '#fff';
    ctx.fillStyle = asp; ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.45, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(cat?.icon || '?', s.x, s.y + 0.5); ctx.textBaseline = 'alphabetic';
  }
  if (ed.s > 4) {
    ctx.font = '10px system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(`${d.props.name || ''}${d.props.address ? ' @' + d.props.address : ''}`, s.x + r + 3, s.y - r);
  }
}

function drawScenery(o) {
  const { ctx } = ed;
  const s = W2S(o);
  const sel = state.selection.has(o.id);
  ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-o.rot * DEG);
  const w = o.w * ed.s, d = o.d * ed.s;
  ctx.fillStyle = o.color; ctx.strokeStyle = sel ? '#33e1ff' : 'rgba(0,0,0,0.6)'; ctx.lineWidth = sel ? 3 : 1;
  ctx.beginPath();
  if (o.shape === 'tree' || o.shape === 'pine' || o.shape === 'cyl') ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
  else if (o.shape === 'water' || o.shape === 'hill') ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2);
  else if (o.shape === 'light') { ctx.fillStyle = 'rgba(255,215,106,0.25)'; ctx.arc(0, 0, 2 * ed.s, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.fillStyle = o.color; ctx.arc(0, 0, Math.max(3, 0.3 * ed.s), 0, Math.PI * 2); }
  else ctx.rect(-w / 2, -d / 2, w, d);
  ctx.fill(); ctx.stroke();
  if (o.shape === 'box' && o.roof === 'gable') { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0); ctx.stroke(); }
  if (o.shape === 'flat') { ctx.setLineDash([0.8 * ed.s, 0.8 * ed.s]); ctx.strokeStyle = '#e8d36a'; ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0); ctx.stroke(); ctx.setLineDash([]); }
  ctx.restore();
  if (ed.s > 4 && o.shape === 'box' && o.h > 1) { ctx.font = '10px system-ui'; ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(o.props?.name || o.name, s.x, s.y + 3); }
}

function drawIssues() {
  const { ctx } = ed;
  for (const is of ed.issues) {
    if (is.level === 'info' || !is.at) continue;
    const s = W2S(is.at);
    ctx.strokeStyle = is.level === 'error' ? '#ff2d2d' : '#ffb02d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('!', s.x, s.y + 4);
  }
}

function drawOverlays() {
  const { ctx } = ed;
  if (ed.mode === 'drawBoard' && ed.draft) {
    const pts = [...ed.draft, snapGrid(ed.mouse)];
    ctx.strokeStyle = '#ffd23b'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); pts.forEach((p, i) => { const s = W2S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke(); ctx.setLineDash([]);
    ed.draft.forEach((p) => { const s = W2S(p); ctx.fillStyle = '#ffd23b'; ctx.fillRect(s.x - 4, s.y - 4, 8, 8); });
  }
  if (ed.measure) {
    const a = W2S(ed.measure.a), b = W2S(ed.measure.b);
    ctx.strokeStyle = '#ffd23b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const txt = fmt(dist(ed.measure.a, ed.measure.b), 2);
    ctx.font = 'bold 12px system-ui'; ctx.fillStyle = '#ffd23b'; ctx.textAlign = 'left'; ctx.fillText(txt, b.x + 8, b.y - 8);
  }
  if (ed.mode === 'place' && ed.place) {
    const s = W2S(ed.mouse);
    ctx.strokeStyle = '#ffd23b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    if (ed.place.kind === 'scenery') { const c = SCENERY_BY_ID[ed.place.id]; ctx.strokeRect(s.x - c.w * ed.s / 2, s.y - c.d * ed.s / 2, c.w * ed.s, c.d * ed.s); }
    else { ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
  }
}

function drawScaleBar() {
  const { ctx, h } = ed;
  const metric = state.project.units === 'cm';
  const unit = metric ? 10 / 2.54 : 12; // 10 cm or 1 ft
  let n = 1; while (n * unit * ed.s < 60) n *= 2;
  const L = n * unit * ed.s;
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(10, h - 34, L + 20, 24);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(20, h - 16); ctx.lineTo(20 + L, h - 16); ctx.moveTo(20, h - 21); ctx.lineTo(20, h - 11); ctx.moveTo(20 + L, h - 21); ctx.lineTo(20 + L, h - 11); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(metric ? `${n * 10} cm` : `${n} ft`, 20 + L / 2, h - 20);
}

export function centerOn(p) { ed.tx = ed.w / 2 - p.x * ed.s; ed.ty = ed.h / 2 + p.y * ed.s; draw(); }

export function rotateSelection(deg) {
  const ids = [...state.selection];
  if (!ids.length) return;
  begin();
  const items = ids.map(findItem).filter(Boolean).filter((it) => itemType(it.id) !== 'device' || !it.pieceId);
  const devs = ids.map(findItem).filter((it) => it && itemType(it.id) === 'device' && it.pieceId);
  devs.forEach((d) => { d.flip = !d.flip; });
  if (items.length) {
    const cx = items.reduce((t, i) => t + i.x, 0) / items.length, cy = items.reduce((t, i) => t + i.y, 0) / items.length;
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    for (const it of items) {
      const dx = it.x - cx, dy = it.y - cy;
      if (items.length > 1) { it.x = cx + dx * c - dy * s; it.y = cy + dx * s + dy * c; }
      it.rot = ((it.rot || 0) + deg) % 360;
    }
  }
  state.target = null;
  changed();
}

export function exportPNG() { return ed.canvas.toDataURL('image/png'); }
