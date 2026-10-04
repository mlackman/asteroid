import { shapeArea, shapeProperties, triangulate, insetShape, convexParts, fractureShape, minimumWidth, sharedBoundaries, overlapAfter, normalize, sub, clip } from './fracture.js?v=20261004';
import { ORE } from './config.js?v=20261004';
import { distributeOre, oreArea } from './ore.js?v=20261004';
export { sharedBoundaries };

// Mass properties of a rock and the ore it holds. With ore as dense as rock
// they are the visible polygon's own; denser ore shifts the center of mass
// and adds inertia. `area` stays the visible area; `massArea` sets the mass.
function materialProperties(shape, ores) {
  const base = shapeProperties(shape), extra = ORE.densityFactor - 1;
  if (!extra || !ores.length) return { ...base, massArea: base.area };
  const parts = [base, ...ores.map(ore => { const p = shapeProperties(ore.shape); return { area: p.area * extra, center: p.center, inertia: p.inertia * extra }; })];
  const massArea = parts.reduce((sum, p) => sum + p.area, 0);
  const center = { x: parts.reduce((sum, p) => sum + p.area * p.center.x, 0) / massArea, y: parts.reduce((sum, p) => sum + p.area * p.center.y, 0) / massArea };
  const inertia = parts.reduce((sum, p) => sum + p.inertia + p.area * ((p.center.x - center.x) ** 2 + (p.center.y - center.y) ** 2), 0);
  return { area: base.area, massArea, center, inertia };
}

export function prepareRock(shape, detached = false, ores = []) {
  const properties = materialProperties(shape, ores), triangles = triangulate(shape);
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

// Whether sliding a piece along `direction` stays clear of the rock left
// behind. Opening every shared crack only guarantees the first instant; a
// curved piece can still swing a far tip into the rim on its way out.
function slidesClear(piece, direction, obstacles) {
  return [1.5, 6, 20].every(t => obstacles.every(obstacle =>
    overlapAfter(piece, { x: direction.x * t, y: direction.y * t }, obstacle) < .05));
}
// For a crater, how much of the sideways fan each chip can take (1, ½ or 0)
// and whether each broken-off wall piece can move straight away from the
// blast. Moving straight out along the crater's axis is always clear.
function safeLaunches(allRetained, fragments, center, axis) {
  const out = { x: -axis.x, y: -axis.y }, side = { x: -out.y, y: out.x };
  // A piece moving 20 units can only meet rock within that distance of the
  // crater, so the large parent is clipped to the neighbourhood first.
  const r = Math.max(...fragments.flat(2).map(p => Math.hypot(p.x - center.x, p.y - center.y))) + 25;
  const box = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({ x: center.x + x * r, y: center.y + y * r }));
  const nearby = allRetained.map(piece => clip(piece, [box])), retained = nearby.flat(1);
  const offsets = fragments.map(piece => sub(shapeProperties(piece).center, center));
  const maxOffset = Math.max(1, ...offsets.map(o => Math.hypot(o.x, o.y)));
  const spread = fragments.map((piece, i) => {
    const a = (offsets[i].x * out.x + offsets[i].y * out.y) * 6 / maxOffset, c = (offsets[i].x * side.x + offsets[i].y * side.y) * 6 / maxOffset;
    return [1, .5, 0].find(f => f === 0 || slidesClear(piece, normalize({ x: out.x * (13 + a) + side.x * c * f, y: out.y * (13 + a) + side.y * c * f }), retained)) ?? 0;
  });
  const radial = allRetained.map((piece, i) => i === 0 || slidesClear(piece, normalize(sub(shapeProperties(piece).center, center)), nearby.filter((_, j) => j !== i).flat(1)));
  return { spread, radial };
}
export function prepareFracture({ shape, entry, center, direction, detached, through = false, enclosed = 0, ores = [] }, random) {
  const none = { mode: 'none', retained: [], fragments: [], contacts: [] };
  // A clean nugget has no rock to break.
  if (shapeArea(shape) - oreArea(ores) < ORE.cleanTolerance) return none;
  const fracture = fractureShape(shape, entry, center, direction, random, through, enclosed);
  if (fracture.mode === 'none') return none;
  // The fracture ran through ore as if it were rock; each nugget now goes
  // whole to one piece.
  const pieces = distributeOre(fracture.retained.sort((a, b) => shapeArea(b) - shapeArea(a)), fracture.fragments, ores);
  const retained = pieces.retained.map(piece => piece.shape), fragments = pieces.fragments.map(piece => piece.shape);
  return {
    mode: fracture.mode,
    axis: fracture.axis,
    ...(fracture.mode === 'chip' ? safeLaunches(retained, fragments, center, fracture.axis) : {}),
    // Indices follow [...retained, ...fragments].
    contacts: sharedBoundaries([...retained, ...fragments]),
    retained: pieces.retained.map(({ shape, ores }, i) => ({ shape, ores, geometry: prepareRock(shape, detached || i > 0, ores) })),
    fragments: pieces.fragments.map(({ shape, ores }) => ({ shape, ores, geometry: prepareRock(shape, true, ores) }))
  };
}
