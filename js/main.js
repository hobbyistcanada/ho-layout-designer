// App wiring: panels, properties, levels, checks, files, keyboard.
import { TRACK, TRACK_BY_ID, DEVICES, DEVICE_BY_ID, SCENERY, BOARD_PRESETS, buildGeometry } from './catalog.js';
import { state, emit, begin, changed, commit, doUndo, doRedo, addPiece, flipLast, deleteSelection, findItem, itemType, loadAutosave, loadProject, newProject, resetProject, getCache, alignTo, invalidate, advanceTarget } from './model.js';
import { ed, initEditor, draw, fitView, setMode, rotateSelection, toggleTurnout, centerOn, fmt, exportPNG } from './editor2d.js';
import { runChecks, billOfMaterials, controlSchedule, toCSV } from './checks.js';
import { sampleRoute, polyArea, toWorld, routeLen } from './geometry.js';
import { SAMPLES } from './samples.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

let v3d = null; // lazily loaded 3D module
let view = '2d';

// ---------------- catalog panels ----------------
function thumb(cat) {
  const c = h('canvas', { width: 44, height: 30 });
  const ctx = c.getContext('2d');
  const g = buildGeometry(cat.kind, cat.params);
  const pts = g.routes.map((r) => sampleRoute(r, 0.5));
  const all = pts.flat();
  if (!all.length) return c;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min(36 / (maxX - minX || 1), 22 / (maxY - minY || 1), 4);
  const ox = 22 - ((minX + maxX) / 2) * s, oy = 15 + ((minY + maxY) / 2) * s;
  ctx.strokeStyle = '#cfd6dd'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  if (g.pit) { ctx.strokeStyle = '#888'; ctx.beginPath(); ctx.arc(ox, oy, g.pit * s, 0, 7); ctx.stroke(); ctx.strokeStyle = '#cfd6dd'; }
  pts.forEach((arr) => { ctx.beginPath(); arr.forEach((p, i) => (i ? ctx.lineTo(p.x * s + ox, -p.y * s + oy) : ctx.moveTo(p.x * s + ox, -p.y * s + oy))); ctx.stroke(); });
  return c;
}

function buildCatalogs() {
  const tl = $('#trackList');
  let group = '';
  for (const t of TRACK) {
    if (t.group !== group) { group = t.group; tl.append(h('h4', {}, group)); }
    tl.append(h('button', { class: 'item', title: 'Add ' + t.name, onclick: () => placeTrack(t.id) }, thumb(t), t.name));
  }
  const dl = $('#deviceList');
  for (const d of DEVICES) dl.append(h('button', { class: 'item', 'data-place': 'device:' + d.id, onclick: () => startPlace('device', d.id) }, h('span', { class: 'dot', style: `background:${d.color}` }, d.icon), d.name));
  const sl = $('#sceneryList');
  for (const o of SCENERY) sl.append(h('button', { class: 'item', 'data-place': 'scenery:' + o.id, onclick: () => startPlace('scenery', o.id) }, h('span', { class: 'dot', style: `background:${o.color}; border-radius:4px` }, ''), o.name));
  const gs = $('#gradeSel');
  gs.append(h('option', { value: 'auto', selected: true }, 'Auto – follow the track'));
  for (let g = -4; g <= 4; g += 0.5) gs.append(h('option', { value: g }, g === 0 ? 'Level (0%)' : `${g > 0 ? '+' : ''}${g}%`));
  gs.title = 'Auto: new track keeps the grade of the track you extend. Pick a grade to change it – the track eases towards it by up to 1% per piece (vertical easement), then holds it.';
  gs.onchange = () => { state.grade = readGrade(); };
  state.grade = readGrade();
}

const r3 = (v) => Math.round(v * 1000) / 1000;
function readGrade() { const v = $('#gradeSel').value; return v === 'auto' ? 'auto' : +v; }

function placeTrack(id) {
  setMode('select'); markPlace(null);
  let at = null;
  if (!state.target) {
    // drop near the view centre, snapped to the grid
    const c = { x: (ed.w / 2 - ed.tx) / ed.s, y: -(ed.h / 2 - ed.ty) / ed.s };
    at = { x: Math.round(c.x), y: Math.round(c.y) };
  }
  addPiece(id, at);
}

function startPlace(kind, id) {
  setMode('place', { kind, id });
  markPlace(kind + ':' + id);
  status(`Placing ${kind === 'device' ? DEVICE_BY_ID[id].name : id} – click to place, Esc to stop`);
}
function markPlace(key) { $$('[data-place]').forEach((b) => b.classList.toggle('on', b.dataset.place === key)); }

// ---------------- properties ----------------
const MOTORS = ['', 'Manual / ground throw', 'Twin-coil (snap)', 'Stall motor (Tortoise-type)', 'Servo (Arduino/PCA9685)', 'Solenoid w/ CDU'];
const OPTIONS = {
  aspect: ['Red', 'Yellow', 'Green'], sensorType: ['IR', 'Reed', 'Hall', 'Current', 'Optical (LDR)', 'Microswitch'],
  heads: [2, 3], rails: ['Both', 'Left', 'Right'], kind: ['Magnetic', 'Electro-magnetic', 'Servo'], bus: ['Main', 'Yard', 'Upper', 'Programming'],
};

function field(label, value, onset, opts = {}) {
  let input;
  if (opts.options) {
    input = h('select', {}, opts.options.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o === '' ? '—' : o]; return h('option', { value: v, selected: String(v) === String(value) }, t); }));
  } else if (opts.type === 'checkbox') {
    input = h('input', { type: 'checkbox', checked: !!value });
  } else {
    input = h('input', { type: opts.type || 'text', value: value ?? '', step: opts.step || 'any' });
  }
  input.addEventListener('change', () => {
    const v = opts.type === 'checkbox' ? input.checked : opts.type === 'number' ? parseFloat(input.value) : input.value;
    if (opts.type === 'number' && isNaN(v)) return;
    begin(); onset(v); changed('props');
  });
  return h('label', { class: 'row' }, label, input);
}

const r2 = (v) => Math.round(v * 1000) / 1000;

function renderProps() {
  const el = $('#props');
  el.innerHTML = '';
  const ids = [...state.selection];
  if (!ids.length) {
    el.append(h('div', { class: 'hint' }, 'Nothing selected. Click a track, device or building. Shift+click adds to the selection.'));
    if (state.target) el.append(h('div', { class: 'hint' }, 'A track end is selected (green). New track parts will attach there.'));
    return;
  }
  if (ids.length > 1) {
    const P = state.project;
    el.append(h('div', {}, `${ids.length} items selected`));
    el.append(field('Move to level', '', (v) => ids.forEach((id) => { const it = findItem(id); if (itemType(id) === 'piece' && v) it.level = v; }), { options: [['', '—'], ...P.levels.map((l) => [l.id, l.name])] }));
    el.append(field('Raise / lower by (in)', 0, (v) => ids.forEach((id) => { const it = findItem(id); if (itemType(id) === 'piece') it.z += v; else if (itemType(id) === 'scenery') it.base = (it.base || 0) + v; }), { type: 'number' }));
    return;
  }
  const id = ids[0], it = findItem(id), t = itemType(id);
  if (!it) return;
  if (t === 'piece') {
    const cat = TRACK_BY_ID[it.cat];
    el.append(h('h5', {}, cat ? cat.name : it.kind));
    el.append(field('Name', it.props.name, (v) => (it.props.name = v)));
    for (const [k, v] of Object.entries(it.params)) {
      if (k === 'hand') el.append(field('Hand', v, (nv) => (it.params.hand = nv), { options: [['L', 'Left'], ['R', 'Right']] }));
      else if (k === 'stalls') el.append(field('Stall angles (°)', v, (nv) => (it.params.stalls = nv)));
      else el.append(field({ len: 'Length (in)', r: 'Radius (in)', angle: 'Angle (°)', tail: 'Tail (in)', d: 'Diameter (in)', r1: 'Radius 1', a1: 'Angle 1', r2: 'Radius 2', a2: 'Angle 2' }[k] || k, v, (nv) => (it.params[k] = nv), { type: 'number' }));
    }
    el.append(h('h5', {}, 'Position'));
    el.append(field('X (in)', r2(it.x), (v) => (it.x = v), { type: 'number' }));
    el.append(field('Y (in)', r2(it.y), (v) => (it.y = v), { type: 'number' }));
    el.append(field('Rotation (°)', r2(it.rot), (v) => (it.rot = v), { type: 'number' }));
    const graded = it.kind === 'straight' || it.kind === 'curve';
    const len = routeLen(buildGeometry(it.kind, it.params).routes[0]);
    const endZ = it.z + (it.grade / 100) * len;
    el.append(field('Height at end A (in)', r3(it.z), (v) => { if (graded) { const e = it.z + (it.grade / 100) * len; it.z = v; it.grade = Math.round(((e - v) / len) * 100000) / 1000; } else it.z = v; }, { type: 'number', step: 0.125 }));
    if (graded) {
      el.append(field('Height at end B (in)', r3(endZ), (v) => { it.grade = Math.round(((v - it.z) / len) * 100000) / 1000; }, { type: 'number', step: 0.125 }));
      el.append(field('Grade A→B (%)', r3(it.grade), (v) => (it.grade = v), { type: 'number', step: 0.25 }));
      el.append(h('div', { class: 'hint' }, 'Ends A and B are labelled on the plan. Change either height and the grade follows; the other end stays put.'));
    }
    el.append(field('Level', it.level, (v) => (it.level = v), { options: state.project.levels.map((l) => [l.id, l.name]) }));
    const nRoutes = buildGeometry(it.kind, it.params).routes.length;
    if (['turnout', 'wye', 'curvedTurnout'].includes(it.kind)) {
      el.append(h('h5', {}, 'Turnout control'));
      el.append(field('Position', it.state || 0, (v) => (it.state = +v), { options: it.kind === 'wye' ? [[0, 'Left'], [1, 'Right']] : [[0, 'Normal (closed)'], [1, 'Diverging (thrown)']] }));
      el.append(field('Address / pin', it.props.address, (v) => (it.props.address = v)));
      el.append(field('Motor', it.props.motor, (v) => (it.props.motor = v), { options: MOTORS }));
    } else if (it.kind === 'turntable') {
      el.append(field('Bridge to stall', it.state || 0, (v) => (it.state = +v), { options: Array.from({ length: nRoutes }, (_, i) => [i, `Stall ${i + 1}`]) }));
      el.append(field('Address / pin', it.props.address, (v) => (it.props.address = v)));
    }
  } else if (t === 'device') {
    el.append(h('h5', {}, it.name));
    el.append(field('Name / ID', it.props.name, (v) => (it.props.name = v)));
    el.append(field('Address / pin', it.props.address, (v) => (it.props.address = v)));
    for (const [k, v] of Object.entries(it.props)) {
      if (['name', 'address', 'notes'].includes(k)) continue;
      el.append(field(k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v, (nv) => (it.props[k] = k === 'heads' ? +nv : nv), OPTIONS[k] ? { options: OPTIONS[k] } : {}));
    }
    if (it.pieceId) {
      el.append(field('Side of track', it.side || 1, (v) => (it.side = +v), { options: [[1, 'Right'], [-1, 'Left']] }));
      el.append(field('Face other way', it.flip, (v) => (it.flip = v), { type: 'checkbox' }));
    }
    el.append(field('Notes', it.props.notes, (v) => (it.props.notes = v)));
    el.append(h('div', { class: 'hint' }, it.pieceId ? 'Attached to track – drag to move it along the rails.' : 'Not on a track. Drag it onto a track.'));
  } else {
    el.append(h('h5', {}, it.name));
    el.append(field('Label', it.props?.name, (v) => { it.props = it.props || {}; it.props.name = v; }));
    el.append(field('Width (in)', it.w, (v) => (it.w = v), { type: 'number' }));
    el.append(field('Depth (in)', it.d, (v) => (it.d = v), { type: 'number' }));
    el.append(field('Height (in)', it.h, (v) => (it.h = v), { type: 'number' }));
    el.append(field('Rotation (°)', it.rot, (v) => (it.rot = v), { type: 'number' }));
    el.append(field('Base height (in)', it.base || 0, (v) => (it.base = v), { type: 'number' }));
    el.append(field('Colour', it.color, (v) => (it.color = v), { type: 'color' }));
    if (it.shape === 'box') el.append(field('Roof', it.roof, (v) => (it.roof = v), { options: [['flat', 'Flat'], ['gable', 'Gable']] }));
    el.append(h('div', { class: 'hint' }, `Real size ≈ ${(it.w * 87.1 / 12).toFixed(0)} × ${(it.d * 87.1 / 12).toFixed(0)} ft footprint, ${(it.h * 87.1 / 12).toFixed(0)} ft tall`));
  }
}

// ---------------- levels & rules ----------------
function renderLevels() {
  const P = state.project, el = $('#levels');
  el.innerHTML = '';
  el.append(h('div', { class: 'lvl hint' }, h('span', {}, '✎'), h('span', {}, ''), h('span', {}, 'Name'), h('span', {}, 'Height'), h('span', { title: 'Visible' }, '👁'), h('span', {}, '')));
  for (const l of P.levels) {
    el.append(h('div', { class: 'lvl' },
      h('input', { type: 'radio', name: 'actLvl', checked: P.activeLevel === l.id, title: 'Active level (new track goes here)', onchange: () => { P.activeLevel = l.id; commit(); emit('levels'); } }),
      h('input', { type: 'color', value: l.color, onchange: (e) => { begin(); l.color = e.target.value; changed('levels'); } }),
      h('input', { type: 'text', value: l.name, onchange: (e) => { begin(); l.name = e.target.value; changed('levels'); } }),
      h('input', { type: 'number', value: l.elevation, step: 0.25, title: 'Default rail height (in) for new track on this level', onchange: (e) => { begin(); l.elevation = +e.target.value; changed('levels'); } }),
      h('input', { type: 'checkbox', checked: l.visible, title: 'Show / hide', onchange: (e) => { begin(); l.visible = e.target.checked; changed('levels'); } }),
      h('button', { title: 'Delete level (track moves to first level)', onclick: () => {
        if (P.levels.length < 2) return;
        begin(); P.levels = P.levels.filter((x) => x !== l);
        P.pieces.forEach((pc) => { if (pc.level === l.id) pc.level = P.levels[0].id; });
        if (P.activeLevel === l.id) P.activeLevel = P.levels[0].id;
        changed('levels');
      } }, '×'),
    ));
  }
}

function renderRules() {
  const S = state.project.settings, el = $('#rules');
  el.innerHTML = '';
  el.append(field('Min. radius (in)', S.minRadius, (v) => (S.minRadius = v), { type: 'number' }));
  el.append(field('Max. grade (%)', S.maxGrade, (v) => (S.maxGrade = v), { type: 'number', step: 0.25 }));
  el.append(field('Rail-to-rail clearance (in)', S.clearance, (v) => (S.clearance = v), { type: 'number', step: 0.25 }));
  el.append(field('Max. effective grade (%)', S.maxEffGrade ?? 3, (v) => (S.maxEffGrade = v), { type: 'number', step: 0.25 }));
  el.append(field('Tallest car above rail (in)', S.carHeight ?? 3, (v) => (S.carHeight = v), { type: 'number', step: 0.125 }));
  el.append(field('Upper deck thickness (in)', S.deckThickness ?? 0.5, (v) => (S.deckThickness = v), { type: 'number', step: 0.125 }));
  el.append(field('Longest car (in)', S.carLength ?? 8, (v) => (S.carLength = v), { type: 'number', step: 0.5 }));
  el.append(field('Grid (in)', S.grid, (v) => (S.grid = v), { type: 'number', step: 0.25 }));
  el.append(h('div', { class: 'hint' }, 'Typical HO: 18" min radius for short equipment (22–24"+ for long cars), 2–2.5% max grade. Curves add about 32/R % of drag, so keep grade + 32/R under ~3%. Overhead: the tallest car (3" classic, ~3.25" modern hi-cubes, ~4" double stacks) must clear the underside of the deck above. S-curves need a straight one car long between curves under 30" radius. Ease grade changes over 1½ car lengths or more.'));
}

// ---------------- checks ----------------
let checkTimer = 0;
function scheduleChecks() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    const issues = runChecks();
    ed.issues = issues;
    const el = $('#issues');
    el.innerHTML = '';
    const bad = issues.filter((i) => i.level !== 'info').length;
    const badge = $('#issueCount');
    badge.textContent = bad ? bad : '✓';
    badge.className = 'badge' + (bad ? '' : ' ok');
    if (!issues.length) el.append(h('div', { class: 'hint' }, 'No problems found.'));
    issues.slice(0, 200).forEach((is) => el.append(h('div', { class: 'issue ' + is.level, onclick: () => { if (is.at) centerOn(is.at); if (is.id) { state.selection = new Set([is.id]); renderProps(); } draw(); } }, is.msg)));
    draw();
  }, 150);
}

// ---------------- board ----------------
function renderPresetFields() {
  const pr = BOARD_PRESETS[$('#presetSel').value];
  const el = $('#presetFields');
  el.innerHTML = '';
  for (const [k, v] of Object.entries(pr.fields)) el.append(h('label', { class: 'row' }, `${k} (in)`, h('input', { type: 'number', 'data-k': k, value: v })));
}
function renderBoardInfo() {
  const B = state.project.board;
  $('#boardColor').value = B.color || '#c9a66b';
  $('#boardThick').value = B.thickness || 0.75;
  const a = Math.abs(polyArea(B.outline));
  $('#boardInfo').textContent = `${B.outline.length} corners · area ${(a / 144).toFixed(1)} sq ft (${(a * 6.4516 / 10000).toFixed(2)} m²)`;
}

// ---------------- test train messages ----------------
function showTrainEvent(ev) {
  const box = $('#trainMsg');
  const derail = ev.kind === 'derail';
  box.className = derail ? 'derail' : 'stop';
  box.innerHTML = '';
  box.append(
    h('div', { class: 'tmTitle' }, derail ? '⚠ Derailed / collision' : '⛔ Train stopped'),
    h('div', {}, ev.msg),
    h('div', { class: 'tmBtns' },
      h('button', { onclick: () => { setView('split'); setTimeout(() => { centerOn(ev.at); if (ev.id) { state.selection = new Set([ev.id]); renderProps(); } draw(); }, 80); } }, 'Show on plan'),
      h('button', { onclick: () => { box.className = 'hidden'; v3d?.stopTrain(); $('#b3Train').textContent = '▶ Test train'; $('#b3Cab').classList.remove('on'); } }, 'Clear train')),
  );
  status((derail ? 'Train derailed: ' : 'Train stopped: ') + ev.msg);
}

// ---------------- modal / files ----------------
let modalData = null;
function modal(title, body, data = null) {
  $('#mTitle').textContent = title;
  const b = $('#mBody'); b.innerHTML = ''; b.append(body);
  modalData = data; // {text, filename, mime} or {url, filename}
  $('#mCopy').classList.toggle('hidden', !data?.text);
  $('#mDownload').classList.toggle('hidden', !data);
  $('#modal').classList.remove('hidden');
}
$('#mClose').onclick = () => $('#modal').classList.add('hidden');
$('#mCopy').onclick = async () => { try { await navigator.clipboard.writeText(modalData.text); $('#mCopy').textContent = 'Copied!'; setTimeout(() => ($('#mCopy').textContent = 'Copy'), 1200); } catch (e) { const ta = $('#mBody textarea'); if (ta) { ta.select(); document.execCommand('copy'); } } };
$('#mDownload').onclick = () => download(modalData);
function download({ text, url, filename, mime = 'text/plain' }) {
  try {
    const href = url || URL.createObjectURL(new Blob([text], { type: mime }));
    const a = h('a', { href, download: filename });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { /* downloads may be blocked in sandboxed previews */ }
}
const slug = () => (state.project.name || 'layout').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

function table(rows) {
  if (!rows.length) return h('div', { class: 'hint' }, 'Nothing yet.');
  const cols = Object.keys(rows[0]);
  return h('table', {}, h('tr', {}, cols.map((c) => h('th', {}, c))), rows.map((r) => h('tr', {}, cols.map((c) => h('td', {}, String(r[c] ?? ''))))));
}

function help() {
  modal('Quick guide', h('div', { class: 'help' }, h('ol', {},
    h('li', {}, 'Board tab: choose a shape preset (your 96×42 + 20×40 L is the default) or draw any outline.'),
    h('li', {}, 'Track tab: click a part to drop it. Click a red track end to select it (green) – every part you click then attaches there and the next free end is selected automatically.'),
    h('li', {}, 'F flips the last part (e.g. which way a curve or turnout goes). R / Shift+R rotate. Del deletes. T or double-click throws a turnout.'),
    h('li', {}, 'Grades: with Laying grade on "Auto" new track (clicked or dragged onto an end) keeps the grade of the track it continues. Pick a grade (e.g. +2%) to climb, Level to level off, or a minus grade to go down – the track changes by at most 1% per piece, which gives a smooth vertical easement, then holds the new grade. Select a piece to see the heights at its ends A and B; you can type either one and the grade follows.'),
    h('li', {}, 'Control tab: place signals, passing sensors, home sensors, detection blocks, feeders and gaps on the track. Give each an address/pin; "Control table" lists them all as CSV for wiring, Arduino or JMRI.'),
    h('li', {}, 'Checks panel flags tight radii, steep grades, low clearance where tracks cross, overlaps, track off the board and open ends.'),
    h('li', {}, '3D view: orbit with the mouse, run a test train to check that routes connect, try the cab ride and night mode.'),
    h('li', {}, 'Save writes a .json project you can open later or keep in GitHub. Work is also autosaved in this browser.'),
  ), h('p', {}, 'Mouse: wheel = zoom, drag empty space / right-drag = pan.')));
}

// ---------------- 3D ----------------
async function ensure3D() {
  if (v3d) return v3d;
  try {
    v3d = await import('./view3d.js');
    v3d.init3D($('#view3d'));
    v3d.onTrainEvent(showTrainEvent);
    window.hoApp.v3d = v3d;
  } catch (e) {
    console.error(e);
    $('#no3d').classList.remove('hidden');
    v3d = null;
  }
  return v3d;
}

async function setView(v) {
  view = v;
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $('#views').className = 'v-' + v;
  $('#tool3d').classList.toggle('hidden', v === '2d');
  if (v !== '2d') { const m = await ensure3D(); m?.setActive(true); } else v3d?.setActive(false);
  setTimeout(() => { draw(); }, 50);
}

// ---------------- status ----------------
function status(msg) { $('#stInfo').textContent = msg || ''; }
ed.onStatus = (p) => { $('#stCursor').textContent = `x ${fmt(p.x)}  y ${fmt(p.y)}`; };
ed.onSelect = () => renderProps();

// ---------------- events ----------------
state.listeners.add((what) => {
  $('#projName').value = state.project.name;
  $('#units').value = state.project.units;
  renderProps();
  if (what === 'all' || what === 'levels') renderLevels();
  if (what === 'all') renderRules();
  renderBoardInfo();
  scheduleChecks();
  v3d?.markDirty();
  draw();
  $('#stMode').textContent = `${state.project.pieces.length} track parts · ${state.project.devices.length} devices · ${state.project.scenery.length} scenery`;
});

function wire() {
  $$('#leftTabs button').forEach((b) => (b.onclick = () => {
    $$('#leftTabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
  }));
  $$('#toolbar [data-mode]').forEach((b) => (b.onclick = () => selectMode(b.dataset.mode)));
  $$('#viewSeg button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $('#projName').onchange = (e) => { begin(); state.project.name = e.target.value; changed('name'); };
  $('#units').onchange = (e) => { begin(); state.project.units = e.target.value; changed(); };
  $('#bUndo').onclick = doUndo; $('#bRedo').onclick = doRedo;
  $('#bNew').onclick = () => { if (confirmSafe('Start a new project? (Current work stays in undo history)')) { resetProject(); fitView(); } };
  $('#bDemo').onclick = showSamples;
  $('#bOpen').onclick = () => $('#fileIn').click();
  $('#fileIn').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { begin(); loadProject(JSON.parse(await f.text())); changed(); fitView(); } catch (err) { modal('Could not open file', h('div', {}, String(err))); }
    e.target.value = '';
  };
  $('#bSave').onclick = () => {
    const text = JSON.stringify(state.project, null, 2);
    const data = { text, filename: slug() + '.json', mime: 'application/json' };
    download(data);
    modal('Project file', h('div', {}, h('div', { class: 'hint' }, 'The file was downloaded (if your browser allows it). You can also copy the JSON below and save it as a .json file.'), h('textarea', {}, text)), data);
  };
  $('#bPng').onclick = async () => {
    const url = view === '3d' && v3d ? v3d.snapshot3D() : exportPNG();
    modal('Image', h('img', { src: url }), { url, filename: slug() + (view === '3d' ? '-3d' : '-plan') + '.png' });
  };
  $('#bBom').onclick = () => { const rows = billOfMaterials(); modal('Parts list', table(rows), { text: toCSV(rows), filename: slug() + '-parts.csv', mime: 'text/csv' }); };
  $('#bSched').onclick = () => { const rows = controlSchedule(); modal('Control table – turnouts, signals & sensors', table(rows), { text: toCSV(rows), filename: slug() + '-control.csv', mime: 'text/csv' }); };
  $('#bHelp').onclick = help;
  $('#tRotL').onclick = () => rotateSelection(15);
  $('#tRotR').onclick = () => rotateSelection(-15);
  $('#tFlip').onclick = () => flipLast();
  $('#tToggle').onclick = throwSelected;
  $('#tDel').onclick = deleteSelection;
  $('#tFit').onclick = fitView;
  $('#cElev').onchange = (e) => { ed.showElev = e.target.checked; draw(); };
  $('#cDim').onchange = (e) => { ed.dimOthers = e.target.checked; draw(); };
  $('#cSnap').onchange = (e) => { state.project.settings.snap = e.target.checked; };
  $('#bAddLevel').onclick = () => {
    const P = state.project; begin();
    const top = Math.max(...P.levels.map((l) => l.elevation), 0);
    const id = 'L' + Date.now().toString(36);
    const colors = ['#3f6fb5', '#b5523f', '#3fb56a', '#a63fb5', '#b5a33f'];
    P.levels.push({ id, name: `Level ${P.levels.length + 1}`, elevation: top + 4, visible: true, color: colors[P.levels.length % colors.length] });
    P.activeLevel = id; changed('levels');
  };
  // board
  const ps = $('#presetSel');
  for (const [k, v] of Object.entries(BOARD_PRESETS)) ps.append(h('option', { value: k }, v.name));
  ps.value = 'myL'; ps.onchange = renderPresetFields; renderPresetFields();
  $('#bApplyPreset').onclick = () => {
    const vals = {}; $$('#presetFields input').forEach((i) => (vals[i.dataset.k] = +i.value));
    begin(); state.project.board.outline = BOARD_PRESETS[ps.value].make(vals); changed('board'); fitView();
  };
  $('#bDrawBoard').onclick = () => { selectMode('drawBoard'); status('Click corners; double-click or click the first corner to finish. Esc cancels.'); };
  $('#bEditBoard').onclick = () => { selectMode('board'); status('Drag corners · double-click an edge to add · right-click a corner to delete · Esc when done'); };
  $('#boardColor').onchange = (e) => { begin(); state.project.board.color = e.target.value; changed('board'); };
  $('#boardThick').onchange = (e) => { begin(); state.project.board.thickness = +e.target.value; changed('board'); };
  // 3d
  $('#b3Reset').onclick = () => v3d?.resetCamera();
  $('#b3Top').onclick = () => v3d?.resetCamera(true);
  let nightOn = false;
  $('#b3Night').onclick = () => { nightOn = !nightOn; v3d?.setNight(nightOn); $('#b3Night').classList.toggle('on', nightOn); };
  $('#b3Train').onclick = () => {
    if (!v3d) return;
    $('#trainMsg').className = 'hidden';
    if (v3d.trainRunning()) { v3d.stopTrain(); $('#b3Train').textContent = '▶ Test train'; $('#b3Cab').classList.remove('on'); }
    else if (v3d.startTrain()) { v3d.setSpeed(+$('#b3Speed').value); $('#b3Train').textContent = '■ Stop train'; }
  };
  let cabOn = false;
  $('#b3Cab').onclick = () => { if (!v3d?.trainRunning()) return; cabOn = !cabOn; v3d.setCab(cabOn); $('#b3Cab').classList.toggle('on', cabOn); };
  $('#b3Speed').oninput = (e) => v3d?.setSpeed(+e.target.value);

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); $('#bSave').click(); return; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); }
    else if (k === 'r') rotateSelection(e.shiftKey ? 15 : -15);
    else if (k === 'f') flipLast();
    else if (k === 't') throwSelected();
    else if (k === 'v') selectMode('select');
    else if (k === 'm') selectMode('measure');
    else if (k === 'escape') { state.target = null; state.lastAttach = null; selectMode('select'); $('#modal').classList.add('hidden'); emit('target'); }
  });
}

function selectMode(m) {
  setMode(m); markPlace(null); status('');
  $$('#toolbar [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}
function throwSelected() {
  for (const id of state.selection) { const it = findItem(id); if (itemType(id) === 'piece') toggleTurnout(it); }
}
function confirmSafe(msg) { try { return window.confirm(msg); } catch (e) { return true; } }

// ---------------- sample gallery ----------------
// Small plan preview of a project: board outline plus track coloured by level.
function planThumb(P, W = 240, H = 130) {
  const c = h('canvas', { width: W * 2, height: H * 2, style: `width:${W}px;height:${H}px` });
  const ctx = c.getContext('2d'); ctx.scale(2, 2);
  const O = P.board.outline, xs = O.map((p) => p.x), ys = O.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - 10) / (maxX - minX), (H - 10) / (maxY - minY));
  const ox = (W - (maxX - minX) * s) / 2 - minX * s, oy = (H + (maxY - minY) * s) / 2 + minY * s;
  const X = (p) => p.x * s + ox, Y = (p) => oy - p.y * s;
  ctx.fillStyle = '#c9a66b'; ctx.beginPath(); O.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)))); ctx.closePath(); ctx.fill();
  for (const o of P.scenery) {
    if (!['hill', 'water', 'river'].includes(o.shape)) continue;
    ctx.save(); ctx.translate(X(o), Y(o)); ctx.rotate(-(o.rot || 0) * Math.PI / 180); ctx.fillStyle = o.color; ctx.globalAlpha = 0.7; ctx.beginPath();
    if (o.shape === 'river') ctx.rect(-o.w * s / 2, -o.d * s / 2, o.w * s, o.d * s); else ctx.ellipse(0, 0, o.w * s / 2, o.d * s / 2, 0, 0, 7);
    ctx.fill(); ctx.restore();
  }
  const levels = Object.fromEntries(P.levels.map((l) => [l.id, l.color]));
  for (const pc of [...P.pieces].sort((a, b) => a.z - b.z)) {
    ctx.strokeStyle = levels[pc.level] || '#333'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (const r of buildGeometry(pc.kind, pc.params).routes) {
      ctx.beginPath(); sampleRoute(r, 1).forEach((lp, i) => { const w = toWorld(pc, lp); i ? ctx.lineTo(X(w), Y(w)) : ctx.moveTo(X(w), Y(w)); }); ctx.stroke();
    }
  }
  return c;
}

function showSamples() {
  const pick = (fn) => { $('#modal').classList.add('hidden'); fn(); fitView(); };
  const card = (title, size, blurb, features, thumb, fn) => h('button', { class: 'sampleCard', onclick: () => pick(fn) },
    thumb, h('div', { class: 'sTitle' }, title, h('span', { class: 'sSize' }, size)), h('div', { class: 'sBlurb' }, blurb),
    h('div', { class: 'sTags' }, features.map((f) => h('span', {}, f))));
  const cards = [card('Starter oval', '8 × 3½ ft + plank', 'A small oval with a siding, a spur on the upper level, and a few signals and sensors. A good first look at the tools.', ['sectional track', '2 levels'], h('div', { class: 'sNoThumb' }, '🚂'), buildDemo)];
  for (const S of SAMPLES) {
    let P = null;
    try { P = S.build(); } catch (err) { console.error(S.id, err); continue; }
    cards.push(card(S.name, S.size, S.blurb, S.features, planThumb(P), () => { begin(); loadProject(S.build()); state.grade = readGrade(); changed(); }));
  }
  modal('Sample layouts', h('div', {}, h('div', { class: 'hint' }, 'Loading a sample replaces the current plan (Undo brings it back). Open the 3D view and press Test train to explore it.'), h('div', { class: 'sampleGrid' }, cards)));
}

// ---------------- sample layout ----------------
function buildDemo() {
  begin();
  loadProject(newProject());
  const P = state.project;
  P.name = 'Sample – oval with siding and upper spur';
  const lay = (id, k = 0) => {
    const pc = addPiece(id, null);
    if (k && state.lastAttach) { const T = state.lastAttach.T; alignTo(pc, k, T, state.lastAttach.g ?? 0); state.lastAttach.k = k; invalidate(); advanceTarget(pc, T); }
    return pc;
  };
  const endOf = (pc, route) => { const c = getCache().map.get(pc.id); return c.eps.findIndex((e) => e.refs.some((r) => r.route === route && r.end === 'e')); };
  // lower oval, R18 curves
  state.target = null; state.grade = 0;
  const first = addPiece('s9', { x: 24, y: 3 });
  lay('s9');
  const to = lay('snapL');
  state.target = { pieceId: to.id, ep: endOf(to, 0) };
  lay('s9'); lay('s9');
  for (let i = 0; i < 6; i++) lay('r18');
  const back = [];
  for (let i = 0; i < 5; i++) back.push(lay('s9'));
  for (let i = 0; i < 6; i++) lay('r18');
  // siding from the turnout's diverging leg
  state.target = { pieceId: to.id, ep: endOf(to, 1) };
  lay('s9'); // a car-length straight before curving back avoids an R18/R18 S-curve
  lay('r18', 1);
  lay('s9');
  const bump = lay('bumper', 1);
  // upper-level spur on the plank (sits on piers in 3D)
  P.activeLevel = 'L1';
  state.target = null;
  const spur = addPiece('s9', { x: 58, y: 52 });
  lay('s9'); lay('s9');
  lay('bumper', 1);
  state.target = { pieceId: spur.id, ep: 0 };
  lay('bumper');
  P.activeLevel = 'L0';
  state.grade = readGrade();
  // devices
  const dev = (type, pc, d, extra = {}) => {
    const cat = DEVICE_BY_ID[type];
    P.devices.push({ id: 'd' + Math.random().toString(36).slice(2, 7), type, name: cat.name, x: 0, y: 0, rot: 0, side: 1, flip: false, pieceId: pc.id, route: 0, d, props: { name: '', address: '', notes: '', ...cat.props, ...extra } });
  };
  to.props = { name: 'T1', address: 'Servo 1', motor: 'Servo (Arduino/PCA9685)' };
  dev('signal3', first, 2, { name: 'SIG1', address: 'D4' });
  dev('sensor', back[2], 4.5, { name: 'PS1', address: 'A0' });
  dev('home', bump, 1, { name: 'H1', address: 'D7' });
  dev('feeder', back[0], 4, { name: 'F1' });
  dev('gap', to, 8.9, { name: 'G1' });
  // scenery
  const sc = (id, x, y, rot = 0) => { const c = SCENERY.find((s) => s.id === id); P.scenery.push({ id: 'o' + Math.random().toString(36).slice(2, 7), type: id, name: c.name, shape: c.shape, x, y, rot, w: c.w, d: c.d, h: c.h, roof: c.roof || 'flat', color: c.color, base: 0, props: { name: '' } }); };
  sc('station', 50, 33.2); sc('platform', 50, 37.0); // platform edge 5'2" from the track sc('enginehouse', 74, 57);
  sc('house', 30, 22); sc('house', 38, 22, 90); sc('factory', 62, 20);
  sc('road', 36, 16); sc('light', 30, 18); sc('light', 44, 18); sc('light', 58, 28);
  sc('pine', 14, 21); sc('pine', 17, 25); sc('oak', 82, 24); sc('water', 22, 30); sc('pine', 62, 59); sc('pine', 90, 46);
  state.target = null; state.selection.clear();
  changed();
}

// ---------------- boot ----------------
window.hoApp = { state, ed }; // handy for debugging from the console
initEditor($('#plan'));
buildCatalogs();
wire();
if (!loadAutosave()) commit();
emit();
setTimeout(fitView, 30);
