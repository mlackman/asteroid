import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, SHIP, payout } from '../game.js';
import { ECONOMY, STATION } from '../config.js';

const { fireInterval: FIRE_INTERVAL, fuelPerSecond: FUEL_PER_SECOND } = SHIP;

const STEP = 1 / 120;

test('a new run starts with full tanks, full hull and an empty hold', () => {
  const game = new Game();
  assert.equal(game.fuel, SHIP.fuelCapacity);
  assert.equal(game.ammo, SHIP.ammoCapacity);
  assert.equal(game.hull, SHIP.hullMax);
  assert.equal(game.cargoMass, 0);
});

test('thrust burns fuel and stops reaching the ship when the tank is empty', () => {
  const game = new Game({ ...SHIP, fuelCapacity: 1 });
  const keys = new Set(['KeyW', 'KeyA']);
  let result = game.update(keys, STEP);
  assert.ok(result.controls.has('KeyW'));
  assert.ok(game.thrusting);
  assert.ok(Math.abs(game.fuel - (1 - FUEL_PER_SECOND * STEP)) < 1e-12);
  for (let i = 0; i < 120; i++) result = game.update(keys, STEP);
  assert.equal(game.fuel, 0);
  assert.ok(!result.controls.has('KeyW'));
  assert.ok(!game.thrusting);
  assert.ok(result.controls.has('KeyA'), 'turning needs no fuel');
});

test('coasting and turning burn no fuel', () => {
  const game = new Game();
  for (let i = 0; i < 120; i++) game.update(new Set(['KeyA']), STEP);
  assert.equal(game.fuel, SHIP.fuelCapacity);
});

test('a held trigger fires at the fire interval and spends one round per shot', () => {
  const game = new Game();
  const keys = new Set(['Space']);
  let shots = 0;
  const steps = Math.round(2 / STEP);
  for (let i = 0; i < steps; i++) if (game.update(keys, STEP).fire) shots++;
  assert.equal(shots, Math.ceil(2 / FIRE_INTERVAL));
  assert.equal(game.ammo, SHIP.ammoCapacity - shots);
});

test('a tap fires at once but not again within the cooldown', () => {
  const game = new Game();
  assert.ok(game.tryFire());
  assert.ok(!game.tryFire());
  game.update(new Set(), FIRE_INTERVAL);
  assert.ok(game.tryFire());
});

test('an empty magazine stops firing', () => {
  const game = new Game({ ...SHIP, ammoCapacity: 2 });
  let shots = 0;
  for (let i = 0; i < 600; i++) if (game.update(new Set(['Space']), STEP).fire) shots++;
  assert.equal(shots, 2);
  assert.equal(game.ammo, 0);
});

test('a new run refills the ship and keeps credits', () => {
  const game = new Game();
  game.update(new Set(['KeyW', 'Space']), 1);
  game.collect({ oreArea: 10, rockArea: 5 });
  game.credits = 250;
  game.newRun();
  assert.equal(game.fuel, SHIP.fuelCapacity);
  assert.equal(game.ammo, SHIP.ammoCapacity);
  assert.equal(game.cargo.length, 0);
  assert.equal(game.credits, 250);
});

test('the hold takes ore and the rock stuck to it until it is full', () => {
  const game = new Game({ ...SHIP, cargoCapacity: 300 });
  assert.ok(game.collect({ oreArea: 150, rockArea: 50 }));
  assert.equal(game.cargoMass, 200);
  assert.ok(!game.collect({ oreArea: 90, rockArea: 20 }), 'too big for the space left');
  assert.ok(game.collect({ oreArea: 100, rockArea: 0 }));
  assert.equal(game.cargoMass, 300);
});

test('rock stuck to ore costs a cleaning fee and never pays below zero', () => {
  const clean = payout({ oreArea: 200, rockArea: 0 });
  const dirty = payout({ oreArea: 200, rockArea: 100 });
  assert.equal(clean, 200 * ECONOMY.oreValue);
  assert.equal(dirty, clean - 100 * ECONOMY.cleaningFee);
  assert.equal(payout({ oreArea: 10, rockArea: 10000 }), 0);
});

test('docking slowly inside the ring sells the cargo once and refills the ship', () => {
  const game = new Game();
  game.collect({ oreArea: 200, rockArea: 40 });
  game.update(new Set(['KeyW', 'Space']), 1);
  assert.equal(game.updateDocking(STATION.radius + 1, 0), null, 'outside the ring');
  assert.equal(game.updateDocking(STATION.radius - 1, STATION.maxDockSpeed + 1), null, 'too fast');
  const sale = game.updateDocking(STATION.radius - 1, 0);
  assert.equal(sale.items, 1);
  assert.equal(sale.credits, payout({ oreArea: 200, rockArea: 40 }));
  assert.equal(game.credits, sale.credits);
  assert.equal(game.cargo.length, 0);
  assert.equal(game.fuel, SHIP.fuelCapacity);
  assert.equal(game.ammo, SHIP.ammoCapacity);
  assert.equal(game.updateDocking(STATION.radius - 1, 0), null, 'docks once per visit');
  game.updateDocking(STATION.radius + 5, 0);
  assert.ok(game.updateDocking(STATION.radius - 1, 0), 'docks again after leaving');
});
