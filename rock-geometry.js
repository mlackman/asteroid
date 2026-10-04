import { shapeArea, shapeProperties, triangulate, insetShape, convexParts, fractureShape, minimumWidth, contains, cross, sub, length } from './fracture.js?v=20261003-release';

export function prepareRock(shape, detached = false) {
  const properties = shapeProperties(shape), triangles = triangulate(shape);
  let collisionShapes = [shape];
  if (detached) {
    let clearance = Math.min(.25, minimumWidth(shape) * .075);
    // Use an orientation-independent width. Reduce erosion only when concavities
    // or holes would remove more than half the useful collision area.
    for (let attempt = 0; attempt < 8; attempt++) {
      const inset = insetShape(shape, clearance);
      if (inset.reduce((sum, region) => sum + shapeArea(region), 0) >= properties.area * .5) {
        collisionShapes = inset;
        break;
      }
      clearance *= .5;
    }
  }
  const collisionTriangles = detached ? collisionShapes.flatMap(region => triangulate(region)) : triangles;
  const parts = convexParts(collisionTriangles).map(polygon => ({ polygon, center: shapeProperties([polygon]).center }));
  const xs = shape[0].map(p => p.x), ys = shape[0].map(p => p.y);
  const materialBounds = { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
  return { properties, triangles, parts, materialBounds };
}

// Edges two new bodies share after a cut. Each entry gives the outward normal
// of body b's edge, pointing into body a, and the edge's midpoint. Separating
// the pair without either passing through the other requires a's velocity
// relative to b to have a non-negative component along every such normal.
export function sharedBoundaries(shapes, tolerance = 1e-6) {
  const edges = shapes.map(shape => shape.flatMap(ring => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], d = sub(b, a), l = length(d);
    return { a, b, d: l ? { x: d.x / l, y: d.y / l } : null, l,
      min: { x: Math.min(a.x, b.x) - tolerance, y: Math.min(a.y, b.y) - tolerance },
      max: { x: Math.max(a.x, b.x) + tolerance, y: Math.max(a.y, b.y) + tolerance } };
  }).filter(edge => edge.d)));
  const contacts = [];
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    for (const e of edges[j]) for (const f of edges[i]) {
      if (f.max.x < e.min.x || f.min.x > e.max.x || f.max.y < e.min.y || f.min.y > e.max.y) continue;
      // Collinear and overlapping by a positive length: a shared crack.
      if (Math.abs(cross(e.d, sub(f.a, e.a))) > tolerance || Math.abs(cross(e.d, sub(f.b, e.a))) > tolerance) continue;
      const t0 = (f.a.x - e.a.x) * e.d.x + (f.a.y - e.a.y) * e.d.y, t1 = (f.b.x - e.a.x) * e.d.x + (f.b.y - e.a.y) * e.d.y;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(e.l, Math.max(t0, t1));
      if (hi - lo <= tolerance) continue;
      const mid = { x: e.a.x + e.d.x * (lo + hi) / 2, y: e.a.y + e.d.y * (lo + hi) / 2 };
      let normal = { x: e.d.y, y: -e.d.x };
      if (contains(shapes[j], { x: mid.x + normal.x * 1e-4, y: mid.y + normal.y * 1e-4 })) normal = { x: -normal.x, y: -normal.y };
      contacts.push({ a: i, b: j, normal, point: mid });
    }
  }
  return contacts;
}
export function prepareFracture({ shape, entry, center, direction, detached }, random) {
  const fracture = fractureShape(shape, entry, center, direction, random);
  if (fracture.mode === 'none') return { mode: 'none', retained: [], fragments: [], contacts: [] };
  const retained = fracture.retained.sort((a, b) => shapeArea(b) - shapeArea(a));
  return {
    mode: fracture.mode,
    axis: fracture.axis,
    // Indices follow [...retained, ...fragments].
    contacts: sharedBoundaries([...retained, ...fracture.fragments]),
    retained: retained.map((shape, i) => ({ shape, geometry: prepareRock(shape, detached || i > 0) })),
    fragments: fracture.fragments.map(shape => ({ shape, geometry: prepareRock(shape, true) }))
  };
}
