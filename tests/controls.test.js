// The controls as the page runs them: keys pass through the game rules into
// the physics (stepGame), under every development switch setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Matter = require('../vendor/matter.min.js');
globalThis.polyclip = require('../vendor/polyclip.min.js');
const { makeAsteroid, randomGenerator, rotate } = await import('../fracture.js');
const { Simulation, STEP } = await import('../physics.js');
const { Game, SHIP, stepGame } = await import('../game.js');
const { STATION, DEBUG } = await import('../config.js');

const SETTINGS = {
  'the shipped config': DEBUG,
  'consumption on': { unlimitedFuel: false, unlimitedAmmo: false },
  'unlimited fuel and ammo': { unlimitedFuel: true, unlimitedAmmo: true }
};
function play(debug, keys, steps = 120) {
  const sim = new Simulation(makeAsteroid(), randomGenerator(1)), game = new Game(SHIP, STATION, debug);
  const start = { ...sim.ship.position }, bow = rotate({ x: 0, y: 1 }, sim.ship.angle);
  let shots = 0;
  for (let i = 0; i < steps; i++) {
    const before = sim.shots;
    stepGame(game, sim, new Set(keys), STEP / 1000);
    shots += sim.shots - before;
  }
  const moved = { x: sim.ship.position.x - start.x, y: sim.ship.position.y - start.y };
  return { sim, game, shots, forward: moved.x * bow.x + moved.y * bow.y, spin: sim.ship.angularVelocity };
}

for (const [name, debug] of Object.entries(SETTINGS)) {
  test(`W moves the ship forward (${name})`, () => {
    const { forward, game } = play(debug, ['KeyW']);
    assert.ok(game.thrusting);
    assert.ok(forward > 10, `the ship moved ${forward} units along its bow in one second`);
  });
  test(`A and S turn the ship (${name})`, () => {
    assert.ok(play(debug, ['KeyA'], 60).spin > 0);
    assert.ok(play(debug, ['KeyS'], 60).spin < 0);
  });
  test(`holding Space fires at the fire interval (${name})`, () => {
    const { shots } = play(debug, ['Space'], 240);
    assert.equal(shots, Math.ceil(2 / SHIP.fireInterval));
  });
  test(`without keys the ship stays put (${name})`, () => {
    const { forward } = play(debug, []);
    assert.equal(forward, 0);
  });
}

test('an empty tank stops thrust when consumption is on', () => {
  const sim = new Simulation(makeAsteroid(), randomGenerator(1));
  const game = new Game({ ...SHIP, fuelCapacity: 0 }, STATION, SETTINGS['consumption on']);
  for (let i = 0; i < 60; i++) stepGame(game, sim, new Set(['KeyW']), STEP / 1000);
  assert.equal(sim.ship.velocity.x, 0); assert.equal(sim.ship.velocity.y, 0);
});
