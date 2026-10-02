import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeAsteroid, polygonArea, connectedComponents, randomGenerator, segmentHit, contains } from '../fracture.js';
const require = createRequire(import.meta.url);
globalThis.Matter = require('../vendor/matter.min.js');
const { Simulation, localToWorld } = await import('../physics.js');
const { Body, Events } = globalThis.Matter;
const asteroid = makeAsteroid();
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const totalRockArea = simulation => simulation.rocks.reduce((s, r) => s + r.cells.reduce((n, c) => n + polygonArea(c.poly), 0), 0);

function runToExplosion(simulation, limit = 500) {
  const before = simulation.explosions;
  for (let i = 0; i < limit && simulation.explosions === before; i++) simulation.step();
  assert.ok(simulation.explosions > before, 'the fired round must drill and explode');
}

test('all interlocking polygons reconstruct the entire asteroid without gaps or overlap', () => {
  near(asteroid.cells.reduce((s, c) => s + c.area, 0), asteroid.area);
  assert.equal(connectedComponents(asteroid.cells).length, 1);
  // Interior samples have exactly one owner, not merely equal summed areas.
  const random = randomGenerator(24);
  for (let i = 0; i < 1000; i++) {
    const p = { x: (random() - .5) * 700, y: (random() - .5) * 600 };
    assert.equal(asteroid.cells.filter(c => contains(c.poly, p)).length, contains(asteroid.outline, p) ? 1 : 0);
  }
});

test('swept hits detect even thin fragments at high bullet speeds', () => {
  const poly = [{ x: 0, y: -1 }, { x: .01, y: -1 }, { x: .01, y: 1 }, { x: 0, y: 1 }];
  near(segmentHit(poly, { x: -500, y: 0 }, { x: 500, y: 0 }), .5);
  assert.equal(segmentHit(poly, { x: -500, y: 3 }, { x: 500, y: 3 }), Infinity);
});

test('ship coasts without drag, rotates by torque, and fires from its V tip', () => {
  const sim = new Simulation(asteroid, randomGenerator(1));
  for (let i = 0; i < 80; i++) sim.step(new Set(['KeyW']));
  const vx = sim.ship.velocity.x, vy = sim.ship.velocity.y, x = sim.ship.position.x;
  assert.ok(vx > 1, 'thrust accelerates along the bow');
  for (let i = 0; i < 30; i++) sim.step();
  near(sim.ship.velocity.x, vx); near(sim.ship.velocity.y, vy);
  assert.ok(sim.ship.position.x > x);
  sim.step(new Set(['KeyA'])); assert.ok(sim.ship.angularVelocity > 0);
  const spin = sim.ship.angularVelocity; sim.step(); near(sim.ship.angularVelocity, spin);
  sim.step(new Set(['KeyS'])); near(sim.ship.angularVelocity, 0);
  sim.fire();
  assert.ok(sim.bullets[0].position.x > sim.ship.position.x + 20);
  assert.ok(sim.bullets[0].velocity.x > 850, 'round inherits ship momentum');
  sim.dispose();
});

test('a shot drills shallowly, removes the actual surface, and preserves every polygon', () => {
  const sim = new Simulation(asteroid, randomGenerator(5));
  const initial = new Map(asteroid.cells.map(c => [c.id, c.poly.map(p => ({ ...p }))]));
  sim.fire();
  let sawDrill = false, entry = null;
  for (let i = 0; i < 500 && sim.explosions === 0; i++) {
    sim.step();
    if (sim.bullets[0]?.state === 'drilling') { sawDrill = true; entry = { ...sim.bullets[0].entry }; }
  }
  assert.ok(sawDrill); assert.equal(sim.explosions, 1);
  assert.ok(sim.lastBlast.depth >= 14 && sim.lastBlast.depth <= 34);
  assert.ok(sim.retainedArea < sim.totalArea);
  assert.ok(!sim.asteroid.cells.some(c => contains(c.poly, entry)), 'entry opens to space');
  near(totalRockArea(sim), asteroid.area);
  const cells = sim.rocks.flatMap(r => r.cells);
  assert.equal(new Set(cells.map(c => c.id)).size, asteroid.cells.length);
  for (const c of cells) assert.deepEqual(c.poly, initial.get(c.id));
  const fragments = sim.rocks.filter(r => r !== sim.asteroid);
  assert.ok(fragments.length >= 3 && fragments.length <= 6);
  for (const fragment of fragments) {
    assert.ok(Math.hypot(fragment.body.velocity.x, fragment.body.velocity.y) > 0);
    const radial = { x: fragment.body.position.x - sim.lastBlast.center.x, y: fragment.body.position.y - sim.lastBlast.center.y };
    assert.ok(radial.x * fragment.body.velocity.x + radial.y * fragment.body.velocity.y > 0, 'initial kick is away from blast');
  }
  sim.dispose();
});

test('repeated rounds continue excavating while every piece stays finite and collides', () => {
  const sim = new Simulation(asteroid, randomGenerator(7));
  let collisions = 0; Events.on(sim.engine, 'collisionStart', e => { collisions += e.pairs.length; });
  for (let shot = 0; shot < 14; shot++) {
    // Approach different surfaces: firing into a cloud of existing debris
    // correctly breaks those pieces instead of magically reaching the rock.
    const target = sim.asteroid.body.position;
    const angle = Math.PI + shot * .65;
    Body.setPosition(sim.ship, { x: target.x + Math.cos(angle) * 620, y: target.y + Math.sin(angle) * 620 });
    Body.setVelocity(sim.ship, { x: 0, y: 0 }); Body.setAngularVelocity(sim.ship, 0); Body.setAngle(sim.ship, angle + Math.PI / 2);
    sim.fire(); runToExplosion(sim);
    for (let i = 0; i < 40; i++) sim.step();
    near(totalRockArea(sim), asteroid.area);
    for (const r of sim.rocks) for (const value of [r.body.position.x, r.body.position.y, r.body.angle, r.body.velocity.x, r.body.velocity.y]) assert.ok(Number.isFinite(value));
  }
  assert.ok(collisions > 0, 'fragments and the retained asteroid physically collide');
  assert.ok(sim.retainedArea < asteroid.area * .96);
  sim.dispose();
});

test('a moving fragment bounces off the actual asteroid surface', () => {
  const sim = new Simulation(asteroid, randomGenerator(41));
  sim.fire(); runToExplosion(sim);
  const fragment = sim.rocks.find(r => r !== sim.asteroid), target = sim.asteroid.body.position;
  Body.setPosition(fragment.body, { x: target.x - 430, y: target.y + 130 });
  Body.setVelocity(fragment.body, { x: 3, y: 0 });
  const before = fragment.body.velocity.x;
  let collided = false;
  Events.on(sim.engine, 'collisionStart', event => {
    if (event.pairs.some(p => p.bodyA.parent === fragment.body || p.bodyB.parent === fragment.body)) collided = true;
  });
  for (let i = 0; i < 300 && !collided; i++) sim.step();
  assert.ok(collided); assert.ok(fragment.body.velocity.x < before - .1);
  sim.dispose();
});

test('fracture preserves world geometry even when the asteroid is already rotated', () => {
  const sim = new Simulation(asteroid, randomGenerator(19));
  Body.setAngle(sim.asteroid.body, .8);
  const old = new Map(sim.asteroid.cells.map(c => [c.id, c.poly.map(p => localToWorld(sim.asteroid, p))]));
  const center = sim.asteroid.body.position;
  Body.setPosition(sim.ship, { x: center.x - 600, y: center.y - 10 });
  sim.fire(); runToExplosion(sim);
  // No asteroid force before the blast: splitting must not teleport any cell.
  for (const r of sim.rocks) for (const c of r.cells) c.poly.forEach((p, i) => {
    const world = localToWorld(r, p); near(world.x, old.get(c.id)[i].x); near(world.y, old.get(c.id)[i].y);
  });
  sim.dispose();
});

test('blast recoil conserves the rock system momentum', () => {
  const sim = new Simulation(asteroid, randomGenerator(81));
  sim.fire(); runToExplosion(sim);
  let px = 0, py = 0, angular = 0;
  for (const { body } of sim.rocks) {
    const v = Body.getVelocity(body);
    px += body.mass * v.x; py += body.mass * v.y;
    angular += body.inertia * Body.getAngularVelocity(body) + body.mass * (body.position.x * v.y - body.position.y * v.x);
  }
  near(px, 0); near(py, 0); near(angular, 0);
  sim.dispose();
});

test('ship collides with rock instead of passing through it', () => {
  const sim = new Simulation(asteroid, randomGenerator(30));
  Body.setVelocity(sim.ship, { x: 4, y: 0 });
  let collided = false;
  Events.on(sim.engine, 'collisionStart', event => {
    collided ||= event.pairs.some(p => p.bodyA.parent === sim.ship || p.bodyB.parent === sim.ship);
  });
  for (let i = 0; i < 220 && !collided; i++) sim.step();
  assert.ok(collided); assert.ok(sim.ship.velocity.x < 3);
  assert.ok(sim.ship.position.x < sim.asteroid.body.position.x);
  sim.dispose();
});

test('the last rock can fracture completely without losing area or inventing recoil', () => {
  const cells = Array.from({ length: 3 }, (_, id) => {
    const left = -30 + id * 20;
    const poly = [{ x: left, y: -40 }, { x: left + 20, y: -40 }, { x: left + 20, y: 40 }, { x: left, y: 40 }];
    return { id, poly, center: { x: left + 10, y: 0 }, area: 1600, neighbors: [id - 1, id + 1].filter(n => n >= 0 && n < 3) };
  });
  const sim = new Simulation({ cells, area: 4800 }, randomGenerator(2));
  Body.setPosition(sim.ship, { x: -405, y: 0 });
  sim.fire(); runToExplosion(sim);
  assert.equal(sim.asteroid, null); near(totalRockArea(sim), 4800);
  near(sim.rocks.reduce((sum, r) => sum + r.body.mass * Body.getVelocity(r.body).x, 0), 0);
  near(sim.rocks.reduce((sum, r) => sum + r.body.mass * Body.getVelocity(r.body).y, 0), 0);
  sim.dispose();
});
