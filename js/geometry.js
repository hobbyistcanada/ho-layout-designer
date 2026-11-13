// Geometry helpers. All model units are INCHES. Headings are degrees,
// 0 = +X, counter-clockwise positive (math convention, Y up).

export const DEG = Math.PI / 180;
export const norm = (a) => ((a % 360) + 540) % 360 - 180; // -> [-180,180)

// Advance a pose {x,y,h} along one segment. seg = {s:len} | {r:radius, a:signedAngleDeg}
export function advance(p, seg) {
  if (seg.s !== undefined) {
    return { x: p.x + seg.s * Math.cos(p.h * DEG), y: p.y + seg.s * Math.sin(p.h * DEG), h: p.h };
  }
  const sg = Math.sign(seg.a) || 1;
  const cx = p.x - sg * seg.r * Math.sin(p.h * DEG);
  const cy = p.y + sg * seg.r * Math.cos(p.h * DEG);
  const h = p.h + seg.a;
  return { x: cx + sg * seg.r * Math.sin(h * DEG), y: cy - sg * seg.r * Math.cos(h * DEG), h };
}

export const segLen = (seg) => (seg.s !== undefined ? seg.s : Math.abs(seg.a) * DEG * seg.r);
export const routeLen = (route) => route.segs.reduce((t, s) => t + segLen(s), 0);

export function routeEnd(route) {
  let p = { ...route.start };
  for (const s of route.segs) p = advance(p, s);
  return p;
}

// Pose at distance d along a route (local coordinates)
export function poseAt(route, d) {
  let p = { ...route.start };
  let left = Math.max(0, d);
  for (const s of route.segs) {
    const L = segLen(s);
    if (left <= L || s === route.segs[route.segs.length - 1]) {
      const f = L > 0 ? Math.min(left, L) / L : 0;
      return s.s !== undefined ? advance(p, { s: s.s * f }) : advance(p, { r: s.r, a: s.a * f });
    }
    p = advance(p, s);
    left -= L;
  }
  return p;
}

// Sample a route into points {x,y,h,d}
export function sampleRoute(route, step = 0.5) {
  const pts = [];
  let p = { ...route.start };
  let d0 = 0;
  pts.push({ ...p, d: 0 });
  for (const s of route.segs) {
    const L = segLen(s);
    const n = Math.max(1, Math.ceil(L / step));
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const q = s.s !== undefined ? advance(p, { s: s.s * f }) : advance(p, { r: s.r, a: s.a * f });
      pts.push({ ...q, d: d0 + L * f });
    }
    p = advance(p, s);
    d0 += L;
  }
  return pts;
}

// Local -> world transform for a placed item {x,y,rot}
export function toWorld(item, p) {
  const c = Math.cos(item.rot * DEG), s = Math.sin(item.rot * DEG);
  return { x: item.x + p.x * c - p.y * s, y: item.y + p.x * s + p.y * c, h: (p.h ?? 0) + item.rot };
}
export function toLocal(item, p) {
  const c = Math.cos(-item.rot * DEG), s = Math.sin(-item.rot * DEG);
  const dx = p.x - item.x, dy = p.y - item.y;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Segment intersection: returns {t,u,x,y} or null
export function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return { d: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t };
}
