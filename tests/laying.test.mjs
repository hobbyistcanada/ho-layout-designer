// Run: node tests/laying.test.mjs
// Laying track on a grade: Auto keeps following the grade; a chosen grade is reached through a
// vertical easement (max 1% change per piece); heights stay continuous at every joint, also when
// a piece is flipped (F) or attached by its far end; an end joined only to the piece being
// dragged still counts as free so a snap doesn't drop on the next mouse move.
import { state, newProject, loadProject, addPiece, getCache, flipLast, freeEndpoints, alignTo, slopeOut, nextGrade, GRADE_STEP } from '../js/model.js';

let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log(`${c ? '✓' : '✗'} ${m}`); };
const lay = (ids) => ids.map((id) => addPiece(id, null));
const P = () => state.project.pieces;
const joints = () => {
  // every linked joint must be at the same height on both sides
  let worst = 0;
  for (const c of getCache().map.values()) c.eps.forEach((e, i) => { const l = c.links[i]; if (l) worst = Math.max(worst, Math.abs(e.z - getCache().map.get(l.id).eps[l.ep].z)); });
  return worst;
};

loadProject(newProject()); state.project.pieces = []; state.target = null;
state.grade = 'auto';
addPiece('s9', { x: 0, y: 0 });
state.grade = 2; lay(['s9', 's9', 's9']);
ok(P().map((p) => p.grade).join() === '0,1,2,2', `target +2%: eased 0 → 1 → 2 → 2 (got ${P().map((p) => p.grade)})`);
state.grade = 'auto'; lay(['r18', 'r18', 's9']);
ok(P().slice(-3).every((p) => Math.abs(slopeOut(getCache().map.get(p.id), 1)) === 2 || Math.abs(p.grade) === 2), 'Auto keeps following +2% (curves and straights)');
state.grade = 0; lay(['s9', 's9', 's9']);
ok(P().slice(-3).map((p) => Math.abs(p.grade)).join() === '1,0,0', `level off: 1 → 0 → 0 (got ${P().slice(-3).map((p) => p.grade)})`);
state.grade = -2; lay(['s9', 's9', 's9']);
ok(P().slice(-3).map((p) => p.grade).join() === '-1,-2,-2', `go down: -1 → -2 → -2 (got ${P().slice(-3).map((p) => p.grade)})`);
ok(joints() < 1e-9, `heights continuous at every joint (worst ${joints().toExponential(1)})`);
flipLast(); // attach the last piece by its other end
ok(joints() < 1e-9, 'F (flip) keeps the joint height and the direction of the slope');
// easing step is 1% per piece
state.grade = 4; ok(nextGrade(0) === GRADE_STEP && nextGrade(3.5) === 4, `nextGrade eases by ${GRADE_STEP}% per piece`);
// freeEndpoints: an end joined only to the excluded (dragged) piece is still free
const last = P().at(-1), prev = P().at(-2);
ok(freeEndpoints(last.id).some((f) => f.pieceId === prev.id), 'end joined only to the dragged piece counts as free (snap is not lost on the next mouse move)');
console.log(failed ? `\n${failed} failure(s)` : '\nAll laying tests passed');
process.exit(failed ? 1 : 0);
