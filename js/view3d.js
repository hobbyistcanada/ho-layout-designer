// 3D preview with three.js: benchwork, track with grades & piers, scenery, devices, test train.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, getCache, routeSampleWorld } from './model.js';
import { HO } from './catalog.js';
import { DEG, sampleRoute, toWorld } from './geometry.js';
import { devicePose } from './editor2d.js';

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
  for (const o of P.scenery) buildScenery(o);
  for (const d of P.devices) buildDevice(d);
  applyLighting();
  if (!camera.userData.placed) { resetCamera(); camera.userData.placed = true; }
  if (train) train.mesh.forEach((m) => root.add(m));
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
        beam(pts, 0, HO.ballastW + 1, -0.6, 0, ply);
        // piers every ~8"
        for (let i = 0; i < pts.length; i += 16) {
          const p = pts[i];
          if (p.z < 1) continue;
          const h = p.z - 0.6;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, h, 0.8), pier);
          m.position.copy(V(p.x, p.y, h / 2)); m.castShadow = true; root.add(m);
        }
      }
      for (const s of [HO.gauge / 2, -HO.gauge / 2]) beam(pts, s, 0.07, 0.25, 0.42, rail, false);
      // ties
      const r = c.g.routes[ri];
      for (const lp of sampleRoute(r, HO.tieSpacing)) {
        const w = toWorld(c.pc, lp);
        ties.push({ x: w.x, y: w.y, h: w.h, z: c.pc.z + (c.pc.grade / 100) * lp.d });
      }
    });
  }
  if (ties.length) {
    const im = new THREE.InstancedMesh(tieGeo, mat('#4a3626'), ties.length);
    const o = new THREE.Object3D();
    ties.forEach((t, i) => { o.position.copy(V(t.x, t.y, t.z + 0.22)); o.rotation.set(0, t.h * DEG, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
    im.receiveShadow = true;
    root.add(im);
  }
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
    case 'hill': {
      const g = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
      const m = placeObj(new THREE.Mesh(g, mat(c)), o, 0);
      m.scale.set(o.w / 2, o.h, o.d / 2);
      break;
    }
    case 'portal': {
      placeObj(new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat(c)), o, o.h / 2);
      const hole = new THREE.Mesh(new THREE.BoxGeometry(o.w * 0.55, o.h * 0.7, o.d + 0.05), mat('#111'));
      placeObj(hole, o, o.h * 0.35);
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
  train = { pieceId: pc.id, route: pc.state || 0, d: 0, dir: 1, speed: 12, mesh, hist: [], odo: 0 };
  return true;
}
export function stopTrain() { if (train) train.mesh.forEach((m) => root.remove(m)); train = null; cab = false; }
export function trainRunning() { return !!train; }
export function setCab(v) { cab = v && !!train; if (!cab) resetCamera(); }
export function setSpeed(v) { if (train) train.speed = v; }

function stepTrain(dt) {
  const C = getCache();
  let c = C.map.get(train.pieceId);
  if (!c) return stopTrain();
  let move = train.speed * dt;
  let guard = 0;
  while (move > 0 && guard++ < 20) {
    const L = c.g.routes[train.route].len;
    const nd = train.d + move * train.dir;
    if (nd >= 0 && nd <= L) { train.d = nd; move = 0; break; }
    const over = train.dir > 0 ? nd - L : -nd;
    const end = train.dir > 0 ? 'e' : 's';
    const epi = c.eps.findIndex((e) => e.refs.some((r) => r.route === train.route && r.end === end));
    const link = epi >= 0 ? c.links[epi] : null;
    if (!link) { train.dir *= -1; train.d = train.dir > 0 ? 0 : L; move = over; continue; }
    const nc = C.map.get(link.id);
    const ep = nc.eps[link.ep];
    const ref = ep.refs.find((r) => r.route === (nc.pc.state || 0)) || ep.refs[0];
    c = nc; train.pieceId = nc.pc.id; train.route = ref.route;
    train.dir = ref.end === 's' ? 1 : -1;
    train.d = ref.end === 's' ? 0 : nc.g.routes[ref.route].len;
    move = over;
  }
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
  if (cab) {
    const fwd = V(Math.cos(h * DEG), Math.sin(h * DEG), 0);
    camera.position.copy(V(w.x, w.y, w.z + 2.4)).addScaledVector(fwd, 3.6);
    camera.lookAt(camera.position.clone().add(fwd.multiplyScalar(10)).add(new THREE.Vector3(0, -0.4, 0)));
  }
}

export function snapshot3D() { return renderer.domElement.toDataURL('image/png'); }
