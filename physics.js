import { rotate, sub, cross, normalize, contains, segmentHit, solidDistance } from './fracture.js?v=20261003-release';
import { prepareRock, prepareFracture } from './rock-geometry.js?v=20261003-release';
import { ReleaseContacts } from './release-contacts.js?v=20261003-release';
const { Engine, Body, Composite, Resolver, Events } = globalThis.Matter;
// Cached penetration corrections otherwise keep translating a body after it
// leaves contact, producing a visible burst that decays despite constant velocity.
Resolver._positionWarming = 0;
export const STEP = 1000 / 120;
const COLLISION_SUBSTEPS = 8;
const OPTIONS = { friction: 0, frictionStatic: 0, frictionAir: 0, restitution: .32, slop: .015, density: .0024 };
export function localToWorld(entity, point) {
  const p = rotate(sub(point, entity.pivot), entity.body.angle);
  return { x: p.x + entity.body.position.x, y: p.y + entity.body.position.y };
}
export function worldToLocal(entity, point) {
  const p = rotate(sub(point, entity.body.position), -entity.body.angle);
  return { x: p.x + entity.pivot.x, y: p.y + entity.pivot.y };
}
function velocityAt(body, point) {
  const r = sub(point, body.position);
  const velocity = Body.getVelocity(body), spin = Body.getAngularVelocity(body);
  return { x: velocity.x - spin * r.y, y: velocity.y + spin * r.x };
}
function impulse(body, point, kick) {
  if (body.isStatic) return;
  const velocity = Body.getVelocity(body);
  Body.setVelocity(body, { x: velocity.x + kick.x / body.mass, y: velocity.y + kick.y / body.mass });
  Body.setAngularVelocity(body, Body.getAngularVelocity(body) + cross(sub(point, body.position), kick) / body.inertia);
}
function reboundRockContacts(pairs) {
  const contacts = [];
  for (const pair of pairs) {
    const { parentA: a, parentB: b, normal, supports, supportCount } = pair.collision;
    if (a.label !== 'Rock' || b.label !== 'Rock') continue;
    // Several convex parts can report the same face contact. Use one contact
    // centroid so the rigid bodies receive one impact, not repeated triangle kicks.
    let contact = contacts.find(c => c.a === a && c.b === b && c.normal.x * normal.x + c.normal.y * normal.y > .9999);
    if (!contact) { contact = { a, b, normal: { ...normal }, points: [] }; contacts.push(contact); }
    contact.points.push(...supports.slice(0, supportCount));
    for (const cached of pair.contacts) { cached.normalImpulse = 0; cached.tangentImpulse = 0; }
  }
  for (const { a, b, normal, points } of contacts) {
    const point = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
    const relative = sub(velocityAt(a, point), velocityAt(b, point));
    const closing = relative.x * normal.x + relative.y * normal.y;
    if (closing >= 0) continue;
    const leverA = cross(sub(point, a.position), normal), leverB = cross(sub(point, b.position), normal);
    const inverseMass = a.inverseMass + b.inverseMass + leverA ** 2 * a.inverseInertia + leverB ** 2 * b.inverseInertia;
    if (inverseMass === 0) continue;
    // One elastic impulse conserves linear/angular momentum and kinetic energy.
    // Matter's iterative resting-contact solve can cancel a slow restitution bounce.
    const strength = -2 * closing / inverseMass;
    const kick = { x: normal.x * strength, y: normal.y * strength };
    impulse(a, point, kick);
    impulse(b, point, { x: -kick.x, y: -kick.y });
  }
}
export class Simulation {
  constructor(asteroid, random = Math.random, fracturePlanner = null) {
    this.random = random;
    this.fracturePlanner = fracturePlanner;
    this.disposed = false;
    this.engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 }, positionIterations: 8, velocityIterations: 8 });
    this.releaseContacts = new ReleaseContacts(this.engine, localToWorld, contains);
    Events.on(this.engine, 'collisionStart', event => reboundRockContacts(event.pairs));
    this.rocks = [];
    this.originalShape = asteroid.shape;
    this.asteroid = this.createRock(asteroid.shape, { x: 180, y: 0 });
    this.totalArea = asteroid.area;
    this.shots = 0;
    this.explosions = 0;
    this.bullets = [];
    this.lastBlast = null;
    const wingA = Body.create({ ...OPTIONS, density: .004, position: { x: -13 / 3, y: -1 / 3 }, vertices: [{ x: -13, y: -15 }, { x: 0, y: 20 }, { x: 0, y: -6 }] });
    const wingB = Body.create({ ...OPTIONS, density: .004, position: { x: 13 / 3, y: -1 / 3 }, vertices: [{ x: 0, y: 20 }, { x: 13, y: -15 }, { x: 0, y: -6 }] });
    this.ship = Body.create({ ...OPTIONS, parts: [wingA, wingB] });
    this.shipPivot = { ...this.ship.position };
    Body.setAngle(this.ship, -Math.PI / 2);
    Body.setPosition(this.ship, { x: -405, y: -25 });
    Composite.add(this.engine.world, this.ship);
  }
  createRock(shape, origin, angle = 0, parent = null, detached = false, geometry = prepareRock(shape, detached)) {
    const { properties, triangles, materialBounds } = geometry;
    const parts = geometry.parts.map(({ polygon, center }) =>
      Body.create({ ...OPTIONS, restitution: 0, position: center, vertices: polygon.map(p => ({ ...p })) }));
    const body = Body.create({ ...OPTIONS, restitution: 0, label: 'Rock', parts });
    // Collider clearance must not move the material's center of mass.
    Body.setCentre(body, properties.center);
    // Use the polygon's actual area moment, independent of its triangulation.
    // Otherwise changing the collision decomposition could invent rotation.
    Body.setMass(body, properties.area * OPTIONS.density);
    Body.setInertia(body, properties.inertia * OPTIONS.density);
    const entity = { body, pivot: { ...body.position }, shape, triangles, area: properties.area, detached, materialBounds };
    const rotated = rotate(entity.pivot, angle);
    Body.setAngle(body, angle);
    Body.setPosition(body, { x: origin.x + rotated.x, y: origin.y + rotated.y });
    if (parent) {
      Body.setVelocity(body, velocityAt(parent, body.position));
      Body.setAngularVelocity(body, Body.getAngularVelocity(parent));
    }
    Composite.add(this.engine.world, body);
    this.rocks.push(entity);
    return entity;
  }
  fire() {
    const dir = rotate({ x: 0, y: 1 }, this.ship.angle);
    const nose = rotate(sub({ x: 0, y: 25 }, this.shipPivot), this.ship.angle);
    const position = { x: this.ship.position.x + nose.x, y: this.ship.position.y + nose.y };
    const inherited = velocityAt(this.ship, position);
    this.bullets.push({ position, velocity: { x: dir.x * 850 + inherited.x * 60, y: dir.y * 850 + inherited.y * 60 }, age: 0, state: 'flying' });
    this.shots++;
    // A tiny recoil preserves the ship's frictionless feel.
    impulse(this.ship, position, { x: -dir.x * .12, y: -dir.y * .12 });
  }
  findHit(from, to) {
    let best = null;
    for (const entity of this.rocks) {
      const a = worldToLocal(entity, from), b = worldToLocal(entity, to);
      // Bullets hit the visible material, including the narrow strip outside
      // the inset collider. Compare bounds in the rock's own rotating frame.
      const bounds = entity.materialBounds;
      if (Math.max(a.x, b.x) < bounds.min.x || Math.min(a.x, b.x) > bounds.max.x || Math.max(a.y, b.y) < bounds.min.y || Math.min(a.y, b.y) > bounds.max.y) continue;
      const t = segmentHit(entity.shape, a, b);
      if (t !== Infinity && (!best || t < best.t)) best = { t, entity, local: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } };
    }
    return best;
  }
  startDrill(bullet, hit) {
    bullet.state = 'drilling'; bullet.entity = hit.entity;
    bullet.entry = hit.local; bullet.local = { ...hit.local };
    const materialVelocity = velocityAt(hit.entity.body, localToWorld(hit.entity, hit.local));
    const relativeVelocity = { x: bullet.velocity.x - materialVelocity.x * 60, y: bullet.velocity.y - materialVelocity.y * 60 };
    bullet.direction = rotate(normalize(relativeVelocity), -hit.entity.body.angle);
    const depth = 14 + this.random() * 20;
    bullet.depth = Math.max(0, solidDistance(hit.entity.shape, bullet.entry, bullet.direction, depth) - .0001);
    bullet.traveled = 0;
    bullet.position = localToWorld(hit.entity, bullet.local);
    this.planFracture(bullet);
  }
  planFracture(bullet) {
    if (!this.fracturePlanner) return;
    const remaining = Math.max(0, bullet.depth - bullet.traveled);
    const center = { x: bullet.local.x + bullet.direction.x * remaining, y: bullet.local.y + bullet.direction.y * remaining };
    const plan = { entity: bullet.entity, center, result: null, error: null };
    bullet.plan = plan;
    const request = { shape: bullet.entity.shape, entry: bullet.entry, center, direction: bullet.direction, detached: bullet.entity.detached, seed: Math.floor(this.random() * 4294967296) };
    // Only publish readiness here. Bodies are replaced inside a fixed physics
    // step, using the parent's current pose rather than its pose when work began.
    Promise.resolve(this.fracturePlanner(request)).then(result => {
      if (!this.disposed && bullet.plan === plan) plan.result = result;
    }, error => {
      if (!this.disposed && bullet.plan === plan) plan.error = error;
    });
  }
  explode(bullet) {
    const entity = bullet.entity;
    if (!this.rocks.includes(entity)) { bullet.state = 'spent'; return; }
    let fracture;
    if (this.fracturePlanner) {
      if (!bullet.plan || bullet.plan.entity !== entity || Math.hypot(bullet.plan.center.x - bullet.local.x, bullet.plan.center.y - bullet.local.y) > 1e-5) this.planFracture(bullet);
      if (bullet.plan.error) throw bullet.plan.error;
      if (!bullet.plan.result) return;
      fracture = bullet.plan.result;
    } else {
      fracture = prepareFracture({ shape: entity.shape, entry: bullet.entry, center: bullet.local, direction: bullet.direction, detached: entity.detached }, this.random);
    }
    const center = localToWorld(entity, bullet.local);
    if (fracture.mode === 'none') {
      this.explosions++;
      this.lastBlast = { center, count: 0, depth: bullet.traveled, mode: 'none' };
      bullet.state = 'spent';
      return;
    }
    const origin = localToWorld(entity, { x: 0, y: 0 }), angle = entity.body.angle;
    const wasMain = entity === this.asteroid;
    Composite.remove(this.engine.world, entity.body);
    this.rocks.splice(this.rocks.indexOf(entity), 1);
    const remainders = fracture.retained.map(({ shape, geometry }, i) => this.createRock(shape, origin, angle, entity.body, entity.detached || i > 0, geometry));
    const fragments = fracture.fragments.map(({ shape, geometry }) => this.createRock(shape, origin, angle, entity.body, true, geometry));
    if (wasMain) this.asteroid = remainders[0] || [...fragments].sort((a, b) => b.area - a.area)[0];
    const released = [...remainders.slice(1), ...fragments];
    this.releaseContacts.replace(entity, [...remainders, ...fragments], released);
    const outward = rotate({ x: -bullet.direction.x, y: -bullet.direction.y }, angle);
    const offsets = released.map(fragment => sub(fragment.body.position, center));
    const expansion = 3 / Math.max(1, ...offsets.map(offset => Math.hypot(offset.x, offset.y)));
    const outwardSpeed = 13 + this.random();
    let reaction = { x: 0, y: 0 }, torque = 0;
    for (const [i, fragment] of released.entries()) {
      // A surface chip exits through its opening. A complete split has no
      // retained cavity, so its pieces scatter around the original center of mass.
      // A common outward drift plus position-proportional spread keeps nearby
      // pieces from receiving crossing trajectories or nearly identical kicks.
      let launch;
      if (remainders.length) launch = {
        x: outward.x * outwardSpeed + offsets[i].x * expansion,
        y: outward.y * outwardSpeed + offsets[i].y * expansion
      };
      else {
        const direction = normalize(sub(fragment.body.position, entity.body.position));
        const speed = 10 + this.random() * 8;
        launch = { x: direction.x * speed, y: direction.y * speed };
      }
      const kick = { x: launch.x * fragment.body.mass / 60, y: launch.y * fragment.body.mass / 60 };
      // Apply the impulse at the center of mass, preserving inherited spin;
      // off-center collisions create the fragment's new rotation.
      const point = fragment.body.position;
      impulse(fragment.body, point, kick);
      reaction.x -= kick.x; reaction.y -= kick.y;
      torque -= cross(sub(point, remainders[0]?.body.position || entity.body.position), kick);
    }
    if (remainders[0]) {
      const body = remainders[0].body, velocity = Body.getVelocity(body);
      Body.setVelocity(body, { x: velocity.x + reaction.x / body.mass, y: velocity.y + reaction.y / body.mass });
      Body.setAngularVelocity(body, Body.getAngularVelocity(body) + torque / body.inertia);
    } else {
      // On the final fracture there is no retained body to absorb recoil.
      // Remove the shared translation/spin from the fragments as a group.
      const mass = fragments.reduce((sum, f) => sum + f.body.mass, 0);
      const inertia = fragments.reduce((sum, f) => {
        const offset = sub(f.body.position, entity.body.position);
        return sum + f.body.inertia + f.body.mass * (offset.x ** 2 + offset.y ** 2);
      }, 0);
      const spin = torque / inertia;
      for (const { body } of fragments) {
        const v = Body.getVelocity(body), offset = sub(body.position, entity.body.position);
        Body.setVelocity(body, { x: v.x + reaction.x / mass - spin * offset.y, y: v.y + reaction.y / mass + spin * offset.x });
        Body.setAngularVelocity(body, Body.getAngularVelocity(body) + spin);
      }
    }
    // Other rounds already drilling this body must follow its replacement
    // rather than retain a stale reference after the fracture.
    for (const other of this.bullets) {
      if (other !== bullet && other.state === 'drilling' && other.entity === entity) {
        const replacement = [...remainders, ...fragments].find(r => contains(r.shape, other.local));
        if (replacement) {
          other.entity = replacement;
          const remaining = Math.max(0, other.depth - other.traveled);
          other.depth = other.traveled + Math.max(0, solidDistance(replacement.shape, other.local, other.direction, remaining) - .0001);
          this.planFracture(other);
        }
        else other.state = 'spent';
      }
    }
    this.explosions++;
    this.lastBlast = { center, count: fragments.length + Math.max(0, remainders.length - 1), depth: bullet.traveled, mode: fracture.mode };
    bullet.state = 'spent';
  }
  step(keys = new Set()) {
    const turn = Number(keys.has('KeyA')) - Number(keys.has('KeyS') || keys.has('KeyD'));
    // Detect contact before appreciable overlap develops. Resolving a deep
    // overlap moves a body without changing its velocity, creating a visible jump.
    for (let i = 0; i < COLLISION_SUBSTEPS; i++) {
      if (keys.has('KeyW')) {
        const direction = rotate({ x: 0, y: 1 }, this.ship.angle);
        Body.applyForce(this.ship, this.ship.position, { x: direction.x * this.ship.mass * .00016, y: direction.y * this.ship.mass * .00016 });
      }
      // Matter clears forces after every substep; sustained controls must be
      // reapplied to preserve acceleration over the full simulation update.
      this.ship.torque += turn * this.ship.inertia * .0000018;
      Engine.update(this.engine, STEP / COLLISION_SUBSTEPS);
    }
    const dt = STEP / 1000;
    for (const bullet of this.bullets) {
      bullet.age += dt;
      if (bullet.state === 'flying') {
        const to = { x: bullet.position.x + bullet.velocity.x * dt, y: bullet.position.y + bullet.velocity.y * dt };
        const hit = this.findHit(bullet.position, to);
        if (hit) this.startDrill(bullet, hit);
        else bullet.position = to;
        if (bullet.age > 5) bullet.state = 'spent';
      } else if (bullet.state === 'drilling') {
        // Stop at the first void or at the short depth cap. A round cannot
        // tunnel across a cavity and detonate on the far side of the asteroid.
        const requested = Math.min(80 * dt, bullet.depth - bullet.traveled);
        const distance = solidDistance(bullet.entity.shape, bullet.local, bullet.direction, requested);
        const step = distance < requested - 1e-6 ? Math.max(0, distance - .0001) : requested;
        const next = { x: bullet.local.x + bullet.direction.x * step, y: bullet.local.y + bullet.direction.y * step };
        if (contains(bullet.entity.shape, next)) {
          bullet.local = next; bullet.traveled += step;
        } else bullet.depth = bullet.traveled;
        if (step < requested) bullet.depth = bullet.traveled;
        bullet.position = localToWorld(bullet.entity, bullet.local);
        if (bullet.traveled >= bullet.depth - 1e-6) this.explode(bullet);
      }
    }
    this.bullets = this.bullets.filter(b => b.state !== 'spent');
  }
  get retainedArea() { return this.asteroid.area; }
  dispose() { this.disposed = true; this.releaseContacts.dispose(); Composite.clear(this.engine.world, false); Engine.clear(this.engine); }
}
