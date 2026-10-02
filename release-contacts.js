const { Detector } = globalThis.Matter;
const detectCollisions = Detector.collisions;
// Filter before Matter creates contact pairs: neither rebound impulses nor
// penetration correction should act between pieces still detaching together.
Detector.collisions = detector => detectCollisions(detector).filter(({ parentA, parentB }) =>
  !parentA.plugin.releasePeers?.has(parentB) && !parentB.plugin.releasePeers?.has(parentA));

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
function snapshot(entity, toWorld) {
  const shape = entity.shape.map(ring => ring.map(p => toWorld(entity, p)));
  const edges = shape.flatMap(ring => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { a, b, bounds: bounds([a, b]) };
  }));
  return { shape, edges, bounds: bounds(shape[0]) };
}
function separated(a, b, contains, gap = .25) {
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

export class ReleaseContacts {
  constructor(engine, toWorld, contains) {
    this.releases = new Map();
    this.toWorld = toWorld;
    this.contains = contains;
    this.engine = engine;
    this.beforeSolve = () => this.update();
    globalThis.Matter.Events.on(engine, 'beforeSolve', this.beforeSolve);
  }
  setPeers(entity, peers) {
    this.releases.set(entity, peers);
    entity.body.plugin.releasePeers = new Set([...peers].map(peer => peer.body));
  }
  replace(parent, children, released) {
    const wasReleasing = this.releases.has(parent);
    const inherited = new Set(this.releases.get(parent) || []);
    for (const [piece, peers] of this.releases) if (peers.has(parent)) inherited.add(piece);
    inherited.delete(parent);
    this.releases.delete(parent);
    delete parent.body.plugin.releasePeers;
    for (const [piece, peers] of this.releases) {
      if (!peers.delete(parent)) continue;
      for (const child of children) peers.add(child);
      this.setPeers(piece, peers);
    }
    for (const child of children) {
      if (!wasReleasing && !released.includes(child)) continue;
      this.setPeers(child, new Set([...inherited, ...children.filter(other => other !== child)]));
    }
  }
  update() {
    const snapshots = new Map();
    const material = entity => {
      if (!snapshots.has(entity)) snapshots.set(entity, snapshot(entity, this.toWorld));
      return snapshots.get(entity);
    };
    for (const [piece, peers] of this.releases) {
      if (![...peers].every(peer => separated(material(piece), material(peer), this.contains))) continue;
      this.releases.delete(piece);
      delete piece.body.plugin.releasePeers;
    }
  }
  dispose() {
    globalThis.Matter.Events.off(this.engine, 'beforeSolve', this.beforeSolve);
    for (const piece of this.releases.keys()) delete piece.body.plugin.releasePeers;
    this.releases.clear();
  }
}
