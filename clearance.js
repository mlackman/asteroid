// Geometric clearance between visible rock outlines in world space.
function bounds(points) {
  return {
    minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y))
  };
}
function boundsClear(a, b, gap) {
  return a.maxX + gap < b.minX || b.maxX + gap < a.minX || a.maxY + gap < b.minY || b.maxY + gap < a.minY;
}
function pointDistanceSquared(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}
function edgesCross(a, b, c, d) {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}
export function outline(entity, toWorld) {
  const shape = entity.shape.map(ring => ring.map(p => toWorld(entity, p)));
  const edges = shape.flatMap(ring => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { a, b, bounds: bounds([a, b]) };
  }));
  return { shape, edges, bounds: bounds(shape[0]) };
}
// True when two world outlines are at least `gap` apart and neither is inside the other.
export function separated(a, b, contains, gap) {
  if (boundsClear(a.bounds, b.bounds, gap)) return true;
  if (contains(a.shape, b.shape[0][0]) || contains(b.shape, a.shape[0][0])) return false;
  for (const x of a.edges) for (const y of b.edges) {
    if (boundsClear(x.bounds, y.bounds, gap)) continue;
    if (edgesCross(x.a, x.b, y.a, y.b)) return false;
    if (Math.min(pointDistanceSquared(x.a, y.a, y.b), pointDistanceSquared(x.b, y.a, y.b),
      pointDistanceSquared(y.a, x.a, x.b), pointDistanceSquared(y.b, x.a, x.b)) <= gap ** 2) return false;
  }
  return true;
}
// Distance from a point to the nearest outline edge; zero when the point is inside.
export function pointClearance(point, material, contains) {
  if (contains(material.shape, point)) return 0;
  return Math.sqrt(Math.min(...material.edges.map(({ a, b }) => pointDistanceSquared(point, a, b))));
}
