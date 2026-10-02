import { rotate, sub, cross, normalize, contains, segmentHit, chooseBlastCells, connectedComponents } from './fracture.js';
const { Engine, Body, Composite } = globalThis.Matter;
export const STEP = 1000 / 120;
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
  return { x: body.velocity.x - body.angularVelocity * r.y, y: body.velocity.y + body.angularVelocity * r.x };
}
function impulse(body, point, kick) {
  const velocity = Body.getVelocity(body);
  Body.setVelocity(body, { x: velocity.x + kick.x / body.mass, y: velocity.y + kick.y / body.mass });
  Body.setAngularVelocity(body, Body.getAngularVelocity(body) + cross(sub(point, body.position), kick) / body.inertia);
}
export class Simulation {
  constructor(asteroid, random = Math.random) {
    this.random = random;
    this.engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 }, positionIterations: 8, velocityIterations: 8 });
    this.rocks = [];
    this.asteroid = this.createRock(asteroid.cells, { x: 180, y: 0 });
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
  createRock(cells, origin, angle = 0, parent = null) {
    const parts = cells.map(cell => Body.create({ ...OPTIONS, position: { ...cell.center }, vertices: cell.poly.map(p => ({ ...p })) }));
    const body = Body.create({ ...OPTIONS, parts });
    // Matter sums the parts' individual inertias. Include the distance from
    // each part to the aggregate center so a large rock resists spinning.
    Body.setInertia(body, parts.reduce((sum, part) => sum + part.inertia + part.mass * ((part.position.x - body.position.x) ** 2 + (part.position.y - body.position.y) ** 2), 0));
    const entity = { body, pivot: { ...body.position }, cells };
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
      const bounds = entity.body.bounds;
      if (Math.max(from.x, to.x) < bounds.min.x || Math.min(from.x, to.x) > bounds.max.x || Math.max(from.y, to.y) < bounds.min.y || Math.min(from.y, to.y) > bounds.max.y) continue;
      for (const cell of entity.cells) {
        const t = segmentHit(cell.poly, a, b);
        if (t !== Infinity && (!best || t < best.t)) best = { t, entity, cell, local: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } };
      }
    }
    return best;
  }
  startDrill(bullet, hit) {
    bullet.state = 'drilling'; bullet.entity = hit.entity; bullet.hitId = hit.cell.id;
    bullet.entry = hit.local; bullet.local = { ...hit.local };
    bullet.direction = rotate(normalize(bullet.velocity), -hit.entity.body.angle);
    bullet.depth = 14 + this.random() * 20; bullet.traveled = 0;
    bullet.position = localToWorld(hit.entity, bullet.local);
  }
  explode(bullet) {
    const entity = bullet.entity;
    if (!this.rocks.includes(entity)) { bullet.state = 'spent'; return; }
    const removed = chooseBlastCells(entity.cells, bullet.entry, bullet.local, bullet.hitId, this.random);
    const ids = new Set(removed.map(c => c.id));
    const remaining = entity.cells.filter(c => !ids.has(c.id));
    const origin = localToWorld(entity, { x: 0, y: 0 }), angle = entity.body.angle;
    const wasMain = entity === this.asteroid;
    Composite.remove(this.engine.world, entity.body);
    this.rocks.splice(this.rocks.indexOf(entity), 1);
    const groups = connectedComponents(remaining);
    const remainders = groups.map(cells => this.createRock(cells, origin, angle, entity.body));
    if (wasMain) this.asteroid = remainders[0] || null;
    const center = localToWorld(entity, bullet.local), outward = rotate(normalize(sub(bullet.entry, bullet.local)), angle);
    const fragments = removed.map(cell => this.createRock([cell], origin, angle, entity.body));
    let reaction = { x: 0, y: 0 }, torque = 0;
    for (const fragment of fragments) {
      const radial = normalize(sub(fragment.body.position, center));
      const direction = normalize({ x: radial.x + outward.x * .8, y: radial.y + outward.y * .8 });
      const speed = .38 + this.random() * .65;
      const kick = { x: direction.x * speed * fragment.body.mass, y: direction.y * speed * fragment.body.mass };
      // Off-center impulses give natural spin. The retained rock receives
      // equal and opposite linear and angular momentum from these kicks.
      const point = { x: fragment.body.position.x + (this.random() - .5) * 12, y: fragment.body.position.y + (this.random() - .5) * 12 };
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
        const replacement = [...remainders, ...fragments].find(r => r.cells.some(c => contains(c.poly, other.local)));
        if (replacement) other.entity = replacement;
        else other.state = 'spent';
      }
    }
    this.explosions++;
    this.lastBlast = { center, count: fragments.length + Math.max(0, remainders.length - 1), depth: bullet.traveled };
    bullet.state = 'spent';
  }
  step(keys = new Set()) {
    if (keys.has('KeyW')) {
      const direction = rotate({ x: 0, y: 1 }, this.ship.angle);
      Body.applyForce(this.ship, this.ship.position, { x: direction.x * this.ship.mass * .00016, y: direction.y * this.ship.mass * .00016 });
    }
    const turn = Number(keys.has('KeyA')) - Number(keys.has('KeyS') || keys.has('KeyD'));
    this.ship.torque += turn * this.ship.inertia * .0000018;
    Engine.update(this.engine, STEP);
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
        const step = Math.min(80 * dt, bullet.depth - bullet.traveled);
        const next = { x: bullet.local.x + bullet.direction.x * step, y: bullet.local.y + bullet.direction.y * step };
        if (bullet.entity.cells.some(cell => contains(cell.poly, next))) {
          bullet.local = next; bullet.traveled += step;
        } else bullet.depth = bullet.traveled;
        bullet.position = localToWorld(bullet.entity, bullet.local);
        if (bullet.traveled >= bullet.depth - 1e-6) this.explode(bullet);
      }
    }
    this.bullets = this.bullets.filter(b => b.state !== 'spent');
  }
  get retainedArea() { return this.asteroid ? this.asteroid.cells.reduce((s, c) => s + c.area, 0) : 0; }
  dispose() { Composite.clear(this.engine.world, false); Engine.clear(this.engine); }
}
