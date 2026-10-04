import { ShapeUtils, Vector2 } from './vendor/three.core.js';
const clipping = globalThis.polyclip;
const EPSILON = 1e-7;
// Compare almost coincident intersections at sub-pixel precision rather than
// letting numerical noise turn shared crack endpoints into separate vertices.
clipping.setPrecision(1e-9);
const MIN_PIECE_AREA = 35;
const MAX_FRAGMENTS = 4;
// Wall cracks can add up to two larger pieces beside the crater chips.
const MAX_RELEASED = 6;

export function randomGenerator(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const length = v => Math.hypot(v.x, v.y);
export const normalize = v => { const n = length(v) || 1; return { x: v.x / n, y: v.y / n }; };
export function rotate(p, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}
function signedArea(ring) {
  return ring.reduce((sum, p, i) => sum + cross(p, ring[(i + 1) % ring.length]), 0) / 2;
}
export function polygonArea(ring) { return Math.abs(signedArea(ring)); }
export function shapeArea(shape) {
  return polygonArea(shape[0]) - shape.slice(1).reduce((sum, ring) => sum + polygonArea(ring), 0);
}
export function shapeProperties(shape) {
  let area = 0, x = 0, y = 0, inertia = 0;
  shape.forEach((ring, index) => {
    const sign = Math.sign(signedArea(ring)) * (index === 0 ? 1 : -1);
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length], w = cross(p, q) * sign;
      area += w / 2; x += (p.x + q.x) * w / 6; y += (p.y + q.y) * w / 6;
      inertia += w * (p.x ** 2 + p.x * q.x + q.x ** 2 + p.y ** 2 + p.y * q.y + q.y ** 2) / 12;
    });
  });
  const center = { x: x / area, y: y / area };
  return { area, center, inertia: inertia - area * (center.x ** 2 + center.y ** 2) };
}
export function triangulate(shape, depth = 0) {
  const rings = shape.map(ring => ring.map(p => new Vector2(p.x, p.y)));
  const faces = ShapeUtils.triangulateShape(rings[0], rings.slice(1)), vertices = rings.flat();
  const triangles = faces.map(face => {
    const triangle = face.map(i => ({ x: vertices[i].x, y: vertices[i].y }));
    return signedArea(triangle) < 0 ? triangle.reverse() : triangle;
  }).filter(triangle => polygonArea(triangle) > 1e-10);
  const area = triangles.reduce((sum, triangle) => sum + polygonArea(triangle), 0);
  if (Math.abs(area - shapeArea(shape)) < 1e-6) return triangles;
  // Deeply indented outlines can make ear clipping bridge across a cavity.
  // Divide the actual polygon and triangulate smaller complementary regions
  // instead of accepting extra collision/rendering area or shrinking the rock.
  if (depth >= 8) throw new Error('Unable to triangulate the rock outline faithfully');
  const points = shape.flat(), xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const splitAlongX = maxX - minX >= maxY - minY;
  const midX = splitAlongX ? (minX + maxX) / 2 : maxX + 1;
  const midY = splitAlongX ? maxY + 1 : (minY + maxY) / 2;
  const mask = [[{ x: minX - 1, y: minY - 1 }, { x: midX, y: minY - 1 }, { x: midX, y: midY }, { x: minX - 1, y: midY }]];
  const regions = [...intersection(shape, mask), ...difference(shape, [mask])];
  return regions.flatMap(region => triangulate(region, depth + 1));
}
function hull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = ps => {
    const result = [];
    for (const p of ps) {
      while (result.length > 1 && cross(sub(result.at(-1), result.at(-2)), sub(p, result.at(-1))) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.reverse())];
}
export function minimumWidth(shape) {
  const outline = hull(shape[0]);
  return Math.min(...outline.map((p, i) => {
    const edge = normalize(sub(outline[(i + 1) % outline.length], p));
    const projections = outline.map(point => point.x * -edge.y + point.y * edge.x);
    return Math.max(...projections) - Math.min(...projections);
  }));
}
export function convexParts(triangles) {
  const parts = triangles.map(triangle => [...triangle]);
  // Merge only when the convex hull adds no material. This removes internal
  // collision seams without bridging a concavity or filling a hole.
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const merged = hull([...parts[i], ...parts[j]]);
      if (Math.abs(polygonArea(merged) - polygonArea(parts[i]) - polygonArea(parts[j])) > 1e-7) continue;
      parts[i] = merged;
      parts.splice(j, 1);
      j = i; // Recheck neighbors after the merged boundary changes.
    }
  }
  return parts;
}
export function makeAsteroid(seed = 74192) {
  const random = randomGenerator(seed);
  const outline = hull(Array.from({ length: 31 }, (_, i) => {
    const angle = i / 31 * Math.PI * 2, radius = 275 + random() * 57;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * .83 };
  }));
  return { shape: [outline], area: polygonArea(outline) };
}
export function onSegment(p, a, b, epsilon = EPSILON) {
  const edge = sub(b, a), offset = sub(p, a), size = length(edge);
  return Math.abs(cross(edge, offset)) <= epsilon * Math.max(1, size) && offset.x * edge.x + offset.y * edge.y >= -epsilon && offset.x * edge.x + offset.y * edge.y <= size ** 2 + epsilon;
}
function ringContains(ring, p) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(p, a, b)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function contains(shape, p) {
  return ringContains(shape[0], p) && !shape.slice(1).some(ring => ringContains(ring, p));
}
function intersections(shape, from, to) {
  const delta = sub(to, from), hits = [];
  for (const ring of shape) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], edge = sub(ring[(i + 1) % ring.length], a), denom = cross(delta, edge);
    if (Math.abs(denom) < 1e-12) continue;
    const offset = sub(a, from), t = cross(offset, edge) / denom, u = cross(offset, delta) / denom;
    if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) hits.push(Math.max(0, Math.min(1, t)));
  }
  return hits.sort((a, b) => a - b);
}
export function segmentHit(shape, from, to) {
  if (contains(shape, from)) return 0;
  return intersections(shape, from, to)[0] ?? Infinity;
}
export function solidDistance(shape, from, direction, limit) {
  const to = { x: from.x + direction.x * limit, y: from.y + direction.y * limit };
  const hits = intersections(shape, from, to);
  for (const t of hits) {
    const distance = t * limit;
    if (distance < 1e-6) continue;
    const after = { x: from.x + direction.x * (distance + 1e-5), y: from.y + direction.y * (distance + 1e-5) };
    if (!contains(shape, after)) return distance;
  }
  return limit;
}
const toCoordinates = shape => shape.map(ring => ring.map(p => [p.x, p.y]));
function fromCoordinates(multiPolygon) {
  return multiPolygon.map(polygon => polygon.map(ring => {
    const result = ring.map(p => ({ x: p[0], y: p[1] }));
    if (length(sub(result[0], result.at(-1))) < EPSILON) result.pop();
    return result;
  })).filter(shape => shape[0].length >= 3 && shapeArea(shape) > 1e-8);
}
function intersection(shape, mask) { return fromCoordinates(clipping.intersection(toCoordinates(shape), toCoordinates(mask))); }
function difference(shape, pieces) { return fromCoordinates(clipping.difference(toCoordinates(shape), pieces.map(toCoordinates))); }
export function insetShape(shape, clearance) {
  // Subtract a narrow strip around every boundary, including hole boundaries.
  // Scaling toward a centroid can push concave edges outside the visible rock;
  // eroding the outline keeps every collision region inside its material.
  const strips = shape.flatMap(ring => ring.map((p, i) => {
    const edge = normalize(sub(ring[(i + 1) % ring.length], p));
    const side = { x: -edge.y, y: edge.x }, q = ring[(i + 1) % ring.length];
    return [[
      { x: p.x + (-edge.x + side.x) * clearance, y: p.y + (-edge.y + side.y) * clearance },
      { x: q.x + (edge.x + side.x) * clearance, y: q.y + (edge.y + side.y) * clearance },
      { x: q.x + (edge.x - side.x) * clearance, y: q.y + (edge.y - side.y) * clearance },
      { x: p.x + (-edge.x - side.x) * clearance, y: p.y + (-edge.y - side.y) * clearance }
    ]];
  }));
  return difference(shape, strips);
}
function extent(shape, center) {
  return Math.max(...shape.flat().map(p => length(sub(p, center))));
}
function inBlastFrame(center, direction, side, forward, across) {
  return { x: center.x + direction.x * forward + side.x * across, y: center.y + direction.y * forward + side.y * across };
}
// A rough crater bowl. Its rim lies on the rock surface `surface` units behind
// the detonation point and its floor `floor` units beyond it, so the round sits
// near the bottom of a bowl that is several times wider than it is deep. Each
// side has its own width, and corners run up both walls to the rim.
function blastFootprint(center, direction, side, surface, floor, profile, reach) {
  const depth = surface + floor;
  const halfWidth = u => depth * (u < 0 ? profile.left : profile.right);
  const contour = profile.points.map(({ u, scale }) => inBlastFrame(center, direction, side, -surface + depth * (1 - u * u) * scale, u * halfWidth(u)));
  // Past the rim the walls keep their slope out through the exterior, so the
  // bowl cuts cleanly through an uneven surface.
  for (const u of [-1, 1]) {
    const flare = halfWidth(u) / (2 * depth);
    contour.push(inBlastFrame(center, direction, side, -surface - reach, u * (halfWidth(u) + reach * flare)));
  }
  // Keep the pocket convex: inward hooks can mechanically trap matching pieces.
  return [hull(contour)];
}
function facetedCutMask(center, direction, side, span, offset, curve, reach) {
  const contour = [inBlastFrame(center, direction, side, -reach, offset - curve.tilt / 2)];
  // Each shared polyline creates complementary outlines rather than separately
  // jittering the two edges and leaving overlaps or missing rock.
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const across = offset + curve.tilt * (t - .5) + curve.bow * Math.sin(t * Math.PI) + curve.wave * Math.sin(t * Math.PI * 2);
    contour.push(inBlastFrame(center, direction, side, span * (t - 1), across));
  }
  contour.push(inBlastFrame(center, direction, side, reach, offset + curve.tilt / 2));
  contour.push(inBlastFrame(center, direction, side, reach, -reach));
  contour.push(inBlastFrame(center, direction, side, -reach, -reach));
  return [contour];
}
function perimeter(shape) {
  return shape.reduce((sum, ring) => sum + ring.reduce((s, p, i) => s + length(sub(p, ring[(i + 1) % ring.length])), 0), 0);
}
function isSliver(shape) {
  const area = shapeArea(shape);
  return area < MIN_PIECE_AREA || 2 * area / perimeter(shape) < .8;
}
function mergeSlivers(pieces) {
  const result = [...pieces];
  for (let i = 0; i < result.length; i++) {
    if (!isSliver(result[i]) || result.length === 1) continue;
    for (let j = 0; j < result.length; j++) {
      if (i === j) continue;
      const union = fromCoordinates(clipping.union(toCoordinates(result[i]), toCoordinates(result[j])));
      if (union.length === 1) {
        result[j] = union[0]; result.splice(i, 1); i = -1; break;
      }
    }
  }
  return result;
}
function splitThrough(shape, center, direction) {
  const reach = extent(shape, center) * 6 + 10, normal = { x: -direction.y, y: direction.x };
  const mask = sign => [[
    { x: center.x - direction.x * reach, y: center.y - direction.y * reach },
    { x: center.x + direction.x * reach, y: center.y + direction.y * reach },
    { x: center.x + direction.x * reach + normal.x * reach * sign, y: center.y + direction.y * reach + normal.y * reach * sign },
    { x: center.x - direction.x * reach + normal.x * reach * sign, y: center.y - direction.y * reach + normal.y * reach * sign }
  ]];
  return [...intersection(shape, mask(1)), ...intersection(shape, mask(-1))];
}
// Outward normal of the outline near a surface point, averaged over the edges
// within a few units so one jagged facet does not swing the result. Returns
// null when the point is not on this shape's outline.
export function surfaceNormal(shape, point, radius = 4) {
  let sum = { x: 0, y: 0 }, nearest = Infinity;
  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], edge = sub(ring[(i + 1) % ring.length], a), edgeLength = length(edge);
      if (!edgeLength) continue;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * edge.x + (point.y - a.y) * edge.y) / edgeLength ** 2));
      const distance = length(sub(point, { x: a.x + edge.x * t, y: a.y + edge.y * t }));
      nearest = Math.min(nearest, distance);
      if (distance > radius) continue;
      const n = { x: edge.y / edgeLength, y: -edge.x / edgeLength };
      const probe = { x: a.x + edge.x / 2 + n.x * .01, y: a.y + edge.y / 2 + n.y * .01 };
      const sign = contains(shape, probe) ? -1 : 1, weight = Math.min(edgeLength, radius);
      sum = { x: sum.x + n.x * sign * weight, y: sum.y + n.y * sign * weight };
    }
  }
  return nearest > 1 || length(sum) < 1e-9 ? null : normalize(sum);
}
// Edges that pieces of one fracture share. Each entry gives the outward normal
// of piece b's edge, pointing into piece a, and the shared segment's midpoint.
// Separating the pair without either passing through the other requires a's
// velocity relative to b to have a non-negative component along every normal.
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
function pointSegmentDistance(p, a, b) {
  const d = sub(b, a), l2 = d.x * d.x + d.y * d.y;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2)) : 0;
  return length(sub(p, { x: a.x + d.x * t, y: a.y + d.y * t }));
}
// Crack a shape along an open polyline. The cut mask extends the line in both
// directions so it always crosses the outline, but rock is only separated where
// the crack itself runs: regions divided only by an extension are joined again.
// A crack that ends inside the rock, or opens only into a hole, separates nothing.
function cutAlong(shape, crack) {
  const first = normalize(sub(crack[1], crack[0])), last = normalize(sub(crack.at(-1), crack.at(-2)));
  const reach = extent(shape, crack[0]) * 6 + 10;
  const start = { x: crack[0].x - first.x * reach, y: crack[0].y - first.y * reach };
  const end = { x: crack.at(-1).x + last.x * reach, y: crack.at(-1).y + last.y * reach };
  const overall = normalize(sub(end, start)), left = { x: -overall.y * reach, y: overall.x * reach };
  const mask = [[start, ...crack, end, { x: end.x + left.x, y: end.y + left.y }, { x: start.x + left.x, y: start.y + left.y }]];
  const regions = [...intersection(shape, mask), ...difference(shape, [mask])];
  const onCrack = p => crack.some((a, i) => i < crack.length - 1 && pointSegmentDistance(p, a, crack[i + 1]) < 1e-6);
  const group = regions.map((_, i) => i), find = i => group[i] === i ? i : (group[i] = find(group[i]));
  for (const { a, b, point } of sharedBoundaries(regions)) if (!onCrack(point)) group[find(a)] = find(b);
  const merged = new Map();
  regions.forEach((region, i) => merged.set(find(i), [...(merged.get(find(i)) || []), region]));
  return [...merged.values()].flatMap(parts => parts.length === 1 ? parts : fromCoordinates(clipping.union(...parts.map(toCoordinates))));
}
// A rough crack running outward from `from` along `direction` for `distance`,
// then a little past it, with a few small sideways kinks.
function crackLine(from, direction, start, distance, random) {
  const side = { x: -direction.y, y: direction.x }, points = [];
  for (const t of [0, 1 / 3, 2 / 3]) {
    const along = start + distance * t, offset = t ? (random() - .5) * .24 * distance : 0;
    points.push({ x: from.x + direction.x * along + side.x * offset, y: from.y + direction.y * along + side.y * offset });
  }
  points.push({ x: from.x + direction.x * (start + distance + 2), y: from.y + direction.y * (start + distance + 2) });
  return points;
}
function conservesArea(area, pieces) {
  return Math.abs(pieces.reduce((sum, piece) => sum + shapeArea(piece), 0) - area) <= 1e-5;
}
// A round that passes through a body cracks it along its tunnel. The pieces
// keep their exterior; the largest one stays as the parent.
function tunnelSplit(shape, entry, exit, area) {
  const pieces = cutAlong(shape, [entry, exit]).sort((a, b) => shapeArea(b) - shapeArea(a));
  if (pieces.length < 2 || pieces.length > MAX_FRAGMENTS || pieces.some(isSliver) || !conservesArea(area, pieces)) return null;
  return { retained: [pieces[0]], fragments: pieces.slice(1), mode: 'split' };
}
// A blast too large for its body breaks it into wedges around the detonation.
// The first crack runs to the nearest free surface; the rest divide the circle
// roughly evenly. Bigger bodies break into more pieces.
function shatter(shape, center, area, random) {
  const count = Math.min(MAX_FRAGMENTS, 2 + (area > 600) + (area > 1500));
  const reach = extent(shape, center) + 10, toSurface = angle => solidDistance(shape, center, { x: Math.cos(angle), y: Math.sin(angle) }, reach);
  let nearest = 0;
  for (let i = 1; i < 48; i++) if (toSurface(i / 48 * Math.PI * 2) < toSurface(nearest)) nearest = i / 48 * Math.PI * 2;
  const step = Math.PI * 2 / count;
  const angles = Array.from({ length: count }, (_, i) => nearest + i * step + (i ? (random() - .5) * .5 * step : 0));
  const cracks = angles.map(angle => {
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    return crackLine(center, direction, 0, Math.min(toSurface(angle), reach), random).slice(0, -1)
      .concat([{ x: center.x + direction.x * reach, y: center.y + direction.y * reach }]);
  });
  const wedges = angles.map((angle, i) => {
    const next = angles[(i + 1) % count] + (i === count - 1 ? Math.PI * 2 : 0), arc = [];
    for (let a = angle + .3; a < next - .15; a += .3) arc.push({ x: center.x + Math.cos(a) * reach, y: center.y + Math.sin(a) * reach });
    return [[...cracks[i], ...arc, ...[...cracks[(i + 1) % count]].reverse().slice(0, -1)]];
  });
  const pieces = mergeSlivers(wedges.flatMap(wedge => intersection(shape, wedge)));
  if (pieces.length < 2 || pieces.some(isSliver) || !conservesArea(area, pieces)) return null;
  return { retained: [], fragments: pieces, mode: 'shatter' };
}
// Rock between the blast pocket and the outer surface fails where it is thin
// compared with the blast. Look across the pocket's closed end for the
// thinnest walls and run a crack through each one that is thinner than the
// blast radius. On a large asteroid the walls are thick and nothing cracks.
function wallCracks(shape, cap, center, axis, radius, random) {
  const reach = extent(shape, center) + 10, samples = [];
  for (let i = -16; i <= 16; i++) {
    const direction = rotate(axis, i / 16 * Math.PI * 4 / 9);
    const inPocket = solidDistance(cap, center, direction, reach), toSurface = solidDistance(shape, center, direction, reach);
    // Rays that leave through the crater's mouth have no wall.
    samples.push({ direction, inPocket, wall: toSurface - inPocket < 1e-3 ? Infinity : toSurface - inPocket });
  }
  const thin = samples.filter((sample, i) => sample.wall < radius &&
    sample.wall <= (samples[i - 1]?.wall ?? Infinity) && sample.wall <= (samples[i + 1]?.wall ?? Infinity));
  const chosen = [];
  for (const sample of thin.sort((a, b) => a.wall - b.wall)) {
    if (chosen.every(other => other.direction.x * sample.direction.x + other.direction.y * sample.direction.y < Math.cos(Math.PI * 5 / 18))) chosen.push(sample);
  }
  return chosen.slice(0, 2).map(({ direction, inPocket, wall }) => crackLine(center, direction, Math.max(0, inPocket - .5), wall + .5, random));
}
export function fractureShape(shape, entry, center, direction, random = Math.random, through = false) {
  const area = shapeArea(shape);
  const unchanged = { retained: [shape], fragments: [], mode: 'none' };
  if (area < MIN_PIECE_AREA * 2) return unchanged;
  if (through) return tunnelSplit(shape, entry, center, area) || unchanged;
  const drillDirection = length(sub(center, entry)) > 1e-5 ? normalize(sub(center, entry)) : normalize(direction);
  const side = { x: -drillDirection.y, y: drillDirection.x };
  const depth = length(sub(center, entry)), reach = extent(shape, center) * 6 + 10;
  // The bowl is 2.5–3.5 times wider than deep, a little lopsided, with 12–16
  // corners from rim to rim. Corners crowd toward the rim, where the wall is
  // steepest, and are unevenly spaced. They stay on the convex curve, since
  // a corner pushed inward would be dropped and leave a long straight wall.
  const corners = 12 + Math.floor(random() * 5), width = 1.25 + random() * .5;
  const profile = { left: width * (.85 + random() * .3), right: width * (.85 + random() * .3), points: [] };
  for (let i = 0; i <= corners; i++) {
    const v = -1 + (2 * i + (i > 0 && i < corners ? (random() - .5) * .8 : 0)) / corners;
    profile.points.push({ u: (v + Math.sin(v * Math.PI / 2)) / 2, scale: 1 });
  }
  let radius = depth * (.85 + random() * .7), floor = radius * (.25 + random() * .15), scale = 1, cap = null, axis = drillDirection;
  // A buried charge breaks out toward the nearest free surface, so the bowl
  // turns from the drill line toward the inward surface normal, as far as the
  // entry point stays inside its rim. The whole drill path then lies inside
  // the crater and remains a fracture.
  const normal = surfaceNormal(shape, entry);
  const turn = normal ? Math.atan2(cross(drillDirection, { x: -normal.x, y: -normal.y }), -(drillDirection.x * normal.x + drillDirection.y * normal.y)) : 0;
  // Keep the crater connected to the surface and local to this
  // impact, including when an earlier shot has left a nearby cavity. A pocket
  // that would take out a large share of the body means the blast is too big
  // for it: the whole body shatters instead.
  for (let attempt = 0; attempt < 7; attempt++) {
    // The entry point lies depth·sin(turn) from the bowl's axis and must stay
    // well inside the rim. A grazing round stretches the bowl on its entry
    // side, up to 3.5 times its depth, like an oblique impact crater; beyond
    // that the bowl turns less.
    const surfaceAt = a => { const back = rotate(drillDirection, a); return solidDistance(shape, center, { x: -back.x, y: -back.y }, reach); };
    let tilt = turn, shaped = null;
    for (let k = 4; k >= 0 && !shaped; k--) {
      tilt = turn * k / 4;
      const bowl = surfaceAt(tilt) + floor * scale, needed = depth * Math.abs(Math.sin(tilt)) / .8 / bowl;
      // Positive turns put the entry on the bowl's left (negative across) side.
      const entrySide = tilt > 0 ? 'left' : 'right';
      const widths = { left: profile.left * scale, right: profile.right * scale };
      if (needed <= Math.max(widths[entrySide], 3.5) || k === 0) shaped = { ...profile, ...widths, [entrySide]: Math.max(widths[entrySide], Math.min(needed, 3.5)) };
    }
    axis = rotate(drillDirection, tilt);
    const footprint = blastFootprint(center, axis, { x: -axis.y, y: axis.x }, surfaceAt(tilt), floor * scale, shaped, reach);
    const candidates = intersection(shape, footprint);
    cap = candidates.find(piece => contains(piece, center));
    if (attempt === 0 && (!cap || shapeArea(cap) > area * .4)) return shatter(shape, center, area, random) || unchanged;
    if (cap && shapeArea(cap) <= Math.min(5200, area * .4) && extent(cap, center) < 155) break;
    cap = null; radius *= .73; scale *= .8;
  }
  if (!cap || isSliver(cap)) return unchanged;
  let retained = difference(shape, [cap]);
  const budget = MAX_FRAGMENTS - Math.max(0, retained.length - 1);
  if (budget < 2 || retained.some(isSliver)) return unchanged;
  // The bullet path divides the whole blast first, so neither side is chosen
  // at random or left attached. Extra cuts subdivide either half into chunks.
  const halves = splitThrough(cap, center, drillDirection);
  if (halves.length < 2 || halves.length > budget || halves.some(isSliver)) return unchanged;
  const requested = Math.min(budget, 2 + Math.floor(random() * (MAX_FRAGMENTS - 1)));
  const fragments = [...halves];
  const order = random() < .5 ? halves : [...halves].reverse();
  for (const half of order) {
    if (fragments.length >= requested) break;
    const offset = sub(shapeProperties(half).center, center);
    const sign = offset.x * side.x + offset.y * side.y > 0 ? -1 : 1;
    const acrossDirection = { x: side.x * sign, y: side.y * sign };
    const curve = { tilt: depth * (random() - .5) * .4, bow: depth * (random() - .5) * .25, wave: depth * (random() - .5) * .05 };
    const cutAngle = (random() - .5) * .8;
    const mask = facetedCutMask(center, rotate(acrossDirection, cutAngle), rotate(drillDirection, cutAngle), radius, depth * (-.35 + random() * .5), curve, reach);
    const rear = intersection(half, mask);
    const children = mergeSlivers([...rear, ...difference(half, rear)]);
    if (children.length >= 2 && fragments.length - 1 + children.length <= budget && !children.some(isSliver) && children.every(piece => 4 * Math.PI * shapeArea(piece) / perimeter(piece) ** 2 >= .5)) {
      fragments.splice(fragments.indexOf(half), 1, ...children);
    }
  }
  for (const crack of wallCracks(shape, cap, center, axis, radius, random)) {
    const cracked = retained.flatMap(piece => cutAlong(piece, crack));
    if (cracked.length > retained.length && cracked.length - 1 + fragments.length <= MAX_RELEASED && !cracked.some(isSliver)) retained = cracked;
  }
  // Cuts close to existing cracks can amplify coordinate rounding. Decline
  // an ambiguous cut rather than accumulate missing material over many shots.
  if (!conservesArea(area, [...retained, ...fragments])) return unchanged;
  return { retained, fragments, mode: 'chip', axis };
}
