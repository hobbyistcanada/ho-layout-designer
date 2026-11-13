// Run: node tests/realism.test.mjs
// Small hand-built layouts, each with one deliberate problem, to prove the checks and the test
// train catch it (and that a clean layout passes).
import { newProject, loadProject } from '../js/model.js';
import { runChecks } from '../js/checks.js';
import { moveTrain, supports } from '../js/realism.js';
import { buildGeometry } from '../js/catalog.js';
import { routeEnd, toWorld, routeLen } from '../js/geometry.js';

let n = 0, failed = 0;
const pcs = [];
function proj(extra = {}) {
  const P = newProject();
  P.board.outline = [{ x: -200, y: -200 }, { x: 400, y: -200 }, { x: 400, y: 400 }, { x: -200, y: 400 }];
  P.pieces = []; P.devices = []; P.scenery = [];
  Object.assign(P.settings, extra);
  return P;
}
// lay a chain: items are ['s', len, grade] or ['c', r, angle, grade]; returns pieces
function chain(P, x, y, h, z, items) {
  const out = [];
  for (const it of items) {
    const right = it[0] === 'c' && it[2] < 0;
    const params = it[0] === 's' ? { len: it[1] } : { r: it[1], angle: Math.abs(it[2]) };
    const kind = it[0] === 's' ? 'straight' : 'curve';
    const grade = it[0] === 's' ? it[2] || 0 : it[3] || 0;
    const pc = { id: 't' + (++n).toString(36), cat: kind === 'straight' ? 'flex' : 'cflex', kind, params, x, y, rot: h, z, grade, level: 'L0', state: 0, props: {} };
    if (right) {
      // right-hand curve = left curve laid backwards from the far end
      const r = it[1], a = Math.abs(it[2]) * Math.PI / 180, hr = h * Math.PI / 180;
      const cx = x + r * Math.sin(hr), cy = y - r * Math.cos(hr);
      const h2 = h - Math.abs(it[2]), h2r = h2 * Math.PI / 180;
      const ex = cx - r * Math.sin(h2r), ey = cy + r * Math.cos(h2r);
      const L = r * a;
      Object.assign(pc, { x: ex, y: ey, rot: h2 + 180, z: z + (grade / 100) * L, grade: -grade });
      x = ex; y = ey; h = h2; z += (grade / 100) * L;
    } else {
      const g = buildGeometry(kind, params);
      const e = toWorld(pc, routeEnd(g.routes[0]));
      z += (grade / 100) * routeLen(g.routes[0]);
      x = e.x; y = e.y; h = e.h;
    }
    P.pieces.push(pc); out.push(pc);
  }
  return out;
}
const bumper = (P, pc, atEnd = true) => {
  const g = buildGeometry(pc.kind, pc.params);
  const e = toWorld(pc, routeEnd(g.routes[0]));
  const b = { id: 't' + (++n).toString(36), cat: 'bumper', kind: 'bumper', params: { len: 2 }, x: e.x, y: e.y, rot: e.h, z: pc.z + (pc.grade / 100) * routeLen(g.routes[0]), grade: 0, level: 'L0', state: 0, props: {} };
  P.pieces.push(b); return b;
};
function run(P, startId, dist = 600, dir = 1) {
  loadProject(JSON.parse(JSON.stringify(P)));
  const t = { pieceId: startId, route: 0, d: dir > 0 ? 0 : 1e9, dir, curv: null, straight: Infinity };
  if (dir < 0) t.d = routeLen(buildGeometry(P.pieces.find((p) => p.id === startId).kind, P.pieces.find((p) => p.id === startId).params).routes[0]);
  let ev = null, done = 0;
  while (done < dist) { ev = moveTrain(t, 25); done += 25; if (ev && ev.kind !== 'end') return ev; }
  return null;
}
function expectNone(name, ev) {
  if (ev) failed++;
  console.log(`${ev ? '✗' : '✓'} ${name}${ev ? ` → [${ev.kind}] ${ev.msg}` : ' → runs clean'}`);
}
function expect(name, ev, kind, re) {
  const ok = ev && ev.kind === kind && re.test(ev.msg);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ev ? ` → [${ev.kind}] ${ev.msg}` : ' → no event'}`);
}
function expectIssue(name, P, level, re) {
  loadProject(JSON.parse(JSON.stringify(P)));
  const hit = runChecks().find((i) => i.level === level && re.test(i.msg));
  if (!hit) failed++;
  console.log(`${hit ? '✓' : '✗'} ${name}${hit ? ` → [${hit.level}] ${hit.msg}` : ' → not reported'}`);
}

// 1) clean straight line between bumpers: train only reverses at the bumpers
{
  const P = proj();
  const [a, , c] = chain(P, 0, 0, 0, 0, [['s', 36], ['s', 36], ['s', 36]]);
  bumper(P, c);
  const b0 = { ...bumper(P, a), x: 0, y: 0, rot: 180 }; P.pieces[P.pieces.length - 1] = b0;
  expectNone('clean track: train runs back and forth between bumpers', run(P, a.id, 800));
  loadProject(JSON.parse(JSON.stringify(P)));
  const bad = runChecks().filter((i) => i.level !== 'info');
  console.log(bad.length ? `✗ clean track has issues: ${bad.map((i) => i.msg).join('; ')}` : '✓ clean track: no check issues');
  if (bad.length) failed++;
}
// 2) the user's case: a crossing with only 4" rail-to-rail but a 4.5" double-stack car
{
  const P = proj({ carHeight: 4.5 });
  const [low] = chain(P, 0, 0, 0, 0, [['s', 60]]);
  chain(P, 30, -30, 90, 4, [['s', 60]]);
  expect('4" crossing, 4.5" tall car', run(P, low.id, 60), 'derail', /hits the track above/);
  expectIssue('…also in Checks', P, 'error', /hits the track above/);
}
// 3) ran off the end of the track / misaligned joint
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 24]]);
  expect('open end', run(P, a.id, 60), 'derail', /off the end/);
  chain(P, 24.3, 0.2, 2, 0, [['s', 24]]);
  expect('misaligned joint', run(P, a.id, 60), 'derail', /bad joint/);
}
// 4) S-curve R18 / R18 with no straight between
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 12], ['c', 18, 30], ['c', 18, -30], ['s', 24]]);
  expect('S-curve', run(P, a.id, 60), 'derail', /S-curve/);
  expectIssue('…also in Checks', P, 'warn', /S-curve/);
  const Q = proj();
  const [b] = chain(Q, 0, 0, 0, 0, [['s', 12], ['c', 18, 30], ['s', 9], ['c', 18, -30], ['s', 24]]);
  expectNone('…fixed with a 9" straight', run(Q, b.id, 50));
}
// 5) steep grade on a tight curve stalls (climbing only)
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 12, 3], ['c', 18, 90, 3], ['s', 12, 3]]);
  expect('3% grade on R18 (4.8% effective)', run(P, a.id, 40), 'stop', /stalls/);
  expectIssue('…effective grade warning', P, 'warn', /Effective grade/);
}
// 6) vertical kink
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 24, 0], ['s', 24, 3]]);
  expect('0% → 3% at one joint', run(P, a.id, 40), 'derail', /vertical kink/);
  expectIssue('…kink in Checks', P, 'error', /Vertical kink/);
}
// 7) building on the track, portal too small, bridge hanging into a lower track
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 60]]);
  P.scenery.push({ id: 'o1', type: 'house', name: 'House', shape: 'box', x: 30, y: 0.8, rot: 0, w: 5, d: 4, h: 4, base: 0, color: '#fff', props: { name: 'Shed' } });
  expect('building fouling the track', run(P, a.id, 60), 'derail', /Shed/);
  P.scenery = [{ id: 'o2', type: 'portal', name: 'Tunnel portal', shape: 'portal', x: 30, y: 0, rot: 90, w: 4, d: 1, h: 3.5, base: 0, color: '#777', props: { name: 'Low portal' } }];
  expect('portal arch too low', run(P, a.id, 60), 'derail', /Low portal.*arch/);
  P.scenery = [{ id: 'o3', type: 'girder', name: 'Bridge', shape: 'bridge', style: 'girder', x: 30, y: 0, rot: 90, w: 12, d: 2.6, h: 1.4, base: 3.6, color: '#333', props: { name: 'Low girder' } }];
  chain(P, 30, -30, 90, 3.6, [['s', 60]]);
  expect('girder hanging into lower track', run(P, a.id, 60), 'derail', /Low girder|track above/);
}
// 8) trailing move through a turnout set against the train
{
  const P = proj();
  const to = { id: 'tw', cat: 'n6L', kind: 'turnout', params: { hand: 'L', len: 11, r: 40, angle: 9.46, tail: 4.49 }, x: 24, y: 0, rot: 0, z: 0, grade: 0, level: 'L0', state: 0, props: { name: 'T9' } };
  P.pieces.push(to);
  const g = buildGeometry(to.kind, to.params), e = toWorld(to, routeEnd(g.routes[1]));
  const [leg] = chain(P, e.x, e.y, e.h, 0, [['s', 20]]);
  chain(P, 0, 0, 0, 0, [['s', 24]]);
  expect('trailing move, turnout set against', run(P, leg.id, 60, -1), 'derail', /T9 set against/);
}
// 9) supports never stand on a lower track (helix-like stack)
{
  const P = proj();
  chain(P, 0, 0, 0, 0, [['s', 80]]);
  chain(P, 0, 0, 0, 4, [['s', 80]]);
  loadProject(JSON.parse(JSON.stringify(P)));
  const sp = supports().supports;
  const bad = sp.some((s) => s.posts.some((q) => Math.abs(q.y) < 1.3));
  console.log(`${bad ? '✗' : '✓'} posts beside, not on, the lower track (${sp.length} bents)`);
  if (bad || !sp.length) failed++;
}
// 10) track through water
{
  const P = proj();
  const [a] = chain(P, 0, 0, 0, 0, [['s', 60]]);
  P.scenery.push({ id: 'w', type: 'water', name: 'Pond', shape: 'water', x: 30, y: 0, rot: 0, w: 10, d: 6, h: 0.05, base: 0, color: '#00f', props: { name: 'Duck pond' } });
  expect('track through a pond', run(P, a.id, 60), 'stop', /Duck pond/);
}
console.log(failed ? `\n${failed} failure(s)` : '\nAll realism tests passed');
process.exit(failed ? 1 : 0);
