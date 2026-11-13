// Design-rule checks: radius, grade, vertical clearance, overlaps, board edge, open ends.
import { state, getCache } from './model.js';
import { pointInPoly, segIntersect } from './geometry.js';
import { TRACK_BY_ID } from './catalog.js';

export function runChecks() {
  const P = state.project, S = P.settings;
  const issues = [];
  const C = getCache();
  const add = (level, msg, at, id) => issues.push({ level, msg, at, id });

  for (const c of C.map.values()) {
    const pc = c.pc, name = TRACK_BY_ID[pc.cat]?.name || pc.kind;
    const mid = c.samples[0][Math.floor(c.samples[0].length / 2)];
    // radius
    const radii = c.g.routes.flatMap((r) => r.segs.filter((s) => s.r).map((s) => s.r));
    const minR = Math.min(...radii, Infinity);
    if (minR < S.minRadius) add('warn', `${name}: radius ${minR}" is below your minimum ${S.minRadius}"`, mid, pc.id);
    // grade
    if (Math.abs(pc.grade) > S.maxGrade) add('warn', `${name}: grade ${Math.abs(pc.grade).toFixed(1)}% exceeds max ${S.maxGrade}%`, mid, pc.id);
    // board edge
    if (P.board.outline.length > 2) {
      const off = c.samples.some((arr) => arr.some((s) => !pointInPoly(s, P.board.outline)));
      if (off) add('error', `${name} runs off the benchwork`, mid, pc.id);
    }
    // turnout addressing
    if ((pc.kind === 'turnout' || pc.kind === 'wye' || pc.kind === 'curvedTurnout') && !pc.props?.address)
      add('info', `${name} has no control address / pin assigned`, mid, pc.id);
    // open ends
    c.eps.forEach((e, i) => {
      if (!c.links[i] && pc.kind !== 'bumper' && pc.kind !== 'turntable') add('info', 'Open track end (add a bumper or connect it)', e, pc.id);
    });
  }

  // Crossings between different pieces: clearance / overlap
  const segs = [];
  for (const c of C.map.values()) {
    if (c.pc.kind === 'turntable') continue;
    c.samples.forEach((arr) => {
      for (let i = 0; i < arr.length - 1; i += 2) {
        const b = arr[Math.min(i + 2, arr.length - 1)];
        segs.push({ a: arr[i], b, id: c.pc.id, links: c.links });
      }
    });
  }
  const neighbours = (id) => {
    const c = C.map.get(id);
    return new Set([id, ...c.links.filter(Boolean).map((l) => l.id)]);
  };
  const seen = new Set();
  // grid hash
  const cell = 6, grid = new Map();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / cell), x1 = Math.floor(Math.max(s.a.x, s.b.x) / cell);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / cell), y1 = Math.floor(Math.max(s.a.y, s.b.y) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const A = segs[list[a]], B = segs[list[b]];
      if (A.id === B.id) continue;
      const pairKey = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id;
      if (seen.has(pairKey)) continue;
      if (neighbours(A.id).has(B.id)) continue;
      const hit = segIntersect(A.a, A.b, B.a, B.b);
      if (!hit) continue;
      seen.add(pairKey);
      const za = A.a.z + (A.b.z - A.a.z) * hit.t, zb = B.a.z + (B.b.z - B.a.z) * hit.u;
      const dz = Math.abs(za - zb);
      if (dz < 0.3) add('error', 'Tracks overlap at the same height (use a crossing or turnout)', hit, A.id);
      else if (dz < S.clearance) add('warn', `Vertical clearance only ${dz.toFixed(2)}" where tracks cross (need ${S.clearance}")`, hit, za > zb ? A.id : B.id);
    }
  }

  // Devices not attached
  for (const d of P.devices) if (!d.pieceId) add('info', `${d.props?.name || d.type} is not on a track`, d, d.id);

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}

// Bill of materials
export function billOfMaterials() {
  const P = state.project;
  const rows = new Map();
  let flexLen = 0;
  const inc = (k, n = 1) => rows.set(k, (rows.get(k) || 0) + n);
  for (const pc of P.pieces) {
    const cat = TRACK_BY_ID[pc.cat];
    const same = cat && JSON.stringify(cat.params) === JSON.stringify(pc.params);
    if (cat && same && !cat.flex) inc(`Track: ${cat.name}`);
    else if (pc.kind === 'straight') flexLen += pc.params.len;
    else if (pc.kind === 'curve') flexLen += (Math.abs(pc.params.angle) * Math.PI / 180) * pc.params.r;
    else inc(`Track: ${cat ? cat.name : pc.kind} (modified)`);
  }
  if (flexLen > 0) inc(`Flex track 36" sections (total ${flexLen.toFixed(1)}" incl. 10% waste)`, Math.ceil((flexLen * 1.1) / 36));
  for (const d of P.devices) inc(`Device: ${d.name}`);
  for (const s of P.scenery) inc(`Scenery: ${s.name}`);
  const joiners = P.pieces.reduce((t, pc) => t + getCache().map.get(pc.id).eps.length, 0);
  if (joiners) inc('Rail joiners (pairs, approx.)', Math.ceil(joiners / 2));
  return [...rows.entries()].map(([item, qty]) => ({ item, qty }));
}

export function controlSchedule() {
  const P = state.project;
  const rows = [];
  for (const pc of P.pieces) {
    if (['turnout', 'wye', 'curvedTurnout'].includes(pc.kind))
      rows.push({ id: pc.id, type: 'Turnout', name: pc.props.name || TRACK_BY_ID[pc.cat]?.name, address: pc.props.address || '', detail: pc.props.motor || '', level: pc.level });
  }
  for (const d of P.devices)
    rows.push({ id: d.id, type: d.name, name: d.props.name || '', address: d.props.address || '', detail: Object.entries(d.props).filter(([k]) => !['name', 'address', 'notes'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; '), level: P.pieces.find((p) => p.id === d.pieceId)?.level || '' });
  return rows;
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
