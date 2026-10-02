// A Voronoi partition gives the asteroid complementary, genuinely matching pieces.
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
export function polygonArea(poly) {
  return Math.abs(poly.reduce((sum, p, i) => sum + cross(p, poly[(i + 1) % poly.length]), 0)) / 2;
}
export function centroid(poly) {
  let x = 0, y = 0, area = 0;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], w = cross(p, q);
    x += (p.x + q.x) * w; y += (p.y + q.y) * w; area += w;
  });
  return { x: x / (3 * area), y: y / (3 * area) };
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
function clip(poly, nx, ny, offset) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = a.x * nx + a.y * ny - offset, db = b.x * nx + b.y * ny - offset;
    if (da <= 1e-8) out.push(a);
    if ((da < 0) !== (db < 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
export function makeAsteroid(seed = 74192) {
  const random = randomGenerator(seed);
  const outline = hull(Array.from({ length: 31 }, (_, i) => {
    const angle = i / 31 * Math.PI * 2;
    const radius = 275 + random() * 57;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * .83 };
  }));
  const sites = [];
  for (let y = -300; y <= 300; y += 33) for (let x = -350; x <= 350; x += 33) {
    sites.push({ x: x + (random() - .5) * 26, y: y + (random() - .5) * 26 });
  }
  const cells = [];
  sites.forEach(site => {
    let poly = outline;
    for (const other of sites) {
      if (site === other) continue;
      const nx = other.x - site.x, ny = other.y - site.y;
      poly = clip(poly, nx, ny, (other.x ** 2 + other.y ** 2 - site.x ** 2 - site.y ** 2) / 2);
      if (poly.length < 3) break;
    }
    if (poly.length >= 3 && polygonArea(poly) > 1e-7) cells.push({ id: cells.length, poly, center: centroid(poly), area: polygonArea(poly), neighbors: [] });
  });
  // Shared edges identify connectivity, including after a narrow neck breaks.
  const edges = new Map(), key = p => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  cells.forEach(cell => cell.poly.forEach((a, i) => {
    const b = cell.poly[(i + 1) % cell.poly.length], ends = [key(a), key(b)].sort(), k = ends.join('|');
    if (edges.has(k)) {
      const other = edges.get(k);
      cell.neighbors.push(other.id); other.neighbors.push(cell.id);
    } else edges.set(k, cell);
  }));
  return { cells, outline, area: polygonArea(outline) };
}
export function contains(poly, p) {
  for (let i = 0; i < poly.length; i++) {
    if (cross(sub(poly[(i + 1) % poly.length], poly[i]), sub(p, poly[i])) < -1e-6) return false;
  }
  return true;
}
// Exact swept segment test: fast projectiles cannot skip thin fragments.
export function segmentHit(poly, from, to) {
  if (contains(poly, from)) return 0;
  const delta = sub(to, from);
  let first = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], edge = sub(poly[(i + 1) % poly.length], a);
    const denom = cross(delta, edge);
    if (Math.abs(denom) < 1e-10) continue;
    const offset = sub(a, from), t = cross(offset, edge) / denom, u = cross(offset, delta) / denom;
    if (t >= 0 && t <= 1 && u >= -1e-8 && u <= 1 + 1e-8) first = Math.min(first, t);
  }
  return first;
}
export function connectedComponents(cells) {
  const remaining = new Map(cells.map(c => [c.id, c])), groups = [];
  while (remaining.size) {
    const first = remaining.values().next().value, group = [], queue = [first];
    remaining.delete(first.id);
    while (queue.length) {
      const cell = queue.pop(); group.push(cell);
      for (const id of cell.neighbors) if (remaining.has(id)) { queue.push(remaining.get(id)); remaining.delete(id); }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => b.reduce((s, c) => s + c.area, 0) - a.reduce((s, c) => s + c.area, 0));
}
export function chooseBlastCells(cells, entry, center, hitId, random = Math.random) {
  const byId = new Map(cells.map(c => [c.id, c]));
  const selected = new Map(), count = 3 + Math.floor(random() * 4);
  // Open the entire shallow drill path to the surface, so the blast is never
  // just a hole hidden inside an intact silhouette.
  for (const cell of cells) if (segmentHit(cell.poly, entry, center) !== Infinity) selected.set(cell.id, cell);
  if (byId.has(hitId)) selected.set(hitId, byId.get(hitId));
  while (selected.size < count) {
    const candidates = new Map();
    for (const cell of selected.values()) for (const id of cell.neighbors) {
      if (!selected.has(id) && byId.has(id)) candidates.set(id, byId.get(id));
    }
    if (!candidates.size) break;
    const next = [...candidates.values()].sort((a, b) => length(sub(a.center, center)) - length(sub(b.center, center)))[0];
    selected.set(next.id, next);
  }
  return [...selected.values()];
}
