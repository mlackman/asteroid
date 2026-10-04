// Ore nuggets: hard crystals buried in the rock. A rock's shape includes the
// ore it holds, so fracture treats ore as solid. A blast never cuts a nugget;
// each one goes whole to the piece that held most of it. Nuggets share the
// original asteroid's coordinates with every rock outline.
import { ORE } from './config.js?v=20261004';
import { hull, contains, clip, subtract, unite, shapeArea, shapeProperties, isSliver, sub, normalize, length } from './fracture.js?v=20261004';

function boundaryDistance(shape, p) {
  let best = Infinity;
  for (const ring of shape) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], edge = sub(b, a), size = edge.x ** 2 + edge.y ** 2;
    const t = size ? Math.max(0, Math.min(1, ((p.x - a.x) * edge.x + (p.y - a.y) * edge.y) / size)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * edge.x, p.y - a.y - t * edge.y));
  }
  return best;
}

// Scatter nuggets through the rock, buried below the surface and apart from each other.
export function placeOre(shape, random, config = ORE) {
  const xs = shape[0].map(p => p.x), ys = shape[0].map(p => p.y);
  const min = { x: Math.min(...xs), y: Math.min(...ys) }, max = { x: Math.max(...xs), y: Math.max(...ys) };
  const count = config.countMin + Math.floor(random() * (config.countMax - config.countMin + 1));
  const ores = [];
  for (let attempt = 0; attempt < 2000 && ores.length < count; attempt++) {
    const radius = (config.sizeMin + random() * (config.sizeMax - config.sizeMin)) / 2;
    const center = { x: min.x + random() * (max.x - min.x), y: min.y + random() * (max.y - min.y) };
    if (!contains(shape, center)) continue;
    const depth = boundaryDistance(shape, center);
    if (depth < radius + config.surfaceMargin || depth > config.depthMax) continue;
    if (ores.some(ore => Math.hypot(ore.center.x - center.x, ore.center.y - center.y) < ore.radius + radius + config.spacing)) continue;
    const corners = config.verticesMin + Math.floor(random() * (config.verticesMax - config.verticesMin + 1));
    const turn = random() * Math.PI * 2;
    const ring = hull(Array.from({ length: corners }, (_, i) => {
      const angle = turn + (i + (random() - .5) * .6) / corners * Math.PI * 2, r = radius * (.75 + random() * .25);
      return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
    }));
    ores.push({ id: ores.length, shape: [ring], area: shapeArea([ring]), center, radius, revealed: false });
  }
  return ores.map(({ id, shape, area, revealed }) => ({ id, shape, area, revealed }));
}

export function oreArea(ores) { return ores.reduce((sum, ore) => sum + ore.area, 0); }

// Share of a nugget's outline that faces open space rather than rock of the
// piece holding it. Samples sit just outside the outline, spaced by length.
export function exposure(ore, holder, samples = 64, offset = .75) {
  const ring = ore.shape[0], center = shapeProperties(ore.shape).center;
  const edges = ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] })), total = edges.reduce((sum, e) => sum + length(sub(e.b, e.a)), 0);
  let open = 0, taken = 0;
  for (const { a, b } of edges) {
    const n = Math.max(1, Math.round(samples * length(sub(b, a)) / total));
    for (let k = 0; k < n; k++) {
      const t = (k + .5) / n, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      // Nuggets are convex, so away from the center is outward.
      const out = normalize(sub(p, center));
      if (!contains(holder, { x: p.x + out.x * offset, y: p.y + out.y * offset })) open++;
      taken++;
    }
  }
  return open / taken;
}

const overlap = (shape, ore) => clip(shape, ore.shape).reduce((sum, part) => sum + shapeArea(part), 0);
const holds = (shape, ore) => contains(shape, shapeProperties(ore.shape).center);
const small = shape => shapeArea(shape) < ORE.minRockPiece || isSliver(shape);

// Hand each nugget, whole, to the piece of a fracture that held most of it,
// and free it from its rock once enough of it faces open space. Takes the
// fracture's shapes; returns pieces as { shape, ores }.
export function distributeOre(retained, fragments, ores) {
  if (!ores.length) {
    return { retained: retained.map(shape => ({ shape, ores: [] })), fragments: fragments.map(shape => ({ shape, ores: [] })) };
  }
  const input = [...retained.map(shape => ({ shape, kind: 'retained' })), ...fragments.map(shape => ({ shape, kind: 'fragment' }))];
  const holder = ores.map(ore => {
    let best = 0, bestArea = -1;
    input.forEach((piece, i) => { const a = overlap(piece.shape, ore); if (a > bestArea) { best = i; bestArea = a; } });
    return best;
  });
  // Ore leaves every piece but its holder; the holder takes all of it.
  let pieces = input.flatMap((piece, i) => {
    const own = ores.filter((_, k) => holder[k] === i);
    const others = ores.filter((ore, k) => holder[k] !== i && overlap(piece.shape, ore) > 1e-9);
    const rock = others.length ? subtract(piece.shape, others.map(ore => ore.shape)) : [piece.shape];
    const shapes = own.length ? unite([...rock, ...own.map(ore => ore.shape)]) : rock;
    return shapes.map(shape => ({ shape, kind: piece.kind, ores: own.filter(ore => holds(shape, ore)) }));
  });
  // Rock left too small or thin by ore taken out of it stays with that ore.
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.ores.length || !small(piece.shape)) continue;
    for (const target of pieces) {
      if (!target.ores.length) continue;
      const merged = unite([target.shape, piece.shape]);
      if (merged.length === 1) { target.shape = merged[0]; pieces.splice(i--, 1); break; }
    }
  }
  // A nugget mostly open to space breaks free. Rock big enough to stand on its
  // own separates; crumbs stay stuck to the nugget.
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.ores.length === 0) continue;
    const ore = piece.ores.find(ore => exposure(ore, piece.shape) >= ORE.detachExposure);
    if (!ore) continue;
    const rest = subtract(piece.shape, [ore.shape]);
    const separate = rest.filter(shape => !small(shape) || piece.ores.some(other => other !== ore && holds(shape, other)));
    if (!separate.length) continue;
    const crumbs = rest.filter(shape => !separate.includes(shape));
    const freed = unite([ore.shape, ...crumbs]);
    if (freed.length !== 1) continue;
    pieces.splice(i, 1,
      ...separate.map(shape => ({ shape, kind: piece.kind, ores: piece.ores.filter(other => other !== ore && holds(shape, other)) })),
      { shape: freed[0], kind: 'fragment', ores: [ore] });
    i--;
  }
  pieces = pieces.map(piece => ({
    ...piece,
    ores: piece.ores.map(ore => ({ ...ore, revealed: ore.revealed || exposure(ore, piece.shape) >= ORE.revealExposure }))
  }));
  const byArea = (a, b) => shapeArea(b.shape) - shapeArea(a.shape);
  return {
    retained: pieces.filter(piece => piece.kind === 'retained').sort(byArea).map(({ shape, ores }) => ({ shape, ores })),
    fragments: pieces.filter(piece => piece.kind === 'fragment').map(({ shape, ores }) => ({ shape, ores }))
  };
}

// Distance along a drill path to the first nugget, or Infinity.
export function oreDistance(ores, from, direction, limit) {
  let best = Infinity;
  const to = { x: from.x + direction.x * limit, y: from.y + direction.y * limit };
  for (const ore of ores) {
    if (contains(ore.shape, from)) return 0;
    const ring = ore.shape[0];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const d = sub(to, from), e = sub(b, a), denom = d.x * e.y - d.y * e.x;
      if (Math.abs(denom) < 1e-12) continue;
      const o = sub(a, from), t = (o.x * e.y - o.y * e.x) / denom, u = (o.x * d.y - o.y * d.x) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) best = Math.min(best, t * limit);
    }
  }
  return best;
}
