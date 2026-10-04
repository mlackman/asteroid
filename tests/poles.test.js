import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Matter = require('../vendor/matter.min.js');
globalThis.polyclip = require('../vendor/polyclip.min.js');
const { makeAsteroid, randomGenerator, rotate } = await import('../fracture.js');
const { Simulation } = await import('../physics.js');
const { POLES } = await import('../config.js');
const { Body, Composite } = globalThis.Matter;

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const round = r => [Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i / 8 * Math.PI * 2) * r, y: Math.sin(i / 8 * Math.PI * 2) * r }))];
const STEPS_TO_EXTEND = Math.ceil(POLES.extendTime * 120) + 1;

// A round piece just beyond a pole's fully extended tip, along the pole.
function pieceAtPole(sim, side, radius = 6, gap = 1) {
  const pole = sim.poles.find(p => p.side === side);
  const mount = sim.shipToWorld(sim.poleTip(pole, 0)), tip = sim.shipToWorld(sim.poleTip(pole, 1));
  const along = { x: (tip.x - mount.x) / POLES.length, y: (tip.y - mount.y) / POLES.length };
  const d = radius + gap;
  return sim.createRock(round(radius), { x: tip.x + along.x * d, y: tip.y + along.y * d }, 0, null, true);
}
function extend(sim, keys = new Set()) {
  sim.extendPoles();
  for (let i = 0; i < STEPS_TO_EXTEND; i++) sim.step(keys);
}
// Linear and angular momentum (about the world origin) of the given bodies.
function momentum(bodies) {
  return bodies.reduce((sum, b) => {
    const v = Body.getVelocity(b), w = Body.getAngularVelocity(b);
    return { x: sum.x + b.mass * v.x, y: sum.y + b.mass * v.y, l: sum.l + b.inertia * w + b.mass * (b.position.x * v.y - b.position.y * v.x) };
  }, { x: 0, y: 0, l: 0 });
}
const newSim = () => new Simulation(makeAsteroid(), randomGenerator(1));

test('an extended pole grabs a piece its tip touches, which then moves rigidly with the ship', () => {
  const sim = newSim();
  const rock = pieceAtPole(sim, 1);
  for (let i = 0; i < 30; i++) sim.step();
  assert.equal(sim.held.length, 0, 'a retracted pole grabs nothing');
  extend(sim);
  assert.deepEqual(sim.held, [rock]);
  assert.equal(sim.poles.find(p => p.side === 1).held, rock);
  assert.ok(!Composite.allBodies(sim.engine.world).includes(rock.body), 'the piece is now part of the ship');
  const local = sim.shipToLocal(rock.body.position), angle = rock.body.angle - sim.ship.angle;
  for (let i = 0; i < 240; i++) sim.step(new Set(i < 120 ? ['KeyW', 'KeyA'] : ['KeyS']));
  const now = sim.shipToLocal(rock.body.position);
  near(now.x, local.x, 1e-6); near(now.y, local.y, 1e-6);
  near(rock.body.angle - sim.ship.angle, angle, 1e-9);
});

test('a retracting pole keeps its load; releasing lets the piece go', () => {
  const sim = newSim();
  const rock = pieceAtPole(sim, -1);
  extend(sim);
  assert.deepEqual(sim.held, [rock]);
  sim.retractPoles();
  for (let i = 0; i < STEPS_TO_EXTEND; i++) sim.step();
  assert.equal(sim.poles.find(p => p.side === -1).extension, 1, 'a loaded pole stays out');
  assert.equal(sim.poles.find(p => p.side === 1).extension, 0);
  sim.releaseAll();
  assert.equal(sim.held.length, 0);
  assert.ok(Composite.allBodies(sim.engine.world).includes(rock.body));
  near(sim.ship.mass, sim.shipBase.mass, 1e-12);
});

test('grabbing and releasing conserve linear and angular momentum', () => {
  const sim = newSim();
  const rock = pieceAtPole(sim, 1, 8, .5);
  sim.extendPoles();
  for (const pole of sim.poles) pole.extension = 1;
  Body.setVelocity(sim.ship, { x: .2, y: -.05 }); Body.setAngularVelocity(sim.ship, .002);
  Body.setVelocity(rock.body, { x: .22, y: -.04 }); Body.setAngularVelocity(rock.body, -.01);
  const before = momentum([sim.ship, rock.body]);
  sim.grab(sim.poles.find(p => p.side === 1), rock);
  const held = momentum([sim.ship]);
  near(held.x, before.x, 1e-9); near(held.y, before.y, 1e-9); near(held.l, before.l, 1e-6);
  sim.release(rock);
  const after = momentum([sim.ship, rock.body]);
  near(after.x, before.x, 1e-9); near(after.y, before.y, 1e-9); near(after.l, before.l, 1e-6);
  // The released piece moves with the ship's surface where it was held.
  const v = Body.getVelocity(rock.body), r = { x: rock.body.position.x - sim.ship.position.x, y: rock.body.position.y - sim.ship.position.y };
  const w = Body.getAngularVelocity(sim.ship), vs = Body.getVelocity(sim.ship);
  near(v.x, vs.x - w * r.y, 1e-9); near(v.y, vs.y + w * r.x, 1e-9);
});

test('a pole does not grab a piece too heavy or moving too fast relative to it', () => {
  const sim = newSim();
  const heavy = pieceAtPole(sim, 1, Math.sqrt(POLES.maxArea / 2.83) + 2);
  assert.ok(heavy.area > POLES.maxArea);
  const fast = pieceAtPole(sim, -1);
  sim.extendPoles();
  for (const pole of sim.poles) pole.extension = 1;
  Body.setVelocity(fast.body, { x: 0, y: (POLES.maxGrabSpeed + 5) / 60 });
  sim.step();
  assert.equal(sim.held.length, 0);
});

test('thrust with a load on one pole turns the ship; empty or balanced it flies straight', () => {
  const spinAfterThrust = sides => {
    const sim = newSim();
    for (const side of sides) pieceAtPole(sim, side, 8);
    if (sides.length) extend(sim);
    assert.equal(sim.held.length, sides.length);
    Body.setAngularVelocity(sim.ship, 0);
    for (let i = 0; i < 60; i++) sim.step(new Set(['KeyW']));
    return Body.getAngularVelocity(sim.ship);
  };
  near(spinAfterThrust([]), 0, 1e-12);
  near(spinAfterThrust([-1, 1]), 0, 1e-9);
  assert.ok(Math.abs(spinAfterThrust([1])) > 1e-4, 'an uneven load turns the ship');
});

test('a load slows acceleration by its mass and slows turning', () => {
  const run = (sides, key) => {
    const sim = newSim();
    for (const side of sides) pieceAtPole(sim, side, 8);
    if (sides.length) extend(sim);
    Body.setVelocity(sim.ship, { x: 0, y: 0 }); Body.setAngularVelocity(sim.ship, 0);
    for (let i = 0; i < 60; i++) sim.step(new Set([key]));
    const v = Body.getVelocity(sim.ship);
    return { speed: Math.hypot(v.x, v.y), spin: Math.abs(Body.getAngularVelocity(sim.ship)), mass: sim.ship.mass, base: sim.shipBase.mass };
  };
  const empty = run([], 'KeyW'), loaded = run([-1, 1], 'KeyW');
  near(loaded.speed / empty.speed, loaded.base / loaded.mass, 1e-3);
  assert.ok(run([-1, 1], 'KeyA').spin < run([], 'KeyA').spin * .5);
});

test('a round that breaks a held piece releases it first', () => {
  const sim = newSim();
  const rock = pieceAtPole(sim, 1, 14);
  extend(sim);
  assert.deepEqual(sim.held, [rock]);
  // Fire a round straight at the held piece from beyond it, away from the ship.
  const out = { x: rock.body.position.x - sim.ship.position.x, y: rock.body.position.y - sim.ship.position.y };
  const size = Math.hypot(out.x, out.y), dir = { x: -out.x / size, y: -out.y / size };
  sim.bullets.push({ position: { x: rock.body.position.x - dir.x * 40, y: rock.body.position.y - dir.y * 40 }, velocity: { x: dir.x * 850, y: dir.y * 850 }, age: 0, state: 'flying' });
  const before = sim.explosions;
  for (let i = 0; i < 300 && sim.explosions === before; i++) sim.step();
  assert.ok(sim.explosions > before);
  assert.notEqual(sim.lastBlast.mode, 'none');
  assert.equal(sim.held.length, 0);
  assert.ok(!sim.rocks.includes(rock), 'the piece was replaced by its fragments');
  near(sim.ship.mass, sim.shipBase.mass, 1e-12);
});

test('removing a held piece frees its pole and restores the empty ship', () => {
  const sim = newSim();
  const rock = pieceAtPole(sim, -1);
  extend(sim);
  sim.removeRock(rock);
  assert.equal(sim.held.length, 0);
  assert.ok(!sim.rocks.includes(rock));
  near(sim.ship.mass, sim.shipBase.mass, 1e-12);
  near(sim.ship.inertia, sim.shipBase.inertia, 1e-9);
});
