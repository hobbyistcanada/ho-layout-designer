// Run: node tests/samples.test.mjs
// Builds every sample, loads it through the real model and runs the app's design checks.
import { SAMPLES } from '../js/samples.js';
import { state, loadProject, getCache } from '../js/model.js';
import { runChecks, billOfMaterials } from '../js/checks.js';

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
  if (open) fail(`${open} open track ends`);
  for (const d of P.devices) if (!P.pieces.some((p) => p.id === d.pieceId)) fail(`device ${d.props.name} not on a track`);
  const ids = new Set();
  for (const it of [...P.pieces, ...P.devices, ...P.scenery]) { if (ids.has(it.id)) fail('duplicate id ' + it.id); ids.add(it.id); }
  if (!billOfMaterials().length) fail('empty parts list');
  const portals = P.scenery.filter((o) => o.type === 'portal').length;
  const spans = P.scenery.filter((o) => ['bridge', 'trestle'].includes(o.shape)).length;
  console.log(`  portals ${portals}, bridges/trestles ${spans}`);
}
console.log(failed ? `\n${failed} problem(s)` : '\nAll samples OK');
process.exit(failed ? 1 : 0);
