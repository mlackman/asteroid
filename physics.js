import { rotate, sub, cross, normalize, contains, segmentHit, solidDistance, confinement } from './fracture.js?v=20261004';
import { prepareRock, prepareFracture } from './rock-geometry.js?v=20261004';
import { outline, pointClearance } from './clearance.js?v=20261004';
import { oreArea, oreDistance } from './ore.js?v=20261004';
import { SHIP, POLES } from './config.js?v=20261004';
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
    this.pendingSpins = [];
    Events.on(this.engine, 'collisionStart', event => reboundRockContacts(event.pairs));
    this.rocks = [];
    this.originalShape = asteroid.shape;
    this.asteroid = this.createRock(asteroid.shape, { x: 180, y: 0 }, 0, null, false, null, asteroid.ores || []);
    this.totalArea = asteroid.area;
    this.shots = 0;
    this.explosions = 0;
    this.bullets = [];
    this.lastBlast = null;
    const wingA = Body.create({ ...OPTIONS, density: .004, position: { x: -13 / 3, y: -1 / 3 }, vertices: [{ x: -13, y: -15 }, { x: 0, y: 20 }, { x: 0, y: -6 }] });
    const wingB = Body.create({ ...OPTIONS, density: .004, position: { x: 13 / 3, y: -1 / 3 }, vertices: [{ x: 0, y: 20 }, { x: 13, y: -15 }, { x: 0, y: -6 }] });
    this.ship = Body.create({ ...OPTIONS, parts: [wingA, wingB] });
    this.shipPivot = { ...this.ship.position };
    // Thrust and turning are sized for the empty ship; a held load adds mass
    // and inertia, and thrust pushes from the engine rather than the shared
    // center of mass, so an uneven load turns the ship.
    this.shipBase = { mass: this.ship.mass, inertia: this.ship.inertia, pivot: { ...this.shipPivot }, parts: this.ship.parts.slice(1) };
    this.poles = [-1, 1].map(side => ({ side, extension: 0, target: 0, held: null }));
    this.grabs = 0;
    Body.setAngle(this.ship, -Math.PI / 2);
    Body.setPosition(this.ship, { x: -405, y: -25 });
    Composite.add(this.engine.world, this.ship);
  }
  createRock(shape, origin, angle = 0, parent = null, detached = false, geometry = null, ores = []) {
    geometry ??= prepareRock(shape, detached, ores);
    const { properties, triangles, materialBounds } = geometry;
    const parts = geometry.parts.map(({ polygon, center }) =>
      Body.create({ ...OPTIONS, restitution: 0, position: center, vertices: polygon.map(p => ({ ...p })) }));
    const body = Body.create({ ...OPTIONS, restitution: 0, label: 'Rock', parts });
    // Collider clearance must not move the material's center of mass.
    Body.setCentre(body, properties.center);
    // Use the polygon's actual area moment, independent of its triangulation.
    // Otherwise changing the collision decomposition could invent rotation.
    Body.setMass(body, (properties.massArea ?? properties.area) * OPTIONS.density);
    Body.setInertia(body, properties.inertia * OPTIONS.density);
    // Ore is part of the rock's shape; `ores` lists the nuggets inside it.
    const pivot = { ...body.position }, radius = Math.max(...shape[0].map(p => Math.hypot(p.x - pivot.x, p.y - pivot.y)));
    const entity = { body, pivot, radius, shape, triangles, area: properties.area, detached, materialBounds, ores, oreArea: oreArea(ores), held: null };
    entity.rockArea = Math.max(0, entity.area - entity.oreArea);
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
    // Rock at the bottom of a pit has been crushed by earlier blasts and stops
    // a round sooner, so repeated shots into one spot deepen it slowly.
    bullet.enclosed = confinement(hit.entity.shape, bullet.entry, { x: -bullet.direction.x, y: -bullet.direction.y });
    const depth = (14 + this.random() * 20) * (1 - bullet.enclosed) ** 2;
    bullet.traveled = 0;
    this.limitDrill(bullet, hit.entity, bullet.entry, depth);
    bullet.position = localToWorld(hit.entity, bullet.local);
    this.planFracture(bullet);
  }
  // A round that would come out the far side passes through: it drills to
  // the exit, leaves, and detonates just outside, cracking the rock along
  // its tunnel. Otherwise it stops at its depth, at the first cavity, or at
  // the first ore, which it cannot cut.
  limitDrill(bullet, entity, from, remaining) {
    const thickness = solidDistance(entity.shape, from, bullet.direction, remaining + 1);
    const ore = oreDistance(entity.ores, from, bullet.direction, remaining + 1);
    bullet.struckOre = ore <= Math.min(remaining, thickness);
    bullet.through = !bullet.struckOre && thickness <= remaining;
    bullet.depth = bullet.traveled + Math.max(0, Math.min(remaining, thickness, ore) - .0001);
  }
  planFracture(bullet) {
    if (!this.fracturePlanner) return;
    const remaining = Math.max(0, bullet.depth - bullet.traveled);
    const center = { x: bullet.local.x + bullet.direction.x * remaining, y: bullet.local.y + bullet.direction.y * remaining };
    const plan = { entity: bullet.entity, center, result: null, error: null };
    bullet.plan = plan;
    const request = { shape: bullet.entity.shape, ores: bullet.entity.ores, entry: bullet.entry, center, direction: bullet.direction, detached: bullet.entity.detached, through: bullet.through, enclosed: bullet.enclosed, seed: Math.floor(this.random() * 4294967296) };
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
      fracture = prepareFracture({ shape: entity.shape, ores: entity.ores, entry: bullet.entry, center: bullet.local, direction: bullet.direction, detached: entity.detached, through: bullet.through, enclosed: bullet.enclosed }, this.random);
    }
    // A held piece leaves the pole before it breaks.
    if (entity.held && fracture.mode !== 'none') this.release(entity);
    const center = localToWorld(entity, bullet.local);
    if (fracture.mode === 'none') {
      this.explosions++;
      this.lastBlast = { center: bullet.through ? { ...bullet.position } : center, count: 0, depth: bullet.traveled, mode: 'none', revealed: 0 };
      bullet.state = 'spent';
      if (bullet.through) this.pushOutside(bullet.position);
      // A round that strikes ore at the surface blows against it in the open.
      else if (bullet.struckOre) this.pushOutside(center);
      return;
    }
    const origin = localToWorld(entity, { x: 0, y: 0 }), angle = entity.body.angle;
    const wasMain = entity === this.asteroid;
    Composite.remove(this.engine.world, entity.body);
    this.rocks.splice(this.rocks.indexOf(entity), 1);
    const remainders = fracture.retained.map(({ shape, geometry, ores }, i) => this.createRock(shape, origin, angle, entity.body, entity.detached || i > 0, geometry, ores || []));
    const fragments = fracture.fragments.map(({ shape, geometry, ores }) => this.createRock(shape, origin, angle, entity.body, true, geometry, ores || []));
    const wasRevealed = entity.ores.filter(ore => ore.revealed).length;
    const revealed = [...remainders, ...fragments].reduce((sum, rock) => sum + rock.ores.filter(ore => ore.revealed).length, 0) - wasRevealed;
    if (wasMain) this.asteroid = remainders[0] || [...fragments].sort((a, b) => b.area - a.area)[0];
    const released = [...remainders.slice(1), ...fragments], parent = remainders[0] || null;
    // Chips leave through the crater's mouth. The planner faces the crater
    // along the surface normal, so angled hits throw debris away from the
    // surface rather than back along the bullet.
    const pocket = fracture.axis || bullet.direction;
    const axis = rotate({ x: -pocket.x, y: -pocket.y }, angle);
    // Crater chips share one drift plus an expansion proportional to their
    // offset from the blast, so pieces fan out yet every pair moves apart.
    // The bowl's walls slope outward, so the fan can open as wide across the
    // crater as along it.
    const side = { x: -axis.y, y: axis.x };
    const chips = fracture.mode === 'chip' ? fragments : [];
    const offsets = chips.map(fragment => sub(fragment.body.position, center));
    const drift = 12 + this.random() * 2, maxOffset = Math.max(1, ...offsets.map(offset => Math.hypot(offset.x, offset.y)));
    const along = (5 + this.random() * 2) / maxOffset, across = (5 + this.random() * 2) / maxOffset;
    const launches = released.map(fragment => {
      const i = chips.indexOf(fragment);
      if (i >= 0) {
        // The planner scales back the sideways fan for a chip whose far end
        // would otherwise swing into the crater rim on its way out.
        const a = (offsets[i].x * axis.x + offsets[i].y * axis.y) * along, c = (offsets[i].x * side.x + offsets[i].y * side.y) * across * (fracture.spread?.[i] ?? 1);
        return { x: (axis.x * (drift + a) + side.x * c) / 60, y: (axis.y * (drift + a) + side.y * c) / 60 };
      }
      // Pieces broken off by a wall crack, a shatter, or a tunnel split are
      // pushed away from the blast. Wall pieces sit behind the crater and get
      // a gentler push than the chips.
      // A wall piece that would hit the rock around it moving that way leaves
      // straight out along the crater's axis instead.
      const radial = fracture.radial?.[remainders.indexOf(fragment)] ?? true;
      const direction = radial ? normalize(sub(fragment.body.position, center)) : axis;
      const speed = fracture.mode === 'chip' ? 4 + this.random() * 4 : 10 + this.random() * 8;
      return { x: direction.x * speed / 60, y: direction.y * speed / 60 };
    });
    this.separateLaunches([...remainders, ...fragments], released, launches, fracture.contacts || [], origin, angle, fracture.mode === 'chip' ? axis : null);
    let reaction = { x: 0, y: 0 }, torque = 0;
    for (const [i, fragment] of released.entries()) {
      // Kicks act at the center of mass. A spin now would swing a piece's
      // corners into the neighbors it is still touching, so its tumble waits
      // until it has cleared them (see applyPendingSpins).
      const kick = { x: launches[i].x * fragment.body.mass, y: launches[i].y * fragment.body.mass };
      impulse(fragment.body, fragment.body.position, kick);
      reaction.x -= kick.x; reaction.y -= kick.y;
      torque -= cross(sub(fragment.body.position, parent?.body.position || entity.body.position), kick);
      const speed = Math.hypot(launches[i].x, launches[i].y) * 60;
      this.pendingSpins.push({
        entity: fragment, source: parent, cohort: [...remainders, ...fragments].filter(other => other !== fragment),
        momentum: (this.random() * 2 - 1) * .15 * Math.sqrt(fragment.area) * fragment.body.mass * speed / 60
      });
    }
    if (parent) {
      const body = parent.body, velocity = Body.getVelocity(body);
      Body.setVelocity(body, { x: velocity.x + reaction.x / body.mass, y: velocity.y + reaction.y / body.mass });
      Body.setAngularVelocity(body, Body.getAngularVelocity(body) + torque / body.inertia);
    } else {
      // On the final fracture there is no retained body to absorb recoil.
      // Remove the shared translation/spin from the fragments as a group.
      // This is a rigid motion of the whole group, so separation is unchanged.
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
          this.limitDrill(other, replacement, other.local, Math.max(0, other.depth - other.traveled));
          this.planFracture(other);
        }
        else other.state = 'spent';
      }
    }
    this.explosions++;
    this.lastBlast = { center: bullet.through ? { ...bullet.position } : center, count: fragments.length + Math.max(0, remainders.length - 1), depth: bullet.traveled, mode: fracture.mode, exit: fracture.mode === 'chip' ? axis : null, revealed };
    bullet.state = 'spent';
    if (bullet.through) this.pushOutside(bullet.position, [...remainders, ...fragments]);
  }
  // A round that detonates outside any rock pushes the rocks around it,
  // weakening with distance and with the rock's size. The rock it passed
  // through has already been cracked and launched by the same blast.
  pushOutside(point, launched = []) {
    const radius = 60;
    for (const rock of this.rocks) {
      if (launched.includes(rock) || rock.held) continue;
      const distance = pointClearance(point, outline(rock, localToWorld), contains);
      if (distance >= radius) continue;
      const direction = normalize(sub(rock.body.position, point));
      const speed = 8 * (1 - distance / radius) * Math.min(1, 1500 / rock.area) / 60;
      const v = Body.getVelocity(rock.body);
      Body.setVelocity(rock.body, { x: v.x + direction.x * speed, y: v.y + direction.y * speed });
    }
  }
  // Adjust launch velocities so every crack the blast opened is separating.
  // Pieces start exactly touching their neighbors along shared edges; if each
  // edge opens at a minimum rate, no piece can pass into another or into the
  // parent. Collisions stay enabled throughout. The parent's recoil and spin
  // follow from momentum conservation and are included in the check.
  separateLaunches(bodies, released, launches, contacts, origin, angle, exit = null) {
    const parent = bodies.find(body => !released.includes(body)) || null;
    const index = new Map(released.map((entity, i) => [entity, i]));
    const toWorld = p => { const q = rotate(p, angle); return { x: origin.x + q.x, y: origin.y + q.y }; };
    const constraints = contacts.map(({ a, b, normal, point }) => ({ a: bodies[a], b: bodies[b], normal: rotate(normal, angle), point: toWorld(point) }));
    const minimum = 1 / 60;
    const parentMotion = () => {
      if (!parent) return { u: { x: 0, y: 0 }, w: 0 };
      let px = 0, py = 0, l = 0;
      for (const [i, entity] of released.entries()) {
        const m = entity.body.mass;
        px += m * launches[i].x; py += m * launches[i].y;
        l += m * cross(sub(entity.body.position, parent.body.position), launches[i]);
      }
      return { u: { x: -px / parent.body.mass, y: -py / parent.body.mass }, w: -l / parent.body.inertia };
    };
    const velocity = (entity, point, motion) => {
      if (entity !== parent) return launches[index.get(entity)];
      const r = sub(point, parent.body.position);
      return { x: motion.u.x - motion.w * r.y, y: motion.u.y + motion.w * r.x };
    };
    for (let iteration = 0; iteration < 200; iteration++) {
      let worst = 0;
      for (const { a, b, normal, point } of constraints) {
        const motion = parentMotion(), va = velocity(a, point, motion), vb = velocity(b, point, motion);
        // A crater wall running along the exit direction can only slide past
        // the piece beside it; it must not close, but it cannot open. Walls
        // facing out of the crater open at the full rate.
        const facing = exit && (a === parent || b === parent) ? Math.max(0, (normal.x * exit.x + normal.y * exit.y) * (b === parent ? 1 : -1)) : 1;
        const gap = minimum * Math.min(1, facing * 4) - ((va.x - vb.x) * normal.x + (va.y - vb.y) * normal.y);
        if (gap <= 0) continue;
        worst = Math.max(worst, gap);
        // Equal and opposite impulses between two pieces; against the parent,
        // only the piece moves here and the parent's recoil follows from it.
        const ma = a === parent ? Infinity : a.body.mass, mb = b === parent ? Infinity : b.body.mass;
        const lambda = gap / (1 / ma + 1 / mb) * 1.05;
        if (a !== parent) { const v = launches[index.get(a)]; v.x += normal.x * lambda / ma; v.y += normal.y * lambda / ma; }
        if (b !== parent) { const v = launches[index.get(b)]; v.x -= normal.x * lambda / mb; v.y -= normal.y * lambda / mb; }
      }
      if (worst < 1e-9) break;
    }
  }
  // A piece's tumble starts once every body from its blast is outside the
  // circle its corners sweep while spinning, so the spin cannot swing it into
  // them. The opposite angular impulse goes to the parent, or to a remaining
  // sibling after a complete split, so angular momentum is conserved.
  applyPendingSpins() {
    const outlines = new Map(), material = entity => {
      if (!outlines.has(entity)) outlines.set(entity, outline(entity, localToWorld));
      return outlines.get(entity);
    };
    this.pendingSpins = this.pendingSpins.filter(pending => {
      const { entity, source, momentum } = pending;
      // A piece grabbed before its tumble starts keeps the ship's spin.
      if (!this.rocks.includes(entity) || entity.held) return false;
      const neighbors = pending.cohort.filter(other => this.rocks.includes(other) && !other.held);
      const center = entity.body.position;
      const reach = Math.max(...entity.shape.flat().map(p => { const q = localToWorld(entity, p); return Math.hypot(q.x - center.x, q.y - center.y); }));
      if (!neighbors.every(other => pointClearance(center, material(other), contains) > reach + .5)) return true;
      const partner = source && this.rocks.includes(source) && !source.held ? source : [...neighbors].sort((x, y) => y.body.mass - x.body.mass)[0];
      if (!partner) return false;
      Body.setAngularVelocity(entity.body, Body.getAngularVelocity(entity.body) + momentum / entity.body.inertia);
      Body.setAngularVelocity(partner.body, Body.getAngularVelocity(partner.body) - momentum / partner.body.inertia);
      return false;
    });
  }
  step(keys = new Set()) {
    const turn = Number(keys.has('KeyA')) - Number(keys.has('KeyS') || keys.has('KeyD'));
    // Detect contact before appreciable overlap develops. Resolving a deep
    // overlap moves a body without changing its velocity, creating a visible jump.
    const { mass, inertia, pivot } = this.shipBase;
    // Reaction wheels make up part of a load's extra inertia (SHIP.loadTurnShare).
    const turning = inertia + SHIP.loadTurnShare * (this.ship.inertia - inertia);
    for (let i = 0; i < COLLISION_SUBSTEPS; i++) {
      if (keys.has('KeyW')) {
        const direction = rotate({ x: 0, y: 1 }, this.ship.angle);
        Body.applyForce(this.ship, this.shipToWorld(pivot), { x: direction.x * mass * .00016, y: direction.y * mass * .00016 });
      }
      // Matter clears forces after every substep; sustained controls must be
      // reapplied to preserve acceleration over the full simulation update.
      this.ship.torque += turn * turning * .0000018;
      Engine.update(this.engine, STEP / COLLISION_SUBSTEPS);
    }
    this.syncHeld();
    if (this.pendingSpins.length) this.applyPendingSpins();
    const dt = STEP / 1000;
    this.updatePoles(dt);
    for (const bullet of this.bullets) {
      bullet.age += dt;
      if (bullet.state === 'flying') {
        const to = { x: bullet.position.x + bullet.velocity.x * dt, y: bullet.position.y + bullet.velocity.y * dt };
        const hit = this.findHit(bullet.position, to);
        if (hit) this.startDrill(bullet, hit);
        else bullet.position = to;
        if (bullet.age > 5) bullet.state = 'spent';
      } else if (bullet.state === 'exited') {
        // Out the far side on a short fuse. Another rock in the way takes the
        // round instead; otherwise it detonates in open space.
        bullet.fuse -= dt;
        if (bullet.fuse > 0) {
          const to = { x: bullet.position.x + bullet.velocity.x * dt, y: bullet.position.y + bullet.velocity.y * dt };
          const hit = this.findHit(bullet.position, to);
          if (hit && hit.entity !== bullet.entity) { bullet.through = false; this.startDrill(bullet, hit); }
          else bullet.position = to;
        } else if (this.rocks.includes(bullet.entity)) this.explode(bullet);
        else {
          this.explosions++;
          this.lastBlast = { center: { ...bullet.position }, count: 0, depth: bullet.traveled, mode: 'none' };
          this.pushOutside(bullet.position);
          bullet.state = 'spent';
        }
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
        if (bullet.traveled >= bullet.depth - 1e-6) {
          if (bullet.through) {
            const exit = rotate(bullet.direction, bullet.entity.body.angle);
            bullet.state = 'exited';
            bullet.velocity = { x: bullet.velocity.x * .5, y: bullet.velocity.y * .5 };
            bullet.position = { x: bullet.position.x + exit.x * .05, y: bullet.position.y + exit.y * .05 };
            bullet.fuse = 8 / Math.hypot(bullet.velocity.x, bullet.velocity.y);
          } else this.explode(bullet);
        }
      }
    }
    this.bullets = this.bullets.filter(b => b.state !== 'spent');
  }
  // Ship coordinates (bow is +y) to world and back.
  shipToWorld(p) {
    const q = rotate(sub(p, this.shipPivot), this.ship.angle);
    return { x: this.ship.position.x + q.x, y: this.ship.position.y + q.y };
  }
  shipToLocal(p) {
    const q = rotate(sub(p, this.ship.position), -this.ship.angle);
    return { x: q.x + this.shipPivot.x, y: q.y + this.shipPivot.y };
  }
  poleTip(pole, extension = pole.extension) {
    const angle = POLES.angle * Math.PI / 180, reach = POLES.length * extension;
    return { x: pole.side * (POLES.mountX + Math.sin(angle) * reach), y: POLES.mountY + Math.cos(angle) * reach };
  }
  get polesOut() { return this.poles.some(pole => pole.target === 1); }
  get held() { return this.poles.filter(pole => pole.held).map(pole => pole.held); }
  extendPoles() { for (const pole of this.poles) pole.target = 1; }
  // A pole holding a piece stays out.
  retractPoles() { for (const pole of this.poles) if (!pole.held) pole.target = 0; }
  releaseAll() { for (const rock of this.held) this.release(rock); }
  updatePoles(dt) {
    for (const pole of this.poles) {
      const change = dt / POLES.extendTime;
      pole.extension = pole.target ? Math.min(1, pole.extension + change) : Math.max(0, pole.extension - change);
      if (pole.target && pole.extension === 1 && !pole.held) {
        const rock = this.grabbable(pole);
        if (rock) this.grab(pole, rock);
      }
    }
  }
  // The nearest free piece the tip touches, light enough and nearly at rest relative to the tip.
  grabbable(pole) {
    const tip = this.shipToWorld(this.poleTip(pole)), tipVelocity = velocityAt(this.ship, tip);
    let best = null, bestDistance = Infinity;
    for (const rock of this.rocks) {
      if (rock.held || rock.area > POLES.maxArea) continue;
      if (Math.hypot(rock.body.position.x - tip.x, rock.body.position.y - tip.y) > rock.radius + POLES.grabReach) continue;
      const v = velocityAt(rock.body, tip);
      if (Math.hypot(v.x - tipVelocity.x, v.y - tipVelocity.y) * 60 > POLES.maxGrabSpeed) continue;
      const distance = pointClearance(tip, outline(rock, localToWorld), contains);
      if (distance <= POLES.grabReach && distance < bestDistance) { best = rock; bestDistance = distance; }
    }
    return best;
  }
  // Mass properties of the ship with everything it holds, in world space.
  shipProperties() {
    const parts = [{ mass: this.shipBase.mass, inertia: this.shipBase.inertia, center: this.shipToWorld(this.shipBase.pivot) },
      ...this.held.map(rock => ({ mass: rock.body.mass, inertia: rock.body.inertia, center: { ...rock.body.position } }))];
    const mass = parts.reduce((sum, p) => sum + p.mass, 0);
    const center = { x: parts.reduce((sum, p) => sum + p.mass * p.center.x, 0) / mass, y: parts.reduce((sum, p) => sum + p.mass * p.center.y, 0) / mass };
    const inertia = parts.reduce((sum, p) => sum + p.inertia + p.mass * ((p.center.x - center.x) ** 2 + (p.center.y - center.y) ** 2), 0);
    return { mass, center, inertia };
  }
  // Rebuild the ship's compound body from its wings and the collision parts
  // of what it holds. Matter's own compound inertia omits the parallel-axis
  // terms, so mass, center and inertia are set from shipProperties.
  rebuildShip(velocity, spin) {
    const { mass, center, inertia } = this.shipProperties();
    this.shipPivot = this.shipToLocal(center);
    Body.setParts(this.ship, [...this.shipBase.parts, ...this.held.flatMap(rock => rock.held.parts)]);
    Body.setCentre(this.ship, center);
    Body.setMass(this.ship, mass);
    Body.setInertia(this.ship, inertia);
    Body.setVelocity(this.ship, velocity);
    Body.setAngularVelocity(this.ship, spin);
  }
  // The piece joins the ship rigidly. A perfectly inelastic merge: linear and
  // angular momentum are conserved.
  grab(pole, rock) {
    const ship = this.ship, body = rock.body;
    const before = [ship, body].map(b => ({ mass: b.mass, inertia: b.inertia, center: { ...b.position }, velocity: Body.getVelocity(b), spin: Body.getAngularVelocity(b) }));
    pole.held = rock;
    rock.held = {
      pole, local: this.shipToLocal(body.position), angle: body.angle - ship.angle,
      // The ship takes copies of the piece's collision parts; its own body
      // leaves the world and only follows the ship for drawing and aiming.
      parts: body.parts.slice(1).map(part => Body.create({ ...OPTIONS, restitution: 0, label: 'Held rock', position: { ...part.position }, vertices: part.vertices.map(p => ({ x: p.x, y: p.y })) }))
    };
    Composite.remove(this.engine.world, body);
    const { mass, center, inertia } = this.shipProperties();
    const velocity = { x: before.reduce((sum, b) => sum + b.mass * b.velocity.x, 0) / mass, y: before.reduce((sum, b) => sum + b.mass * b.velocity.y, 0) / mass };
    const momentum = before.reduce((sum, b) => sum + b.inertia * b.spin + b.mass * cross(sub(b.center, center), sub(b.velocity, velocity)), 0);
    this.rebuildShip(velocity, momentum / inertia);
    this.pendingSpins = this.pendingSpins.filter(pending => pending.entity !== rock);
    this.grabs++;
    this.lastGrab = rock;
    this.syncHeld();
  }
  // Let go: the piece keeps the ship's motion at its position, so the split is rigid and conserves momentum.
  release(rock) {
    if (!rock.held) return;
    this.syncHeld();
    const velocity = velocityAt(this.ship, rock.body.position), spin = Body.getAngularVelocity(this.ship);
    rock.held.pole.held = null;
    rock.held = null;
    Body.setVelocity(rock.body, velocity);
    Body.setAngularVelocity(rock.body, spin);
    Composite.add(this.engine.world, rock.body);
    const { center } = this.shipProperties();
    this.rebuildShip(velocityAt(this.ship, center), spin);
  }
  // Held pieces' own bodies follow the ship, so drawing, aiming and drilling see them in place.
  syncHeld() {
    const spin = Body.getAngularVelocity(this.ship);
    for (const rock of this.held) {
      const position = this.shipToWorld(rock.held.local);
      Body.setPosition(rock.body, position);
      Body.setAngle(rock.body, this.ship.angle + rock.held.angle);
      Body.setVelocity(rock.body, velocityAt(this.ship, position));
      Body.setAngularVelocity(rock.body, spin);
    }
  }
  removeRock(entity) {
    if (!this.rocks.includes(entity)) return;
    this.release(entity);
    Composite.remove(this.engine.world, entity.body);
    this.rocks.splice(this.rocks.indexOf(entity), 1);
    for (const bullet of this.bullets) if (bullet.entity === entity && bullet.state === 'drilling') bullet.state = 'spent';
    if (this.asteroid === entity) this.asteroid = [...this.rocks].sort((a, b) => b.area - a.area)[0] || null;
  }
  get retainedArea() { return this.asteroid?.area ?? 0; }
  dispose() { this.disposed = true; Composite.clear(this.engine.world, false); Engine.clear(this.engine); }
}
