// Run: node tests/scale.test.mjs
// Every catalog object converted to real-world size at 1:87.1 and checked against typical North
// American prototype dimensions. Ranges allow for the selective compression modellers use
// (shorter buildings, smaller trees) but catch anything clearly out of scale.
import { HO, SCENERY_BY_ID } from '../js/catalog.js';
import { portalOpening } from '../js/realism.js';

const ft = (inches) => (inches * HO.scale) / 12; // model inches -> prototype feet
const inch = (v) => v * HO.scale; // model inches -> prototype inches
let failed = 0;
const rows = [];
function check(item, dim, value, lo, hi, unit, ref) {
  const ok = value >= lo && value <= hi;
  if (!ok) failed++;
  rows.push(`${ok ? '✓' : '✗'} ${item.padEnd(22)} ${dim.padEnd(16)} ${value.toFixed(1).padStart(6)} ${unit.padEnd(3)} (prototype ${lo}–${hi} ${unit}${ref ? '; ' + ref : ''})`);
}
const S = SCENERY_BY_ID;
// track
check('Track gauge', 'gauge', inch(HO.gauge), 56, 57.5, 'in', '4 ft 8½ in');
check('Tie', 'length', ft(HO.tieLen), 8, 9, 'ft', '8 ft 6 in');
check('Tie', 'width', inch(HO.tieWidth), 8, 10, 'in', '9 in');
check('Tie', 'depth', inch(HO.tieDepth), 6, 8, 'in', '7 in');
check('Tie', 'spacing', inch(HO.tieSpacing), 18, 24, 'in', '19½–21 in wood ties');
check('Rail', 'height', inch(HO.rail), 5.5, 7.5, 'in', 'code 83 = 132 lb rail');
check('Track centres', 'default', ft(2), 13, 15, 'ft', '14 ft');
// structures
check('House', 'footprint long', ft(S.house.w), 24, 50, 'ft');
check('House', 'height', ft(S.house.h), 18, 35, 'ft', '1–2 storeys');
check('Station', 'length', ft(S.station.w), 50, 120, 'ft');
check('Station', 'height', ft(S.station.h), 18, 32, 'ft', '1–1½ storey depot');
check('Factory', 'height', ft(S.factory.h), 25, 70, 'ft', '2–5 storeys');
check('Engine house', 'stall length', ft(S.enginehouse.w), 90, 160, 'ft', 'diesel/steam stalls');
check('Engine house', 'height', ft(S.enginehouse.h), 25, 40, 'ft', 'doors ~17 ft');
check('Water tank', 'diameter', ft(S.tower.w), 16, 26, 'ft', '16–24 ft');
check('Water tank', 'height', ft(S.tower.h), 30, 50, 'ft', 'e.g. 43 ft');
check('Water tank', 'tub floor', ft(S.tower.h * 0.33), 12, 16, 'ft', '12–15 ft above rail');
check('Platform', 'above rail', inch(S.platform.h - (0.18 + HO.tieDepth + HO.rail)), 4, 12, 'in', 'low platform ~8 in');
check('Street light', 'height', ft(S.light.h), 20, 35, 'ft', '25–30 ft');
check('Pine', 'height', ft(S.pine.h), 30, 100, 'ft');
check('Deciduous tree', 'height', ft(S.oak.h), 30, 70, 'ft');
check('Road', 'width', ft(S.road.d), 18, 26, 'ft', 'two 11–12 ft lanes');
const op = portalOpening(S.portal);
check('Tunnel portal', 'bore width', ft(op.w), 16, 20, 'ft', 'single track ≥16 ft');
check('Tunnel portal', 'bore height', ft(op.h), 21, 24, 'ft', '22 ft 6 in');
check('Plate girder', 'deck width', ft(S.girder.d), 14, 22, 'ft');
check('Plate girder', 'span / depth', S.girder.w / S.girder.h, 6, 15, '', 'span ≈ 8–12 × depth');
check('Truss bridge', 'height', ft(S.truss.h), 22, 40, 'ft');
check('Truss bridge', 'clear width', ft(S.truss.d), 16, 24, 'ft', '≥16 ft');
check('Trestle', 'bent spacing', ft(1.8), 12, 16, 'ft', '13–16 ft');
check('Turntable', 'diameter', ft(12), 80, 135, 'ft');
console.log(rows.join('\n'));
console.log(failed ? `\n${failed} out of scale` : '\nAll objects within HO-scale prototype ranges');
process.exit(failed ? 1 : 0);
