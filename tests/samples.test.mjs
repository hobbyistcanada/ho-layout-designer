// Run: node tests/samples.test.mjs
// Builds every sample, loads it through the real model and runs the app's design checks.
import { SAMPLES } from '../js/samples.js';
import { state, loadProject, getCache } from '../js/model.js';
import { runChecks, billOfMaterials } from '../js/checks.js';
import { moveTrain, supports, trackIndex, obstacleBoxes } from '../js/realism.js';

// Run test trains from many places, both directions, with turnouts normal and then all thrown.
// Trailing turnouts are lined for the train, as a dispatcher would. Anything other than
// reversing at a bumper is a failure (derailment, collision, stall …).
function trainRuns(P) {
  const problems = new Map();
  const turnouts = P.pieces.filter((p) => ['turnout', 'wye', 'curvedTurnout'].includes(p.kind));
  for (const thrown of [0, 1]) {
    turnouts.forEach((p) => (p.state = thrown));
    loadProject(JSON.parse(JSON.stringify(P)));
    P.pieces.filter((_, i) => i % 7 === 0).forEach((pc) => {
      for (const dir of [1, -1]) {
        const t = { pieceId: pc.id, route: 0, d: 0, dir, curv: null, straight: Infinity };
        let run = 0, ev = null;
        while (run < 1500) {
          ev = moveTrain(t, 50, { autoAlign: true }); run += 50;
          if (ev && ev.kind !== 'end') break;
          ev = null;
        }
        if (ev) problems.set(ev.msg + ` @ (${ev.at.x.toFixed(0)}, ${ev.at.y.toFixed(0)})`, thrown ? 'turnouts thrown' : 'turnouts normal');
      }
    });
  }
  turnouts.forEach((p) => (p.state = 0));
  loadProject(JSON.parse(JSON.stringify(P)));
  return problems;
}

let failed = 0;
const fail = (m) => { failed++; console.log('  ✗ ' + m); };
for (const S of SAMPLES) {
  console.log(`\n${S.name}`);
  let P;
  try { P = S.build(); } catch (e) { fail('build threw: ' + e.stack); continue; }
  const json = JSON.parse(JSON.stringify(P)); // must survive a save/open round trip
  loadProject(json);
  const C = getCache();
  let open = 0, links = 0;
  for (const c of C.map.values()) c.eps.forEach((e, i) => { if (c.links[i]) links++; else if (!['bumper', 'turntable'].includes(c.pc.kind)) open++; });
  const issues = runChecks();
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  const zs = P.pieces.map((p) => p.z);
  console.log(`  pieces ${P.pieces.length}, turnouts ${P.pieces.filter((p) => p.kind === 'turnout').length}, devices ${P.devices.length}, scenery ${P.scenery.length}, links ${links / 2}, height 0–${Math.max(...zs).toFixed(2)}"`);
  console.log(`  checks: ${errors.length} errors, ${warns.length} warnings, ${issues.length - errors.length - warns.length} info`);
  for (const i of [...errors, ...warns]) fail(`${i.level}: ${i.msg} @ (${i.at.x.toFixed(1)}, ${i.at.y.toFixed(1)})`);
  for (const i of issues.filter((x) => x.level === 'info' && !/no control address/.test(x.msg))) console.log('  info: ' + i.msg);
  if (open) fail(`${open} open track ends`);
  for (const d of P.devices) if (!P.pieces.some((p) => p.id === d.pieceId)) fail(`device ${d.props.name} not on a track`);
  const ids = new Set();
  for (const it of [...P.pieces, ...P.devices, ...P.scenery]) { if (ids.has(it.id)) fail('duplicate id ' + it.id); ids.add(it.id); }
  if (!billOfMaterials().length) fail('empty parts list');
  // supports never stand on or beside a lower track
  const I = trackIndex();
  const sup = supports();
  for (const sp of sup.supports) for (const q of sp.posts) {
    const bad = I.near(q.x, q.y, 1.3).find((s) => s.z < sp.top - 0.25 && s.id !== sp.at.id);
    if (bad) fail(`support post at (${q.x.toFixed(1)}, ${q.y.toFixed(1)}) fouls the track below`);
  }
  console.log(`  supports ${sup.supports.length} (${sup.supports.filter((s) => s.posts.length === 2).length} two-post bents, ${sup.supports.filter((s) => s.cap && s.posts.length === 1).length} brackets)`);
  const runs = trainRuns(json);
  for (const [m, mode] of runs) fail(`test train (${mode}): ${m}`);
  console.log(`  test trains: ${runs.size ? runs.size + ' problem(s)' : 'no derailments, collisions or stalls'}`);
  const portals = P.scenery.filter((o) => o.type === 'portal').length;
  const spans = P.scenery.filter((o) => ['bridge', 'trestle'].includes(o.shape)).length;
  console.log(`  portals ${portals}, bridges/trestles ${spans}`);
}
console.log(failed ? `\n${failed} problem(s)` : '\nAll samples OK');
process.exit(failed ? 1 : 0);
