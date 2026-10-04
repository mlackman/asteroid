import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Matter = require('../vendor/matter.min.js');
globalThis.polyclip = require('../vendor/polyclip.min.js');
const { makeAsteroid, randomGenerator, shapeArea, contains, clip, unite, subtract } = await import('../fracture.js');
const { placeOre, distributeOre, exposure, oreDistance } = await import('../ore.js');
const { ORE } = await import('../config.js');
const { Simulation } = await import('../physics.js');

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const square = (x0, y0, x1, y1) => [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]];
const nugget = (id, cx, cy, r, corners = 8) => {
  const ring = Array.from({ length: corners }, (_, i) => ({ x: cx + Math.cos(i / corners * Math.PI * 2) * r, y: cy + Math.sin(i / corners * Math.PI * 2) * r }));
  return { id, shape: [ring], area: shapeArea([ring]), revealed: false };
};
// A fragment beside a square rock: the part of a nugget outside the square plus a bar.
const beside = (ore, bar) => subtract(unite([ore.shape, bar])[0], [square(0, 0, 100, 100)])[0];
const overlap = (shape, ore) => clip(shape, ore.shape).reduce((sum, part) => sum + shapeArea(part), 0);
// Every nugget lies whole inside exactly one piece and no other piece covers any of it.
function assertWhole(pieces, ores) {
  for (const ore of ores) {
    const holders = pieces.filter(piece => piece.ores.some(o => o.id === ore.id));
    assert.equal(holders.length, 1, `nugget ${ore.id} has one holder`);
    near(overlap(holders[0].shape, ore), ore.area, 1e-4);
    for (const piece of pieces) if (piece !== holders[0]) near(overlap(piece.shape, ore), 0, 1e-4);
  }
}

test('nuggets form buried, apart and within the configured sizes', () => {
  const asteroid = makeAsteroid();
  for (const seed of [1, 2, 3, 4, 5]) {
    const ores = placeOre(asteroid.shape, randomGenerator(seed));
    assert.ok(ores.length >= ORE.countMin && ores.length <= ORE.countMax);
    for (const ore of ores) {
      assert.ok(!ore.revealed);
      const ring = ore.shape[0], xs = ring.map(p => p.x), ys = ring.map(p => p.y);
      assert.ok(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) <= ORE.sizeMax + 1e-9);
      // Buried: the nugget grown by the surface margin still lies inside the rock.
      near(overlap(asteroid.shape, ore), ore.area, 1e-6);
      for (const p of ring) {
        for (let k = 0; k < 8; k++) {
          const a = k / 8 * Math.PI * 2;
          assert.ok(contains(asteroid.shape, { x: p.x + Math.cos(a) * ORE.surfaceMargin, y: p.y + Math.sin(a) * ORE.surfaceMargin }));
        }
      }
    }
    for (let i = 0; i < ores.length; i++) for (let j = i + 1; j < ores.length; j++) near(overlap(ores[i].shape, ores[j]), 0);
  }
  assert.deepEqual(placeOre(asteroid.shape, randomGenerator(9)), placeOre(asteroid.shape, randomGenerator(9)));
});

test('a fracture hands each nugget whole to the piece that held most of it', () => {
  const ore = nugget(0, 104, 50, 8);
  const retained = [square(0, 0, 100, 100)], fragments = [square(100, 30, 130, 70)];
  const before = shapeArea(retained[0]) + shapeArea(fragments[0]);
  const result = distributeOre(retained, fragments, [ore]);
  const pieces = [...result.retained, ...result.fragments];
  assertWhole(pieces, [ore]);
  assert.ok(result.fragments[0].ores.length === 1, 'the fragment held most of it');
  near(pieces.reduce((sum, piece) => sum + shapeArea(piece.shape), 0), before, 1e-4);
});

test('buried ore stays hidden; ore mostly open to space breaks free and shows', () => {
  const buried = nugget(0, 50, 50, 8), edge = nugget(1, 103, 50, 8);
  const retained = [square(0, 0, 100, 100)], fragments = [beside(edge, square(100, 46, 140, 54))];
  const before = shapeArea(retained[0]) + shapeArea(fragments[0]);
  const result = distributeOre(retained, fragments, [buried, edge]);
  const pieces = [...result.retained, ...result.fragments];
  assertWhole(pieces, [buried, edge]);
  near(pieces.reduce((sum, piece) => sum + shapeArea(piece.shape), 0), before, 1e-4);
  const hidden = pieces.flatMap(piece => piece.ores).find(ore => ore.id === 0);
  assert.ok(!hidden.revealed);
  const freed = pieces.find(piece => piece.ores.some(ore => ore.id === 1));
  near(shapeArea(freed.shape), edge.area, 1e-4);
  assert.ok(freed.ores[0].revealed);
  assert.equal(pieces.length, 3, 'the rock beyond the nugget separates on its own');
});

test('crumbs too small to stand alone stay stuck to a freed nugget', () => {
  const edge = nugget(0, 103, 50, 8);
  const result = distributeOre([square(0, 0, 100, 100)], [beside(edge, square(100, 46, 113, 54))], [edge]);
  const pieces = [...result.retained, ...result.fragments];
  assertWhole(pieces, [edge]);
  const holder = pieces.find(piece => piece.ores.length);
  assert.ok(shapeArea(holder.shape) > edge.area + 1, 'dirty: rock still attached');
  assert.equal(pieces.length, 2);
});

test('exposure measures the share of a nugget outline facing open space', () => {
  const ore = nugget(0, 0, 0, 8);
  near(exposure(ore, square(-20, -20, 20, 20)), 0);
  near(exposure(ore, ore.shape), 1);
  near(exposure(ore, square(-20, -20, 0, 20)), .5, .05);
});

// A square rock placed with its left face at world x = -70, on the ship's line of fire (y = -25).
function oreRock(ores) {
  return { shape: square(-250, -250, 250, 250), area: 500 * 500, ores };
}
function runToExplosion(sim, limit = 600) {
  const before = sim.explosions;
  for (let i = 0; i < limit && sim.explosions === before; i++) sim.step();
  assert.ok(sim.explosions > before, 'a fired round must detonate');
}

test('a drilling round stops at buried ore and detonates against it', () => {
  const ore = nugget(0, -232, -25, 10);
  const sim = new Simulation(oreRock([ore]), randomGenerator(3));
  sim.fire();
  runToExplosion(sim);
  const expected = oreDistance([ore], { x: -250, y: -25 }, { x: 1, y: 0 }, 50);
  near(sim.lastBlast.depth, expected, .05);
  assertWhole(sim.rocks, [ore]);
});

test('repeated shots never cut ore, conserve material and expose it', () => {
  const ores = [nugget(0, -225, -25, 10), nugget(1, -180, -25, 12, 6), nugget(2, -150, 30, 9, 5)];
  const sim = new Simulation(oreRock(ores), randomGenerator(11));
  const total = 500 * 500;
  for (let shot = 0; shot < 14; shot++) {
    sim.fire();
    runToExplosion(sim);
    for (let i = 0; i < 30; i++) sim.step();
    assertWhole(sim.rocks, ores);
    near(sim.rocks.reduce((sum, rock) => sum + shapeArea(rock.shape), 0), total, 1e-3);
    for (const rock of sim.rocks) near(rock.rockArea + rock.oreArea, rock.area, 1e-6);
  }
  const first = sim.rocks.flatMap(rock => rock.ores).find(ore => ore.id === 0);
  assert.ok(first.revealed, 'digging along the line of fire exposes the first nugget');
});

test('a round striking exposed ore pushes it without breaking it', () => {
  const ore = nugget(0, 0, 0, 10);
  const sim = new Simulation({ shape: ore.shape, area: ore.area, ores: [{ ...ore, revealed: true }] }, randomGenerator(2));
  const rock = sim.rocks[0];
  // The nugget sits at world (180, 0); move it onto the line of fire.
  globalThis.Matter.Body.setPosition(rock.body, { x: 0, y: -25 });
  sim.fire();
  runToExplosion(sim);
  assert.equal(sim.rocks.length, 1);
  assert.equal(sim.rocks[0], rock);
  assert.ok(rock.body.velocity.x > 0, 'pushed away from the blast');
});

test('the bow scoops ore-bearing pieces it touches at low relative speed', () => {
  const ore = nugget(0, 0, 0, 8);
  const sim = new Simulation({ shape: ore.shape, area: ore.area, ores: [ore] }, randomGenerator(2));
  const rock = sim.rocks[0];
  globalThis.Matter.Body.setPosition(rock.body, { x: -405 + 25.4 + 8 + 3, y: -25 });
  assert.deepEqual(sim.scoopable(), [rock]);
  globalThis.Matter.Body.setVelocity(rock.body, { x: 1, y: 0 });
  assert.deepEqual(sim.scoopable(), [], 'too fast');
  globalThis.Matter.Body.setVelocity(rock.body, { x: 0, y: 0 });
  globalThis.Matter.Body.setPosition(rock.body, { x: -300, y: -25 });
  assert.deepEqual(sim.scoopable(), [], 'out of reach');
  sim.removeRock(rock);
  assert.equal(sim.rocks.length, 0);
});
