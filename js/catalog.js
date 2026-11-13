// Generic HO track, device and scenery catalog.
// HO = 1:87.1, track gauge 16.5 mm (0.65"). All dimensions in inches.
// Values are generic sectional/flex geometry similar to common brands
// (Atlas, Bachmann E-Z Track, Kato Unitrack, Peco) – not exact brand data.

export const HO = { scale: 87.1, gauge: 0.65, tieLen: 1.17, ballastW: 1.6, tieSpacing: 0.72 };

export const TRACK = [
  // Straights
  { id: 's9', group: 'Straight', name: 'Straight 9"', kind: 'straight', params: { len: 9 } },
  { id: 's6', group: 'Straight', name: 'Straight 6"', kind: 'straight', params: { len: 6 } },
  { id: 's45', group: 'Straight', name: 'Straight 4.5"', kind: 'straight', params: { len: 4.5 } },
  { id: 's3', group: 'Straight', name: 'Straight 3"', kind: 'straight', params: { len: 3 } },
  { id: 's18', group: 'Straight', name: 'Straight 18"', kind: 'straight', params: { len: 18 } },
  { id: 'flex', group: 'Straight', name: 'Flex track 36" (edit length)', kind: 'straight', params: { len: 36 }, flex: true },
  { id: 'bumper', group: 'Straight', name: 'Bumper / end stop', kind: 'bumper', params: { len: 2 } },
  // Curves
  { id: 'r15', group: 'Curve', name: 'Curve R15" 30°', kind: 'curve', params: { r: 15, angle: 30 } },
  { id: 'r18', group: 'Curve', name: 'Curve R18" 30°', kind: 'curve', params: { r: 18, angle: 30 } },
  { id: 'r18h', group: 'Curve', name: 'Curve R18" 15°', kind: 'curve', params: { r: 18, angle: 15 } },
  { id: 'r22', group: 'Curve', name: 'Curve R22" 22.5°', kind: 'curve', params: { r: 22, angle: 22.5 } },
  { id: 'r24', group: 'Curve', name: 'Curve R24" 22.5°', kind: 'curve', params: { r: 24, angle: 22.5 } },
  { id: 'r26', group: 'Curve', name: 'Curve R26" 22.5°', kind: 'curve', params: { r: 26, angle: 22.5 } },
  { id: 'r30', group: 'Curve', name: 'Curve R30" 15°', kind: 'curve', params: { r: 30, angle: 15 } },
  { id: 'cflex', group: 'Curve', name: 'Curved flex (edit R/angle)', kind: 'curve', params: { r: 28, angle: 30 }, flex: true },
  // Turnouts (L = diverges left)
  { id: 'snapL', group: 'Turnout', name: 'Sectional turnout 18R Left', kind: 'turnout', params: { hand: 'L', len: 9, r: 18, angle: 30, tail: 0 } },
  { id: 'snapR', group: 'Turnout', name: 'Sectional turnout 18R Right', kind: 'turnout', params: { hand: 'R', len: 9, r: 18, angle: 30, tail: 0 } },
  { id: 'n4L', group: 'Turnout', name: '#4 turnout Left', kind: 'turnout', params: { hand: 'L', len: 8.5, r: 22, angle: 14.25, tail: 3.18 } },
  { id: 'n4R', group: 'Turnout', name: '#4 turnout Right', kind: 'turnout', params: { hand: 'R', len: 8.5, r: 22, angle: 14.25, tail: 3.18 } },
  { id: 'n6L', group: 'Turnout', name: '#6 turnout Left', kind: 'turnout', params: { hand: 'L', len: 11, r: 40, angle: 9.46, tail: 4.49 } },
  { id: 'n6R', group: 'Turnout', name: '#6 turnout Right', kind: 'turnout', params: { hand: 'R', len: 11, r: 40, angle: 9.46, tail: 4.49 } },
  { id: 'wye4', group: 'Turnout', name: '#4 wye', kind: 'wye', params: { r: 30, angle: 14.25, tail: 3 } },
  { id: 'curvL', group: 'Turnout', name: 'Curved turnout 24/18 Left', kind: 'curvedTurnout', params: { hand: 'L', r1: 24, a1: 30, r2: 18, a2: 30 } },
  { id: 'curvR', group: 'Turnout', name: 'Curved turnout 24/18 Right', kind: 'curvedTurnout', params: { hand: 'R', r1: 24, a1: 30, r2: 18, a2: 30 } },
  // Crossings & special
  { id: 'x90', group: 'Crossing', name: 'Crossing 90°', kind: 'crossing', params: { len: 6, angle: 90 } },
  { id: 'x45', group: 'Crossing', name: 'Crossing 45°', kind: 'crossing', params: { len: 6, angle: 45 } },
  { id: 'x30', group: 'Crossing', name: 'Crossing 30°', kind: 'crossing', params: { len: 9, angle: 30 } },
  { id: 'tt', group: 'Special', name: 'Turntable 12" (edit stalls)', kind: 'turntable', params: { d: 12, stalls: '0,180,20,35,50,65' } },
];

export const TRACK_BY_ID = Object.fromEntries(TRACK.map((t) => [t.id, t]));

// Build local geometry. Each route: {start:{x,y,h}, segs:[], ends:'both'|'end'}
export function buildGeometry(kind, p) {
  const O = { x: 0, y: 0, h: 0 };
  switch (kind) {
    case 'straight':
      return { routes: [{ start: O, segs: [{ s: p.len }], ends: 'both' }] };
    case 'bumper':
      return { routes: [{ start: O, segs: [{ s: p.len }], ends: 'start' }] };
    case 'curve':
      return { routes: [{ start: O, segs: [{ r: p.r, a: p.angle }], ends: 'both' }] };
    case 'turnout': {
      const sg = p.hand === 'R' ? -1 : 1;
      const div = [{ r: p.r, a: sg * p.angle }];
      if (p.tail > 0) div.push({ s: p.tail });
      return { routes: [{ start: O, segs: [{ s: p.len }], ends: 'both' }, { start: O, segs: div, ends: 'both' }] };
    }
    case 'wye': {
      const a = p.angle / 2;
      return {
        routes: [
          { start: O, segs: [{ r: p.r, a }, { s: p.tail }], ends: 'both' },
          { start: O, segs: [{ r: p.r, a: -a }, { s: p.tail }], ends: 'both' },
        ],
      };
    }
    case 'curvedTurnout': {
      const sg = p.hand === 'R' ? -1 : 1;
      return {
        routes: [
          { start: O, segs: [{ r: p.r1, a: sg * p.a1 }], ends: 'both' },
          { start: O, segs: [{ r: p.r2, a: sg * p.a2 }], ends: 'both' },
        ],
      };
    }
    case 'crossing': {
      const h = p.len / 2, a = p.angle * Math.PI / 180;
      return {
        routes: [
          { start: O, segs: [{ s: p.len }], ends: 'both' },
          { start: { x: h - h * Math.cos(a), y: -h * Math.sin(a), h: p.angle }, segs: [{ s: p.len }], ends: 'both' },
        ],
      };
    }
    case 'turntable': {
      const angles = String(p.stalls).split(',').map(Number).filter((n) => !isNaN(n));
      return {
        pit: p.d / 2,
        routes: angles.map((a) => ({ start: { x: 0, y: 0, h: a }, segs: [{ s: p.d / 2 }], ends: 'end' })),
      };
    }
  }
  return { routes: [] };
}

export const DEVICES = [
  { id: 'signal3', name: 'Signal – 3 aspect', icon: 'S3', color: '#e74c3c', props: { heads: 3, aspect: 'Red' } },
  { id: 'signal2', name: 'Signal – 2 aspect', icon: 'S2', color: '#e74c3c', props: { heads: 2, aspect: 'Red' } },
  { id: 'dwarf', name: 'Dwarf signal', icon: 'Sd', color: '#e67e22', props: { heads: 2, aspect: 'Red' } },
  { id: 'sensor', name: 'Train passing sensor', icon: 'PS', color: '#f39c12', props: { sensorType: 'IR' } },
  { id: 'home', name: 'Home / end-of-travel sensor', icon: 'H', color: '#9b59b6', props: { sensorType: 'Hall' } },
  { id: 'block', name: 'Occupancy detection block', icon: 'B', color: '#16a085', props: { sensorType: 'Current' } },
  { id: 'feeder', name: 'Power feeder', icon: 'F', color: '#c0392b', props: { bus: 'Main' } },
  { id: 'gap', name: 'Insulated rail gap', icon: '|', color: '#2c3e50', props: { rails: 'Both' } },
  { id: 'uncoupler', name: 'Uncoupler', icon: 'U', color: '#7f8c8d', props: { kind: 'Magnetic' } },
  { id: 'gate', name: 'Crossing gate', icon: 'X', color: '#d35400', props: {} },
];
export const DEVICE_BY_ID = Object.fromEntries(DEVICES.map((d) => [d.id, d]));

export const SCENERY = [
  { id: 'house', name: 'House', shape: 'box', w: 5, d: 4, h: 4, roof: 'gable', color: '#d9b38c' },
  { id: 'station', name: 'Station', shape: 'box', w: 12, d: 5, h: 4.5, roof: 'gable', color: '#c0785a' },
  { id: 'factory', name: 'Factory', shape: 'box', w: 14, d: 8, h: 7, roof: 'flat', color: '#8d8d8d' },
  { id: 'enginehouse', name: 'Engine house', shape: 'box', w: 16, d: 7, h: 6, roof: 'gable', color: '#a0522d' },
  { id: 'tower', name: 'Water tower', shape: 'cyl', w: 3, d: 3, h: 9, color: '#6b4f3a' },
  { id: 'platform', name: 'Platform', shape: 'box', w: 20, d: 2.5, h: 0.5, roof: 'flat', color: '#b0b0b0' },
  { id: 'light', name: 'Street light', shape: 'light', w: 0.5, d: 0.5, h: 4, color: '#ffd76a' },
  { id: 'pine', name: 'Tree – pine', shape: 'pine', w: 2.5, d: 2.5, h: 6, color: '#2f6b3a' },
  { id: 'oak', name: 'Tree – deciduous', shape: 'tree', w: 3.5, d: 3.5, h: 5, color: '#4c8a3a' },
  { id: 'road', name: 'Road (12")', shape: 'flat', w: 12, d: 3, h: 0.05, color: '#3d3d3d' },
  { id: 'water', name: 'Pond / water', shape: 'water', w: 10, d: 6, h: 0.05, color: '#3a7bbf' },
  { id: 'hill', name: 'Hill / mound', shape: 'hill', w: 14, d: 10, h: 4, color: '#6d8b4a' },
  { id: 'portal', name: 'Tunnel portal', shape: 'portal', w: 4, d: 1, h: 4, color: '#7a7a7a' },
];
export const SCENERY_BY_ID = Object.fromEntries(SCENERY.map((s) => [s.id, s]));

// Board presets (inches). Polygons listed counter-clockwise.
export const BOARD_PRESETS = {
  rect: { name: 'Rectangle', fields: { W: 96, D: 48 }, make: ({ W, D }) => [p(0, 0), p(W, 0), p(W, D), p(0, D)] },
  myL: {
    name: 'My L-shape (96×42 + 20×40 plank)',
    fields: { W: 96, D: 42, PW: 40, PD: 20 },
    make: ({ W, D, PW, PD }) => [p(0, 0), p(W, 0), p(W, D + PD), p(W - PW, D + PD), p(W - PW, D), p(0, D)],
  },
  L: {
    name: 'L-shape',
    fields: { A: 120, B: 96, Wa: 30, Wb: 30 },
    make: ({ A, B, Wa, Wb }) => [p(0, 0), p(A, 0), p(A, Wa), p(Wb, Wa), p(Wb, B), p(0, B)],
  },
  U: {
    name: 'U-shape',
    fields: { W: 120, D: 96, Arm: 24 },
    make: ({ W, D, Arm }) => [p(0, 0), p(W, 0), p(W, D), p(W - Arm, D), p(W - Arm, Arm), p(Arm, Arm), p(Arm, D), p(0, D)],
  },
  T: {
    name: 'T-shape / peninsula',
    fields: { W: 96, D: 30, PW: 36, PD: 48 },
    make: ({ W, D, PW, PD }) => [p(0, 0), p(W, 0), p(W, D), p((W + PW) / 2, D), p((W + PW) / 2, D + PD), p((W - PW) / 2, D + PD), p((W - PW) / 2, D), p(0, D)],
  },
  door: { name: 'Hollow-core door 80×30', fields: { W: 80, D: 30 }, make: ({ W, D }) => [p(0, 0), p(W, 0), p(W, D), p(0, D)] },
};
function p(x, y) { return { x, y }; }
