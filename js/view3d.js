// 3D preview with three.js: benchwork, track with grades & piers, scenery, devices, test train.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, getCache, routeSampleWorld } from './model.js';
import { HO } from './catalog.js';
import { DEG, sampleRoute, toWorld, pointInPoly } from './geometry.js';
import { devicePose } from './editor2d.js';
import { supports, onTerrain, seated, groundAt, hillHeightFn, portalOpening, trestleBents, trestleSpread, moveTrain, autoPortals, TURNOUT_KINDS } from './realism.js';

let renderer, scene, camera, controls, root, container, active = false, dirty = true;
let hemi, sun, night = false, train = null, cab = false, clock = new THREE.Clock();
const lampLights = [];

// model (x, y, z-elevation) -> three (x, z, -y)
const V = (x, y, z) => new THREE.Vector3(x, z, -y);

export function init3D(el) {
  container = el;
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9cc4e4');
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  hemi = new THREE.HemisphereLight('#ffffff', '#5a4a3a', 1.1);
  sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(hemi, sun, sun.target);
  root = new THREE.Group();
  scene.add(root);
  new ResizeObserver(resize).observe(el);
  resize();
  loop();
}

function resize() {
  if (!container) return;
  const r = container.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}

export function setActive(v) { active = v; if (v) { resize(); if (dirty) rebuild(); } }
export function markDirty() { dirty = true; if (active) rebuild(); }

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta());
  if (!active) return;
  if (train) stepTrain(dt);
  if (!cab) controls.update();
  renderer.render(scene, camera);
}

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });

function clear(g) {
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
  g.clear();
}

function bbox() {
  const O = state.project.board.outline;
  const xs = O.map((p) => p.x), ys = O.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function resetCamera(top = false) {
  const b = bbox();
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  controls.target.copy(V(cx, cy, 0));
  if (top) camera.position.copy(V(cx, cy - 0.01, span * 1.2));
  else camera.position.copy(V(cx - span * 0.15, cy - span * 0.85, span * 0.6));
  cab = false;
  controls.update();
}

function rebuild() {
  dirty = false;
  if (train) train.mesh.forEach((m) => root.remove(m));
  clear(root);
  lampLights.length = 0;
  const P = state.project;
  if (P.board.outline.length < 3) return;
  const b = bbox();
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  sun.position.copy(V(b.minX - span * 0.3, b.minY - span * 0.5, span));
  sun.target.position.copy(V((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0));
  const sc = sun.shadow.camera; sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = span * 4; sc.updateProjectionMatrix();

  buildBoard(P.board);
  buildTrack();
  for (const o of P.scenery) buildScenery(seated(o)); // trees & buildings stand on the terrain
  for (const o of autoPortals()) buildScenery(o); // a portal at every tunnel mouth
  for (const d of P.devices) buildDevice(d);
  applyLighting();
  if (!camera.userData.placed) { resetCamera(); camera.userData.placed = true; }
  if (train) { train.mesh.forEach((m) => root.add(m)); if (train.marker) root.add(train.marker); }
}

function buildBoard(B) {
  const shape = new THREE.Shape(B.outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const t = B.thickness || 0.75;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -t, 0);
  const top = mat('#7c8f4e'), side = mat('#3b2a1a');
  const m = new THREE.Mesh(geo, [top, side]);
  m.receiveShadow = true;
  root.add(m);
  // fascia skirt / legs
  const legMat = mat('#6b4e2e');
  for (const p of B.outline) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.5, 30, 1.5), legMat);
    leg.position.copy(V(p.x, p.y, -t - 15));
    root.add(leg);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), mat('#bdb7aa'));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -t - 30; floor.receiveShadow = true;
  root.add(floor);
}

// Strip (top + two sides) following a centerline. pts: {x,y,h,z}
function beam(pts, off, w, y0, y1, material, cast = true) {
  const pos = [], idx = [];
  pts.forEach((p) => {
    const nx = -Math.sin(p.h * DEG), ny = Math.cos(p.h * DEG);
    const L = { x: p.x + nx * (off + w / 2), y: p.y + ny * (off + w / 2) };
    const R = { x: p.x + nx * (off - w / 2), y: p.y + ny * (off - w / 2) };
    for (const q of [L, R]) for (const yy of [y0, y1]) { const v = V(q.x, q.y, p.z + yy); pos.push(v.x, v.y, v.z); }
  });
  // per point: 0=L bottom,1=L top,2=R bottom,3=R top
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 4, b = (i + 1) * 4;
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3); // top
    idx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1); // left
    idx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3); // right
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = cast; m.receiveShadow = true;
  material.side = THREE.DoubleSide;
  root.add(m);
  return m;
}

function buildTrack() {
  const C = getCache();
  const ballast = mat('#8a8278'), rail = mat('#b9b9c0', { metalness: 0.8, roughness: 0.35 }), ply = mat('#c8a46a'), pier = mat('#9a8b78');
  const tieGeo = new THREE.BoxGeometry(0.2, 0.12, HO.tieLen);
  const ties = [];
  for (const c of C.map.values()) {
    const lv = state.project.levels.find((l) => l.id === c.pc.level);
    if (lv && !lv.visible) continue;
    if (c.g.pit) {
      const pit = new THREE.Mesh(new THREE.CylinderGeometry(c.g.pit, c.g.pit, 0.6, 48), mat('#555'));
      pit.position.copy(V(c.pc.x, c.pc.y, c.pc.z - 0.25)); root.add(pit);
    }
    c.samples.forEach((pts, ri) => {
      const elevated = pts.some((p) => p.z > 0.3);
      if (!c.g.pit) beam(pts, 0, HO.ballastW, 0, 0.18, ballast);
      if (elevated) {
        // plywood roadbed only where the track is in the air, not where the hill carries it
        let run = [];
        const flush = () => { if (run.length > 1) beam(run, 0, HO.ballastW + 1, -0.6, 0, ply); run = []; };
        for (const p of pts) { if (p.z > 0.3 && !onTerrain(p)) run.push(p); else flush(); }
        flush();
      }
      // Rails. On a turnout only the route it is set for runs through the points; the other
      // route's rails start behind the points, which is what you see from the cab.
      const isTurnout = TURNOUT_KINDS.includes(c.pc.kind);
      const active = (c.pc.state || 0) === ri;
      const railPts = isTurnout && !active ? pts.filter((p) => p.d >= 2.6) : pts;
      if (railPts.length > 1) for (const s of [HO.gauge / 2, -HO.gauge / 2]) beam(railPts, s, 0.07, 0.25, 0.42, rail, false);
      if (isTurnout && ri === 0) switchStand(c);
      // ties
      const r = c.g.routes[ri];
      for (const lp of sampleRoute(r, HO.tieSpacing)) {
        const w = toWorld(c.pc, lp);
        ties.push({ x: w.x, y: w.y, h: w.h, z: c.pc.z + (c.pc.grade / 100) * lp.d });
      }
    });
  }
  buildSupports(pier);
  if (ties.length) {
    const im = new THREE.InstancedMesh(tieGeo, mat('#4a3626'), ties.length);
    const o = new THREE.Object3D();
    ties.forEach((t, i) => { o.position.copy(V(t.x, t.y, t.z + 0.22)); o.rotation.set(0, t.h * DEG, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
    im.receiveShadow = true;
    root.add(im);
  }
}

// A group placed and rotated like a scenery item; children use local coords
// (x along the item's width, y up from its base, z across = -local y).
function itemGroup(o) {
  const g = new THREE.Group();
  g.position.copy(V(o.x, o.y, o.base || 0));
  g.rotation.y = (o.rot || 0) * DEG;
  root.add(g);
  return g;
}
function gbox(g, sx, sy, sz, x, y, z, m, rz = 0, rx = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  mesh.position.set(x, y, z); mesh.rotation.set(rx, 0, rz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
// a straight member between two points in the group's x/y plane at depth z
function strut(g, x0, y0, x1, y1, z, t, m) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  return gbox(g, L, t, t, (x0 + x1) / 2, (y0 + y1) / 2, z, m, Math.atan2(y1 - y0, x1 - x0));
}

// Mountain / hill as a height field. Where track runs into the slope without being deep enough for
// a tunnel, the ground is dug out to track level with sloping sides (a railway cutting), so trains
// run through cuttings into the portals instead of through solid ground.
function buildTerrain(o) {
  const f = hillHeightFn(o);
  const rot = (o.rot || 0) * DEG, cs = Math.cos(rot), sn = Math.sin(rot);
  // ~0.5" mesh so cutting walls and portal faces stay crisp; the grid extends past the hill so
  // ground built up over a tunnel near the hill's edge is not clipped
  const ext = 14, W0 = o.w + 2 * ext, D0 = o.d + 2 * ext; // room for hillside fill slopes
  const nx = Math.min(220, Math.max(24, Math.round(W0 * 2))), ny = Math.min(220, Math.max(24, Math.round(D0 * 2)));
  const pos = [], idx = [], inside = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const lx = -W0 / 2 + (W0 * i) / nx, ly = -D0 / 2 + (D0 * j) / ny;
    const x = o.x + lx * cs - ly * sn, y = o.y + lx * sn + ly * cs;
    const hgt = f(x, y);
    const v = V(x, y, hgt > 0.01 ? hgt : -2); // flat ground tucks well under the board top (no shadow acne)
    pos.push(v.x, v.y, v.z);
    inside.push(pointInPoly({ x, y }, state.project.board.outline)); // terrain only on the benchwork
  }
  const W = nx + 1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    if (!(inside[a] && inside[b] && inside[c] && inside[d])) continue;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat(o.color, { side: THREE.DoubleSide })); // smooth shading: no faceted sawtooth
  m.castShadow = true; m.receiveShadow = true;
  root.add(m);
}

function buildSpan(o) {
  const g = itemGroup(o);
  const steel = mat(o.color, { metalness: 0.3, roughness: 0.6 });
  const concrete = mat('#9a968c');
  const deckY = -0.6, H = o.base || 0, half = o.w / 2, zs = o.d / 2;
  if (o.shape === 'trestle') {
    const wood = mat(o.color);
    gbox(g, o.w, 0.2, o.d * 0.9, 0, deckY - 0.1, 0, wood); // stringers / deck
    const legH = Math.max(0.2, H + deckY - 0.2);
    for (const x of trestleBents(o)) {
      gbox(g, 0.18, 0.16, o.d + 0.4, x, deckY - 0.28, 0, wood); // cap
      if (H < 0.9) continue;
      const spread = trestleSpread(o); // battered outer posts
      const base = -H, top = deckY - 0.36;
      for (const zz of [-0.35, 0.35]) gbox(g, 0.14, legH, 0.14, x, (base + top) / 2, zz, wood);
      for (const sgn of [-1, 1]) {
        const zt = sgn * 0.8, zb = sgn * (0.8 + spread);
        const L = Math.hypot(top - base, zb - zt);
        gbox(g, 0.14, L, 0.14, x, (base + top) / 2, (zt + zb) / 2, wood, 0, -sgn * Math.atan2(zb - zt, top - base));
      }
      // sway bracing
      for (let y = base + 1.2; y < top - 0.6; y += 2.4) {
        const w = 1.6 + spread * 2 * (1 - (y - base) / (top - base));
        gbox(g, 0.08, 0.08, w, x, y, 0, wood);
      }
    }
    return;
  }
  // abutments / end piers
  if (H > 0.9) for (const x of [-half, half]) gbox(g, 1.2, H + deckY, o.d + 0.8, x, (-H + deckY) / 2, 0, concrete);
  gbox(g, o.w, 0.15, o.d, 0, deckY - 0.08, 0, steel); // deck plate
  if (o.style === 'truss') {
    const n = Math.max(3, Math.round(o.w / 3)), p = o.w / n, top = deckY + Math.max(2, o.h), bot = deckY, t = 0.18;
    for (const z of [-zs, zs]) {
      strut(g, -half, bot, half, bot, z, t + 0.05, steel); // bottom chord
      strut(g, -half + p, top, half - p, top, z, t + 0.05, steel); // top chord
      strut(g, -half, bot, -half + p, top, z, t + 0.05, steel); // inclined end posts
      strut(g, half, bot, half - p, top, z, t + 0.05, steel);
      for (let i = 1; i < n; i++) {
        const x = -half + i * p;
        strut(g, x, bot, x, top, z, t, steel); // verticals
        if (i < n / 2) strut(g, x, top, x + p, bot, z, t * 0.8, steel); // Pratt diagonals
        else if (i > n / 2) strut(g, x, top, x - p, bot, z, t * 0.8, steel);
      }
    }
    for (let i = 1; i < n; i++) gbox(g, t, t, o.d, -half + i * p, top, 0, steel); // top lateral struts
  } else {
    const gh = Math.max(0.8, o.h);
    for (const z of [-zs, zs]) {
      gbox(g, o.w, gh, 0.14, 0, deckY - 0.15 + gh / 2, z, steel); // through plate girders
      for (let x = -half + 1; x < half; x += 1.5) gbox(g, 0.1, gh, 0.22, x, deckY - 0.15 + gh / 2, z, steel); // stiffeners
    }
  }
}

// Posts under raised track (computed in realism.js so they never stand on a lower track):
// a single post, a two-post bent with a cap beam, or a post with a bracket arm.
function buildSupports(m) {
  for (const sp of supports().supports) {
    const top = sp.top;
    for (const q of sp.posts) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, top, 0.7), m);
      post.position.copy(V(q.x, q.y, top / 2)); post.castShadow = true; root.add(post);
    }
    if (sp.cap) {
      const [a, b] = sp.cap;
      const L = Math.hypot(b.x - a.x, b.y - a.y) + 0.7;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(L, 0.35, 0.6), m);
      cap.position.copy(V((a.x + b.x) / 2, (a.y + b.y) / 2, top - 0.17));
      cap.rotation.y = Math.atan2(b.y - a.y, b.x - a.x);
      cap.castShadow = true; root.add(cap);
    }
  }
}

// Switch stand beside the points: green target = normal (straight), red = reverse (diverging)
function switchStand(c) {
  const pc = c.pc, a = pc.rot * DEG, side = -1.5;
  const x = pc.x + Math.cos(a) * 1.2 - Math.sin(a) * side, y = pc.y + Math.sin(a) * 1.2 + Math.cos(a) * side;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), mat('#333'));
  post.position.copy(V(x, y, pc.z + 0.4)); root.add(post);
  const on = (pc.state || 0) === 0 ? '#20d060' : '#e03030';
  const tgt = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.06), new THREE.MeshStandardMaterial({ color: on, emissive: on, emissiveIntensity: 0.6 }));
  tgt.position.copy(V(x, y, pc.z + 0.9)); tgt.rotation.y = a; root.add(tgt);
}

function placeObj(m, o, y) {
  m.position.copy(V(o.x, o.y, (o.base || 0) + y));
  m.rotation.y = (o.rot || 0) * DEG;
  m.castShadow = true; m.receiveShadow = true;
  root.add(m);
  return m;
}

function buildScenery(o) {
  const c = o.color;
  if ((o.base || 0) > 0.5 && ['box', 'cyl', 'pine', 'tree', 'light'].includes(o.shape) && groundAt(o.x, o.y) < o.base - 0.3) { // on a deck, not on the hill
    const pad = new THREE.Mesh(new THREE.BoxGeometry(o.w + 1, 0.5, o.d + 1), mat('#7c8f4e'));
    pad.position.copy(V(o.x, o.y, o.base - 0.25)); pad.rotation.y = (o.rot || 0) * DEG; pad.receiveShadow = true; root.add(pad);
  }
  switch (o.shape) {
    case 'box': {
      placeObj(new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat(c)), o, o.h / 2);
      if (o.roof === 'gable') {
        const rh = Math.min(o.d * 0.45, 3);
        const sh = new THREE.Shape([new THREE.Vector2(-o.d / 2 - 0.2, 0), new THREE.Vector2(o.d / 2 + 0.2, 0), new THREE.Vector2(0, rh)]);
        const g = new THREE.ExtrudeGeometry(sh, { depth: o.w + 0.4, bevelEnabled: false });
        g.rotateY(Math.PI / 2); g.translate(-(o.w + 0.4) / 2, 0, 0);
        placeObj(new THREE.Mesh(g, mat('#5a3b32')), o, o.h);
      }
      break;
    }
    case 'cyl': {
      placeObj(new THREE.Mesh(new THREE.CylinderGeometry(o.w / 2, o.w / 2, o.h * 0.45, 20), mat(c)), o, o.h * 0.75);
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, o.h * 0.55, 0.2), mat('#3a2a1a'));
        placeObj(leg, { ...o, x: o.x + dx * o.w * 0.3, y: o.y + dy * o.w * 0.3 }, o.h * 0.275);
      }
      break;
    }
    case 'pine':
      placeObj(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, o.h * 0.3, 6), mat('#4a3020')), o, o.h * 0.15);
      placeObj(new THREE.Mesh(new THREE.ConeGeometry(o.w / 2, o.h * 0.8, 10), mat(c)), o, o.h * 0.6);
      break;
    case 'tree':
      placeObj(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, o.h * 0.5, 6), mat('#4a3020')), o, o.h * 0.25);
      placeObj(new THREE.Mesh(new THREE.SphereGeometry(o.w / 2, 12, 10), mat(c)), o, o.h - o.w / 2);
      break;
    case 'light': {
      placeObj(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, o.h, 8), mat('#333')), o, o.h / 2);
      const lamp = placeObj(new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1 })), o, o.h);
      lamp.castShadow = false;
      lampLights.push(lamp.position.clone());
      break;
    }
    case 'flat':
      placeObj(new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.06, o.d), mat(c)), o, 0.03);
      break;
    case 'water': {
      const g = new THREE.CircleGeometry(0.5, 40); g.rotateX(-Math.PI / 2);
      const m = placeObj(new THREE.Mesh(g, mat(c, { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85 })), o, 0.04);
      m.scale.set(o.w, 1, o.d);
      break;
    }
    case 'hill': buildTerrain(o); break;
    case 'river': {
      placeObj(new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.06, o.d), mat(c, { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85 })), o, 0.04);
      break;
    }
    case 'bridge':
    case 'trestle':
      buildSpan(o);
      break;
    case 'portal': {
      // stone face with an arched bore sized from portalOpening() (the same numbers the checks use)
      const op = portalOpening(o), g = itemGroup(o), stone = mat(c), dark = mat('#0c0c0c');
      const side = (o.w - op.w) / 2;
      for (const sx of [-1, 1]) gbox(g, side, o.h, o.d, sx * (op.w / 2 + side / 2), o.h / 2, 0, stone);
      gbox(g, op.w, o.h - op.h, o.d, 0, op.h + (o.h - op.h) / 2, 0, stone);
      gbox(g, op.w, op.h, 0.1, 0, op.h / 2, 0.3, dark);
      break;
    }
  }
}

function buildDevice(d) {
  const p = devicePose(d);
  const z = p.z || 0;
  const add = (geo, m, x, y, h) => { const mesh = new THREE.Mesh(geo, m); mesh.position.copy(V(x, y, z + h)); mesh.rotation.y = p.h * DEG; mesh.castShadow = true; root.add(mesh); return mesh; };
  const lit = (col, on) => new THREE.MeshStandardMaterial({ color: on ? col : '#222', emissive: on ? col : '#000', emissiveIntensity: on ? 2 : 0 });
  if (d.type.startsWith('signal') || d.type === 'dwarf') {
    const dwarf = d.type === 'dwarf';
    const H = dwarf ? 0.6 : 3.2;
    add(new THREE.CylinderGeometry(0.08, 0.08, H, 8), mat('#222'), p.x, p.y, H / 2);
    const heads = d.props.heads || 3;
    const cols = heads === 3 ? ['Green', 'Yellow', 'Red'] : ['Green', 'Red'];
    add(new THREE.BoxGeometry(0.35, heads * 0.32 + 0.1, 0.35), mat('#111'), p.x, p.y, H + (heads * 0.32) / 2);
    cols.forEach((cn, i) => {
      const col = { Red: '#ff2020', Yellow: '#ffcc00', Green: '#20ff60' }[cn];
      add(new THREE.SphereGeometry(0.1, 10, 8), lit(col, d.props.aspect === cn), p.x + Math.cos(p.h * DEG) * 0.19, p.y + Math.sin(p.h * DEG) * 0.19, H + 0.2 + (heads - 1 - i) * 0.32);
    });
  } else if (d.type === 'gate') {
    add(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 8), mat('#eee'), p.x, p.y, 1.1);
    const arm = add(new THREE.BoxGeometry(0.12, 0.12, 4), mat('#ff3030'), p.x, p.y, 2);
    arm.position.add(new THREE.Vector3(Math.cos(p.h * DEG) * 0, 0, 0));
  } else if (d.type === 'gap') {
    add(new THREE.BoxGeometry(0.12, 0.2, HO.gauge + 0.3), mat('#111'), p.x, p.y, 0.38);
  } else if (d.type === 'feeder') {
    const t = p.track || p;
    add(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), mat('#d12'), t.x - Math.sin(t.h * DEG) * 0.55, t.y + Math.cos(t.h * DEG) * 0.55, 0.3);
    add(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), mat('#111'), t.x + Math.sin(t.h * DEG) * 0.55, t.y - Math.cos(t.h * DEG) * 0.55, 0.3);
  } else {
    const col = { sensor: '#ff9900', home: '#a050ff', block: '#10c0a0', uncoupler: '#888' }[d.type] || '#fff';
    const m = add(new THREE.BoxGeometry(d.type === 'block' ? 3 : 0.4, 0.12, 0.45), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.6 }), p.x, p.y, 0.3);
    m.castShadow = false;
  }
}

function applyLighting() {
  hemi.intensity = night ? 0.12 : 1.1;
  sun.intensity = night ? 0.05 : 1.6;
  scene.background = new THREE.Color(night ? '#0b1020' : '#9cc4e4');
  scene.children.filter((o) => o.userData.lamp).forEach((o) => scene.remove(o));
  if (night) lampLights.slice(0, 16).forEach((p) => {
    const l = new THREE.PointLight('#ffd27a', 40, 30, 1.5);
    l.position.copy(p); l.userData.lamp = true; scene.add(l);
  });
}
export function setNight(v) { night = v; applyLighting(); }

// ---------- test train ----------
export function startTrain() {
  const P = state.project;
  const sel = [...state.selection].find((id) => P.pieces.some((p) => p.id === id));
  const pc = P.pieces.find((p) => p.id === sel) || P.pieces[0];
  if (!pc) return false;
  stopTrain();
  const colors = ['#c8102e', '#2b4c7e', '#2b7e4c', '#7e6a2b'];
  const mesh = colors.map((col, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(i ? 6.5 : 7, 1.3, 1.2), mat(col));
    body.position.y = 1.1; body.castShadow = true; g.add(body);
    if (!i) { const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.2), mat('#222')); cab.position.set(2.2, 1.95, 0); g.add(cab); }
    root.add(g); return g;
  });
  train = { pieceId: pc.id, route: TURNOUT_KINDS.includes(pc.kind) ? pc.state || 0 : 0, d: 0, dir: 1, speed: 12, mesh, hist: [], odo: 0, curv: null, straight: Infinity, halted: null };
  // put the cars on the track behind the locomotive
  train.hist.push({ ...routeSampleWorld(pc, train.route, 0), odo: 0 });
  return true;
}
export function stopTrain() { if (train) { train.mesh.forEach((m) => root.remove(m)); if (train.marker) root.remove(train.marker); } train = null; cab = false; }
let trainListener = () => {};
export function onTrainEvent(fn) { trainListener = fn; }
export function trainHalted() { return train?.halted || null; }
export function trainRunning() { return !!train; }
export function setCab(v) { cab = v && !!train; if (!cab) resetCamera(); }
export function setSpeed(v) { if (train) train.speed = v; }

function stepTrain(dt) {
  if (train.halted) { if (cab) placeCab(); return; }
  // moveTrain follows connections and turnout settings and reports anything a real train
  // couldn't get past: derailments, collisions with structures, stalls on steep grades …
  const ev = moveTrain(train, train.speed * dt);
  const c = getCache().map.get(train.pieceId);
  if (!c) return stopTrain();
  const pc = c.pc;
  const w = routeSampleWorld(pc, train.route, train.d);
  const h = w.h + (train.dir < 0 ? 180 : 0);
  train.odo += train.speed * dt;
  train.hist.unshift({ x: w.x, y: w.y, z: w.z, h, odo: train.odo });
  if (train.hist.length > 4000) train.hist.length = 4000;
  train.mesh.forEach((m, i) => {
    const target = train.odo - i * 7.3;
    const hp = train.hist.find((q) => q.odo <= target) || train.hist[train.hist.length - 1];
    m.position.copy(V(hp.x, hp.y, hp.z + 0.3));
    m.rotation.y = hp.h * DEG;
  });
  train.cabPose = { x: w.x, y: w.y, z: w.z, h };
  if (ev && ev.kind !== 'end') haltTrain(ev); // after positioning, so the derailed cars stay tipped
  if (cab) placeCab();
}

function placeCab() {
  const p = train.cabPose;
  if (!p) return;
  const fwd = V(Math.cos(p.h * DEG), Math.sin(p.h * DEG), 0);
  camera.position.copy(V(p.x, p.y, p.z + 2.4)).addScaledVector(fwd, 3.6);
  camera.lookAt(camera.position.clone().add(fwd.multiplyScalar(10)).add(new THREE.Vector3(0, -0.4, 0)));
}

// Stop the train where the problem is. Derailments tip the leading cars off the rails.
function haltTrain(ev) {
  train.halted = ev;
  if (ev.kind === 'derail') {
    train.mesh.slice(0, 2).forEach((m, i) => { m.rotation.z = (i ? -0.25 : 0.45); m.rotation.x = i ? 0.15 : -0.3; m.position.y -= 0.3; m.position.x += 0.6 * (i ? -1 : 1); });
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.18, 8, 32), new THREE.MeshStandardMaterial({ color: ev.kind === 'derail' ? '#ff2a2a' : '#ffb02d', emissive: ev.kind === 'derail' ? '#ff2a2a' : '#ffb02d', emissiveIntensity: 1.2 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.copy(V(ev.at.x, ev.at.y, (ev.at.z || 0) + 0.5));
  train.marker = ring; root.add(ring);
  trainListener(ev);
}

// Point the camera from `eye` at `target` (model coords {x,y,z}); used for inspection and tests
export function lookAt(eye, target) {
  cab = false;
  controls.target.copy(V(target.x, target.y, target.z || 0));
  camera.position.copy(V(eye.x, eye.y, eye.z));
  controls.update();
}
export function trainPose() { return train?.cabPose || null; }

export function snapshot3D() { return renderer.domElement.toDataURL('image/png'); }
