import { shapeArea, shapeProperties, triangulate, insetShape, convexParts, fractureShape, minimumWidth } from './fracture.js?v=20261003-release';

export function prepareRock(shape, detached = false) {
  const properties = shapeProperties(shape), triangles = triangulate(shape);
  let collisionShapes = [shape];
  if (detached) {
    let clearance = minimumWidth(shape) * .075;
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

export function prepareFracture({ shape, entry, center, direction, detached }, random) {
  const fracture = fractureShape(shape, entry, center, direction, random);
  if (fracture.mode === 'none') return { mode: 'none', retained: [], fragments: [] };
  return {
    mode: fracture.mode,
    retained: fracture.retained.sort((a, b) => shapeArea(b) - shapeArea(a)).map((shape, i) => ({ shape, geometry: prepareRock(shape, detached || i > 0) })),
    fragments: fracture.fragments.map(shape => ({ shape, geometry: prepareRock(shape, true) }))
  };
}
