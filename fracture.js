import { ShapeUtils, Vector2 } from './vendor/three.core.js';
const clipping = globalThis.polyclip;
const EPSILON = 1e-7;
// Compare almost coincident intersections at sub-pixel precision rather than
// letting numerical noise turn shared crack endpoints into separate vertices.
clipping.setPrecision(1e-9);
const MIN_PIECE_AREA = 35;
const MAX_FRAGMENTS = 4;

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
function blastFootprint(center, direction, side, radius, reach, profile) {
  const contour = profile.map(p => inBlastFrame(center, direction, side, radius * p.scale * Math.cos(p.angle), radius * p.scale * Math.sin(p.angle)));
  // A coarse arc makes the closed end of the U. Its sides flare by about 20
  // degrees toward the exterior, like a crater bowl, leaving room for pieces
  // to spread sideways as they leave instead of sliding through the walls.
  const mouth = radius * 1.2 + reach * .36;
  contour.push(inBlastFrame(center, direction, side, -reach, mouth));
  contour.push(inBlastFrame(center, direction, side, -reach, -mouth));
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
function conservesArea(area, pieces) {
  return Math.abs(pieces.reduce((sum, piece) => sum + shapeArea(piece), 0) - area) <= 1e-5;
}
export function fractureShape(shape, entry, center, direction, random = Math.random) {
  const area = shapeArea(shape);
  const unchanged = { retained: [shape], fragments: [], mode: 'none' };
  if (area < MIN_PIECE_AREA * 2) return unchanged;
  if (area <= 8000) {
    // Small pieces retain their existing exterior and split along the bullet
    // line. Every disconnected outline counts toward the four-piece limit.
    const halves = splitThrough(shape, center, direction);
    if (halves.length < 2 || halves.length > MAX_FRAGMENTS || halves.some(isSliver) || !conservesArea(area, halves)) return unchanged;
    return { retained: [], fragments: halves, mode: 'split' };
  }
  const drillDirection = length(sub(center, entry)) > 1e-5 ? normalize(sub(center, entry)) : normalize(direction);
  const side = { x: -drillDirection.y, y: drillDirection.x };
  const depth = length(sub(center, entry)), reach = extent(shape, center) * 6 + 10;
  const segments = 5 + Math.floor(random() * 4), profile = [];
  for (let i = 0; i <= segments; i++) {
    const jitter = i === 0 || i === segments ? 0 : (random() - .5) * .2;
    profile.push({ angle: (i + jitter) / segments * Math.PI - Math.PI / 2, scale: .9 + random() * .2 });
  }
  let radius = depth * (.85 + random() * .7), cap = null, axis = drillDirection;
  // A buried charge breaks out toward the nearest free surface, so the U turns
  // from the drill line toward the inward surface normal. The turn is limited
  // so the whole drill path stays inside the pocket and remains a fracture.
  const normal = surfaceNormal(shape, entry);
  const turn = normal ? Math.atan2(cross(drillDirection, { x: -normal.x, y: -normal.y }), -(drillDirection.x * normal.x + drillDirection.y * normal.y)) * .7 : 0;
  // Keep the U-shaped pocket connected to the surface and local to this
  // impact, including when an earlier shot has left a nearby cavity.
  for (let attempt = 0; attempt < 7; attempt++) {
    const limit = Math.min(Math.PI / 6, depth > 1e-5 ? Math.asin(Math.min(1, .8 * radius / depth)) : Math.PI / 6);
    axis = rotate(drillDirection, Math.max(-limit, Math.min(limit, turn)));
    const candidates = intersection(shape, blastFootprint(center, axis, { x: -axis.y, y: axis.x }, radius, reach, profile));
    cap = candidates.find(piece => contains(piece, center));
    if (cap && shapeArea(cap) <= Math.min(5200, area * .1) && extent(cap, center) < 155) break;
    cap = null; radius *= .73;
  }
  if (!cap || isSliver(cap)) return unchanged;
  const retained = difference(shape, [cap]);
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
  // Cuts close to existing cracks can amplify coordinate rounding. Decline
  // an ambiguous cut rather than accumulate missing material over many shots.
  if (!conservesArea(area, [...retained, ...fragments])) return unchanged;
  return { retained, fragments, mode: 'chip', axis };
}
