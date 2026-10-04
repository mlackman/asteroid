import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
globalThis.Matter = require('../vendor/matter.min.js');
globalThis.polyclip = require('../vendor/polyclip.min.js');
const { makeAsteroid, randomGenerator, polygonArea, shapeArea, shapeProperties, triangulate, convexParts, contains, segmentHit, solidDistance, fractureShape, onSegment } = await import('../fracture.js');
const { Simulation, localToWorld, worldToLocal } = await import('../physics.js');
const { prepareFracture, sharedBoundaries } = await import('../rock-geometry.js');
const { Body, Events, Query } = globalThis.Matter;
const asteroid = makeAsteroid();
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const coordinates = shape => shape.map(ring => ring.map(p => [p.x, p.y]));
const clippedArea = multipolygon => multipolygon.reduce((sum, shape) => sum + shapeArea(shape.map(ring => ring.map(([x, y]) => ({ x, y })))), 0);
const totalRockArea = sim => sim.rocks.reduce((sum, rock) => sum + shapeArea(rock.shape), 0);
function runToExplosion(sim, limit = 500) {
  const before = sim.explosions;
  for (let i = 0; i < limit && sim.explosions === before; i++) sim.step();
  assert.ok(sim.explosions > before, 'a fired round must drill and explode');
}
function assertPartition(parent, pieces) {
  near(pieces.reduce((sum, shape) => sum + shapeArea(shape), 0), shapeArea(parent), 1e-5);
  const union = globalThis.polyclip.union(...pieces.map(coordinates));
  const missing = globalThis.polyclip.difference(coordinates(parent), union);
  const excess = globalThis.polyclip.difference(union, coordinates(parent));
  near(clippedArea(missing), 0, 1e-5); near(clippedArea(excess), 0, 1e-5);
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    near(clippedArea(globalThis.polyclip.intersection(coordinates(pieces[i]), coordinates(pieces[j]))), 0, 1e-5);
  }
}
function assertMomentum(sim, expected = { x: 0, y: 0, angular: 0 }) {
  let x = 0, y = 0, angular = 0;
  for (const { body } of sim.rocks) {
    const velocity = Body.getVelocity(body);
    x += body.mass * velocity.x; y += body.mass * velocity.y;
    angular += body.inertia * Body.getAngularVelocity(body) + body.mass * (body.position.x * velocity.y - body.position.y * velocity.x);
  }
  near(x, expected.x, 1e-5); near(y, expected.y, 1e-5); near(angular, expected.angular, 1e-4);
}
function trackCollisionDisplacement(sim) {
  let beforeCollision = new Map(), corrections = new Map();
  Events.on(sim.engine, 'beforeSolve', () => {
    beforeCollision = new Map(sim.rocks.map(({ body }) => [body, { ...body.position }]));
  });
  Events.on(sim.engine, 'afterUpdate', () => {
    for (const { body } of sim.rocks) {
      const before = beforeCollision.get(body), sum = corrections.get(body) || { x: 0, y: 0 };
      sum.x += body.position.x - before.x;
      sum.y += body.position.y - before.y;
      corrections.set(body, sum);
    }
  });
  // Sample actual position changes during contact resolution, including shifts
  // that are absent from Matter's reported velocity and kinetic energy.
  return () => { const sample = corrections; corrections = new Map(); return sample; };
}

test('an explosion cuts new matching polygons and uses the drill path as a shared edge', () => {
  const entry = { x: -30, y: -200 }, center = { x: -30, y: -180 }, direction = { x: 0, y: 1 };
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const result = fractureShape(shape, entry, center, direction, randomGenerator(12));
  assert.equal(result.mode, 'chip'); assert.ok(result.fragments.length >= 2 && result.fragments.length <= 4);
  assertPartition(shape, [...result.retained, ...result.fragments]);
  for (const t of [.05, .25, .5, .75, .95]) {
    const point = { x: entry.x + (center.x - entry.x) * t, y: entry.y + (center.y - entry.y) * t };
    const usesDrillEdge = piece => piece.some(ring => ring.some((a, i) => onSegment(point, a, ring[(i + 1) % ring.length])));
    assert.ok(result.fragments.filter(usesDrillEdge).length >= 2, 'the straight drill path must border detached fragments on both sides');
  }
  assert.ok(result.fragments.reduce((s, p) => s + shapeArea(p), 0) < shapeArea(shape) * .03);
  const other = fractureShape(shape, { x: 70, y: -200 }, { x: 70, y: -180 }, direction, randomGenerator(12));
  assert.notDeepEqual(result.fragments, other.fragments, 'moving the explosion creates different fracture geometry');
});

test('detonation releases material on both sides of the drill line and beyond the explosion point', () => {
  for (const angle of [0, .75, -1.3]) {
    const rotate = p => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }].map(rotate)];
    const entry = rotate({ x: 0, y: -200 }), center = rotate({ x: 0, y: -174 }), direction = rotate({ x: 0, y: 1 });
    const normal = { x: -direction.y, y: direction.x };
    for (let seed = 1; seed <= 20; seed++) {
      const result = fractureShape(shape, entry, center, direction, randomGenerator(seed));
      assert.equal(result.mode, 'chip'); assertPartition(shape, [...result.retained, ...result.fragments]);
      for (const sign of [-1, 1]) {
        const point = { x: center.x + normal.x * sign, y: center.y + normal.y * sign };
        assert.ok(result.fragments.some(piece => contains(piece, point)), 'material beside the explosion must detach on each side');
        assert.ok(!result.retained.some(piece => contains(piece, point)));
      }
      assert.ok(result.fragments.flat(2).some(p => (p.x - center.x) * direction.x + (p.y - center.y) * direction.y > 5), 'the blast must surround the detonation point instead of ending there');
      for (const piece of result.fragments) {
        const offsets = piece.flat().map(p => (p.x - center.x) * normal.x + (p.y - center.y) * normal.y);
        assert.ok(Math.min(...offsets) >= -1e-6 || Math.max(...offsets) <= 1e-6, 'the bullet line remains a straight boundary between pieces');
      }
    }
  }
});

test('the closed end of the U-shaped blast is faceted around the detonation and opens toward the surface', () => {
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const center = { x: 0, y: -174 };
  for (let seed = 1; seed <= 20; seed++) {
    const result = fractureShape(shape, { x: 0, y: -200 }, center, { x: 0, y: 1 }, randomGenerator(seed));
    assert.equal(result.mode, 'chip');
    const boundary = result.retained.flat(2).filter(p => Math.abs(p.x) < 249 && p.y > -199);
    const radii = boundary.map(p => Math.hypot(p.x - center.x, p.y - center.y));
    assert.ok(boundary.length >= 4 && boundary.length <= 14, 'use a few noticeable polygon corners rather than a smooth arc');
    assert.ok(Math.max(...radii) / Math.min(...radii) < 1.4, 'the closed end should form a rough arc around the detonation');
    for (const point of [{ x: -5, y: -199 }, { x: 5, y: -199 }]) {
      assert.ok(result.fragments.some(piece => contains(piece, point)), 'both sides of the open end must reach the exterior');
      assert.ok(!result.retained.some(piece => contains(piece, point)));
    }
    assertPartition(shape, [...result.retained, ...result.fragments]);
  }
});

test('an angled drill turns the pocket toward the surface normal and keeps the drill path as a fracture', () => {
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const inward = { x: 0, y: 1 }, entry = { x: 0, y: -200 };
  const angleTo = v => Math.acos(Math.max(-1, Math.min(1, v.x * inward.x + v.y * inward.y)));
  for (const degrees of [30, 45, -45, 60]) {
    const tilt = degrees * Math.PI / 180, direction = { x: Math.sin(tilt), y: Math.cos(tilt) };
    const center = { x: direction.x * 24, y: -200 + direction.y * 24 };
    for (let seed = 1; seed <= 10; seed++) {
      const result = fractureShape(shape, entry, center, direction, randomGenerator(seed));
      assert.equal(result.mode, 'chip'); assertPartition(shape, [...result.retained, ...result.fragments]);
      assert.ok(angleTo(result.axis) < Math.abs(tilt) - Math.PI / 18, `${degrees} deg, seed ${seed}: the pocket turns toward the inward normal`);
      assert.ok(Math.sign(result.axis.x) === Math.sign(direction.x), 'the pocket turns only part of the way');
      for (const t of [.1, .5, .9]) {
        const point = { x: entry.x + (center.x - entry.x) * t, y: entry.y + (center.y - entry.y) * t };
        const usesDrillEdge = piece => piece.some(ring => ring.some((a, i) => onSegment(point, a, ring[(i + 1) % ring.length])));
        assert.ok(result.fragments.filter(usesDrillEdge).length >= 2, `${degrees} deg, seed ${seed}: the drill path stays inside the pocket`);
      }
    }
  }
});

test('surface blasts produce two to four broad compact pieces instead of pointed fans', () => {
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const scores = [], counts = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const result = fractureShape(shape, { x: 0, y: -200 }, { x: 0, y: -174 }, { x: 0, y: 1 }, randomGenerator(seed));
    assert.equal(result.mode, 'chip');
    const released = result.fragments.length + result.retained.length - 1;
    assert.ok(released >= 2 && released <= 4); counts.add(released);
    for (const piece of result.fragments) {
      const perimeter = piece.reduce((sum, ring) => sum + ring.reduce((s, p, i) => s + Math.hypot(p.x - ring[(i + 1) % ring.length].x, p.y - ring[(i + 1) % ring.length].y), 0), 0);
      scores.push(4 * Math.PI * shapeArea(piece) / perimeter ** 2);
    }
  }
  assert.deepEqual([...counts].sort(), [2, 3, 4]);
  // Even an equilateral triangle cannot exceed about 0.605 compactness.
  // This checks the actual filled outlines, not cosmetic corner smoothing.
  assert.ok(scores.reduce((sum, n) => sum + n, 0) / scores.length > .7);
  assert.ok(Math.min(...scores) > .5, 'avoid needle-shaped shards');
});

test('identical impacts produce varied cap outlines and uneven chunk proportions', () => {
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const widths = [], unevenness = [];
  for (let seed = 1; seed <= 40; seed++) {
    const result = fractureShape(shape, { x: 0, y: -200 }, { x: 0, y: -174 }, { x: 0, y: 1 }, randomGenerator(seed));
    assert.equal(result.mode, 'chip');
    assertPartition(shape, [...result.retained, ...result.fragments]);
    const points = result.fragments.flat(2);
    widths.push(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)));
    const areas = result.fragments.map(shapeArea);
    unevenness.push(Math.max(...areas) / Math.min(...areas));
  }
  assert.ok(Math.max(...widths) / Math.min(...widths) > 1.5, 'caps should vary visibly in aspect ratio at the same drill depth');
  assert.ok(unevenness.filter(ratio => ratio > 2).length >= 10, 'many blasts should mix larger chunks with smaller chips');
});

test('a small fragment splits completely along the bullet line and can split again', () => {
  const shape = [[{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: -40, y: 30 }]];
  const first = fractureShape(shape, { x: -40, y: 0 }, { x: -15, y: 0 }, { x: 1, y: 0 }, randomGenerator(4));
  assert.equal(first.mode, 'split'); assert.equal(first.fragments.length, 2);
  first.fragments.forEach(piece => near(shapeArea(piece), 2400)); assertPartition(shape, first.fragments);
  const top = first.fragments.find(piece => contains(piece, { x: 0, y: 15 }));
  const second = fractureShape(top, { x: 0, y: 30 }, { x: 0, y: 10 }, { x: 0, y: -1 });
  assert.equal(second.mode, 'split'); assert.equal(second.fragments.length, 2);
  second.fragments.forEach(piece => near(shapeArea(piece), 1200)); assertPartition(top, second.fragments);
});

test('cuts support concave outlines, holes, and separate disconnected regions', () => {
  const outer = [{ x: -45, y: -40 }, { x: 45, y: -40 }, { x: 45, y: 40 }, { x: -45, y: 40 }];
  const hole = [{ x: -15, y: -20 }, { x: -15, y: 20 }, { x: 15, y: 20 }, { x: 15, y: -20 }];
  const shape = [outer, hole];
  assert.equal(contains(shape, { x: 0, y: 0 }), false);
  const split = fractureShape(shape, { x: -45, y: 0 }, { x: -25, y: 0 }, { x: 1, y: 0 });
  assert.equal(split.mode, 'split'); assertPartition(shape, split.fragments);
  near(triangulate(shape).reduce((sum, p) => sum + polygonArea(p), 0), shapeArea(shape));
  const u = [[{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: 20, y: 30 }, { x: 20, y: -10 }, { x: -20, y: -10 }, { x: -20, y: 30 }, { x: -40, y: 30 }]];
  const broken = fractureShape(u, { x: -40, y: 0 }, { x: -30, y: 0 }, { x: 1, y: 0 });
  assert.equal(broken.fragments.length, 3, 'both severed arms become independent bodies'); assertPartition(u, broken.fragments);
});

test('convex collision parts preserve the outline after many irregular cavities accumulate', () => {
  const shape = JSON.parse(readFileSync(new URL('./fixtures/accumulated-cavities.json', import.meta.url), 'utf8'));
  const triangles = triangulate(shape);
  const parts = convexParts(triangles);
  assert.ok(parts.length < triangles.length);
  const union = globalThis.polyclip.union(...parts.map(part => coordinates([part])));
  near(parts.reduce((sum, part) => sum + polygonArea(part), 0), shapeArea(shape), 1e-5);
  near(triangles.reduce((sum, triangle) => sum + polygonArea(triangle), 0), shapeArea(shape), 1e-5);
  near(clippedArea(globalThis.polyclip.difference(coordinates(shape), union)), 0, 1e-5);
  near(clippedArea(globalThis.polyclip.difference(union, coordinates(shape))), 0, 1e-5);
});

test('thin slivers merge or prevent a cut without deleting material', () => {
  const shape = [[{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: -40, y: 30 }]];
  const result = fractureShape(shape, { x: -40, y: 29.9 }, { x: -20, y: 29.9 }, { x: 1, y: 0 });
  assert.equal(result.mode, 'none'); assertPartition(shape, result.retained);
});

test('swept hits catch thin pieces and drilling stops at the first cavity', () => {
  const thin = [[{ x: 0, y: -1 }, { x: .01, y: -1 }, { x: .01, y: 1 }, { x: 0, y: 1 }]];
  near(segmentHit(thin, { x: -500, y: 0 }, { x: 500, y: 0 }), .5);
  assert.equal(segmentHit(thin, { x: -500, y: 3 }, { x: 500, y: 3 }), Infinity);
  const shape = [[{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }], [{ x: -30, y: -20 }, { x: -30, y: 20 }, { x: 20, y: 20 }, { x: 20, y: -20 }]];
  near(solidDistance(shape, { x: -40, y: 0 }, { x: 1, y: 0 }, 34), 10);
});

test('ship coasts without drag, turns by torque, and shoots from the V tip', () => {
  const sim = new Simulation(asteroid, randomGenerator(1));
  for (let i = 0; i < 80; i++) sim.step(new Set(['KeyW']));
  const { x: vx, y: vy } = sim.ship.velocity, x = sim.ship.position.x;
  assert.ok(vx > 1);
  for (let i = 0; i < 30; i++) sim.step();
  near(sim.ship.velocity.x, vx); near(sim.ship.velocity.y, vy); assert.ok(sim.ship.position.x > x);
  sim.step(new Set(['KeyA'])); assert.ok(sim.ship.angularVelocity > 0);
  const spin = sim.ship.angularVelocity; sim.step(); near(sim.ship.angularVelocity, spin);
  sim.step(new Set(['KeyS'])); near(sim.ship.angularVelocity, 0);
  sim.fire(); assert.ok(sim.bullets[0].position.x > sim.ship.position.x + 20); assert.ok(sim.bullets[0].velocity.x > 850);
  sim.dispose();
});

test('a fired round drills shallowly, opens the surface, and conserves area and momentum', () => {
  const sim = new Simulation(asteroid, randomGenerator(5)); sim.fire();
  const bullet = sim.bullets[0];
  let sawDrill = false;
  for (let i = 0; i < 500 && !sim.explosions; i++) { sim.step(); sawDrill ||= bullet.state === 'drilling'; }
  assert.ok(sawDrill); assert.equal(sim.explosions, 1); assert.equal(sim.lastBlast.mode, 'chip');
  assert.ok(sim.lastBlast.depth >= 14 && sim.lastBlast.depth <= 34);
  assert.ok(sim.retainedArea < sim.totalArea); near(totalRockArea(sim), asteroid.area);
  assertPartition(asteroid.shape, sim.rocks.map(r => r.shape)); assertMomentum(sim);
  // The cavity has real empty area immediately beside the mandatory drill edge.
  const midpoint = { x: (bullet.entry.x + bullet.local.x) / 2, y: (bullet.entry.y + bullet.local.y) / 2 };
  assert.ok(!contains(sim.asteroid.shape, { x: midpoint.x, y: midpoint.y + .01 }) && !contains(sim.asteroid.shape, { x: midpoint.x, y: midpoint.y - .01 }));
  sim.dispose();
});

test('a later fired round splits an already detached fragment into smaller physical bodies', () => {
  const sim = new Simulation(asteroid, randomGenerator(5)); sim.fire(); runToExplosion(sim);
  const fragment = sim.rocks.filter(r => r !== sim.asteroid).sort((a, b) => b.area - a.area)[0];
  assert.ok(fragment.area > 100);
  // Move the fragment away from the parent so this shot tests its own surface.
  Body.setPosition(fragment.body, { x: -700, y: 200 }); Body.setVelocity(fragment.body, { x: 0, y: 0 }); Body.setAngularVelocity(fragment.body, 0); Body.setAngle(fragment.body, 0);
  const target = fragment.body.position;
  Body.setPosition(sim.ship, { x: target.x - 140, y: target.y }); Body.setVelocity(sim.ship, { x: 0, y: 0 }); Body.setAngularVelocity(sim.ship, 0); Body.setAngle(sim.ship, -Math.PI / 2);
  const before = new Set(sim.rocks); sim.fire(); runToExplosion(sim);
  assert.equal(sim.lastBlast.mode, 'split'); assert.ok(!sim.rocks.includes(fragment));
  const children = sim.rocks.filter(r => !before.has(r));
  assert.ok(children.length >= 2); assertPartition(fragment.shape, children.map(r => r.shape));
  for (const child of children) assert.ok(child.area < fragment.area);
  near(totalRockArea(sim), asteroid.area);
  sim.dispose();
});

test('detached collision outlines have a thin clearance while visible pieces still fit and conserve mass', () => {
  for (const seed of [1, 5, 13, 19]) {
    const sim = new Simulation(asteroid, randomGenerator(seed)); sim.fire(); runToExplosion(sim);
    assertPartition(asteroid.shape, sim.rocks.map(r => r.shape)); assertMomentum(sim);
    for (const rock of sim.rocks.filter(r => r !== sim.asteroid)) {
      const collisionPolygons = rock.body.parts.slice(1).map(part => [part.vertices.map(p => worldToLocal(rock, p))]);
      const collisionArea = collisionPolygons.reduce((sum, shape) => sum + shapeArea(shape), 0);
      assert.ok(collisionArea < rock.area && collisionArea >= rock.area * .9, 'a thin clearance affects only the collision outline');
      for (const collisionShape of collisionPolygons) {
        const outside = polyclip.difference(coordinates(collisionShape), coordinates(rock.shape));
        near(clippedArea(outside), 0, 1e-5);
      }
      near(rock.triangles.reduce((sum, triangle) => sum + polygonArea(triangle), 0), rock.area);
      const properties = shapeProperties(rock.shape);
      near(rock.body.mass, properties.area * .0024);
      near(rock.body.inertia, properties.inertia * .0024);
      const center = localToWorld(rock, properties.center);
      near(center.x, rock.body.position.x); near(center.y, rock.body.position.y);
      const neighbors = sim.rocks.filter(other => other !== rock).flatMap(other => other.body.parts.slice(1));
      assert.ok(rock.body.parts.slice(1).every(part => Query.collides(part, neighbors).length === 0), 'new collision bodies must start clear of matching neighbors');
    }
    sim.dispose();
  }
});

test('bullets still hit visible edges outside a detached collider', () => {
  const sim = new Simulation(asteroid);
  const shape = [[{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: -40, y: 30 }]];
  const rock = sim.createRock(shape, { x: -700, y: 200 }, .7, null, true);
  const from = localToWorld(rock, { x: -80, y: 29.9 }), to = localToWorld(rock, { x: 80, y: 29.9 });
  const hit = sim.findHit(from, to);
  assert.equal(hit.entity, rock); near(hit.local.x, -40); near(hit.local.y, 29.9);
  sim.dispose();
});

test('detached pieces have a thin clearance in every orientation, smaller on narrow pieces', () => {
  // Visible outlines can overlap by at most the clearance on each side, so it
  // stays a quarter unit, or 7.5% of the width on pieces narrower than that.
  for (const [halfWidth, halfHeight, clearance] of [[40, 30, .25], [1.2, .8, .12]]) {
    const shape = [[{ x: -halfWidth, y: -halfHeight }, { x: halfWidth, y: -halfHeight }, { x: halfWidth, y: halfHeight }, { x: -halfWidth, y: halfHeight }]];
    for (const angle of [0, .7, 1.4]) {
      const rotate = p => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) });
      const rotatedShape = shape.map(ring => ring.map(rotate));
      const sim = new Simulation(asteroid);
      const rock = sim.createRock(rotatedShape, { x: -700, y: 200 }, .4, null, true);
      const vertices = rock.body.parts.slice(1).flatMap(part => part.vertices.map(p => worldToLocal(rock, p))).map(p => ({ x: p.x * Math.cos(angle) + p.y * Math.sin(angle), y: -p.x * Math.sin(angle) + p.y * Math.cos(angle) }));
      near(Math.max(...vertices.map(p => p.x)), halfWidth - clearance);
      near(Math.min(...vertices.map(p => p.x)), -halfWidth + clearance);
      near(Math.max(...vertices.map(p => p.y)), halfHeight - clearance);
      near(Math.min(...vertices.map(p => p.y)), -halfHeight + clearance);
      near(rock.area, 4 * halfWidth * halfHeight);
      near(rock.body.mass, 4 * halfWidth * halfHeight * .0024);
      sim.dispose();
    }
  }
});

test('newly fractured pieces have an initial period of drift without immediate contacts', () => {
  for (const seed of [6, 12, 19, 33, 43, 47, 56, 62, 70, 74]) {
    const sim = new Simulation(asteroid, randomGenerator(seed));
    sim.fire(); runToExplosion(sim);
    const fragments = sim.rocks.filter(rock => rock !== sim.asteroid);
    const before = fragments.map(({ body }) => ({ position: { ...body.position }, velocity: Body.getVelocity(body) }));
    let contacts = 0;
    Events.on(sim.engine, 'collisionStart', event => { contacts += event.pairs.filter(p => p.collision.parentA.label === 'Rock' && p.collision.parentB.label === 'Rock').length; });
    for (let tick = 0; tick < 6; tick++) sim.step();
    assert.equal(contacts, 0, `seed ${seed}: give the fragments room to start moving`);
    fragments.forEach(({ body }, i) => {
      near(body.position.x - before[i].position.x, before[i].velocity.x * 3);
      near(body.position.y - before[i].position.y, before[i].velocity.y * 3);
    });
    sim.dispose();
  }
});

test('each chip receives one outward launch, starts tumbling once clear, and coasts without further acceleration', () => {
  let spinning = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed)); sim.fire(); runToExplosion(sim);
    const fragments = sim.rocks.filter(r => r !== sim.asteroid);
    const speeds = [];
    for (const rock of fragments) {
      const velocity = Body.getVelocity(rock.body);
      const speed = Math.hypot(velocity.x, velocity.y) * 60;
      speeds.push(speed);
      assert.ok(speed >= 5 && speed <= 24, `seed ${seed}: launch speed ${speed}`);
      assert.ok(velocity.x < 0, 'surface pieces move toward the open end of the cavity');
      near(Body.getAngularVelocity(rock.body), 0);
      Body.setPosition(rock.body, { x: -1000, y: fragments.indexOf(rock) * 200 });
    }
    if (fragments.length > 2) assert.ok(Math.max(...speeds) - Math.min(...speeds) > 2, `seed ${seed}: pieces leave at different speeds`);
    // Far from every neighbor, the delayed tumble starts on the next update.
    sim.step();
    assert.equal(sim.pendingSpins.length, 0);
    for (const rock of fragments) {
      const spin = Math.abs(Body.getAngularVelocity(rock.body)) * 60;
      assert.ok(spin < 1.5, `seed ${seed}: tumble stays gentle, ${spin} rad/s`);
      if (spin > .02) spinning++;
    }
    const velocities = fragments.map(rock => Body.getVelocity(rock.body));
    const spins = fragments.map(rock => Body.getAngularVelocity(rock.body));
    const positions = fragments.map(rock => ({ ...rock.body.position }));
    for (let i = 0; i < 120; i++) sim.step();
    fragments.forEach((rock, i) => {
      near(Body.getVelocity(rock.body).x, velocities[i].x); near(Body.getVelocity(rock.body).y, velocities[i].y);
      near(Body.getAngularVelocity(rock.body), spins[i]);
      near(rock.body.position.x - positions[i].x, velocities[i].x * 60);
      near(rock.body.position.y - positions[i].y, velocities[i].y * 60);
    });
    sim.dispose();
  }
  assert.ok(spinning > 20, `most launched pieces tumble, ${spinning} did`);
});

test('chips fan out from the blast so no two siblings start on converging paths', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed)); sim.fire(); runToExplosion(sim);
    const fragments = sim.rocks.filter(r => r !== sim.asteroid);
    const directions = fragments.map(({ body }) => { const v = Body.getVelocity(body); return Math.atan2(v.y, v.x); });
    assert.ok(Math.max(...directions) - Math.min(...directions) > Math.PI / 6, `seed ${seed}: launch directions spread out`);
    for (const [i, a] of fragments.entries()) for (const b of fragments.slice(i + 1)) {
      const va = Body.getVelocity(a.body), vb = Body.getVelocity(b.body);
      const closing = (va.x - vb.x) * (a.body.position.x - b.body.position.x) + (va.y - vb.y) * (a.body.position.y - b.body.position.y);
      assert.ok(closing > 0, `seed ${seed}: siblings must separate, not cross`);
    }
    sim.dispose();
  }
});

test('an angled hit throws debris toward the surface normal rather than back along the bullet', () => {
  // A square tilted by 30 degrees: the bullet travels along +x and meets a face
  // whose outward normal points up and to the left.
  const tilt = Math.PI / 6;
  const shape = [[{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }].map(p => ({
    x: p.x * Math.cos(tilt) - p.y * Math.sin(tilt), y: p.x * Math.sin(tilt) + p.y * Math.cos(tilt)
  }))];
  for (let seed = 1; seed <= 10; seed++) {
    const sim = new Simulation({ shape, area: shapeArea(shape) }, randomGenerator(seed));
    sim.fire(); runToExplosion(sim);
    assert.equal(sim.lastBlast.mode, 'chip');
    const released = sim.rocks.filter(r => r !== sim.asteroid);
    const momentum = released.reduce((sum, { body }) => {
      const v = Body.getVelocity(body), parent = Body.getVelocity(sim.asteroid.body);
      return { x: sum.x + body.mass * (v.x - parent.x), y: sum.y + body.mass * (v.y - parent.y) };
    }, { x: 0, y: 0 });
    const angle = Math.atan2(momentum.y, -momentum.x);
    // The reversed bullet is at 0 degrees and the face normal at -30.
    assert.ok(angle < -Math.PI / 36, `seed ${seed}: debris leans toward the surface normal, ${angle * 180 / Math.PI} deg`);
    sim.dispose();
  }
});

test('an interior chunk exits through the open U at constant velocity without rebounding inside', () => {
  const sim = new Simulation(asteroid, randomGenerator(5)); sim.fire(); runToExplosion(sim);
  const interior = sim.rocks.filter(r => r !== sim.asteroid).sort((a, b) => b.body.position.x - a.body.position.x)[0];
  assert.ok(interior.body.position.x > sim.lastBlast.center.x + 2, 'choose an interior piece beyond the explosion');
  const velocity = Body.getVelocity(interior.body), before = { ...interior.body.position };
  assert.ok(velocity.x < -.1, 'the launch goes toward the cavity opening');
  let collided = false;
  Events.on(sim.engine, 'collisionStart', e => { collided ||= e.pairs.some(p =>
    (p.collision.parentA === interior.body && p.collision.parentB === sim.asteroid.body) ||
    (p.collision.parentB === interior.body && p.collision.parentA === sim.asteroid.body)); });
  for (let i = 0; i < 900; i++) {
    sim.step();
    near(Body.getVelocity(interior.body).x, velocity.x);
    near(Body.getVelocity(interior.body).y, velocity.y);
    near(interior.body.position.x, before.x + velocity.x * (i + 1) / 2);
    near(interior.body.position.y, before.y + velocity.y * (i + 1) / 2);
  }
  assert.equal(collided, false);
  const worldShape = rock => coordinates(rock.shape.map(ring => ring.map(p => localToWorld(rock, p))));
  near(clippedArea(globalThis.polyclip.intersection(worldShape(interior), worldShape(sim.asteroid))), 0);
  sim.dispose();
});

test('released pieces leave the flared pocket without sliding through its walls', () => {
  const worldShape = rock => coordinates(rock.shape.map(ring => ring.map(p => localToWorld(rock, p))));
  const peaks = [];
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed)); sim.fire(); runToExplosion(sim);
    const parent = sim.asteroid, pieces = sim.rocks.filter(r => r !== parent);
    let peak = 0;
    for (let tick = 0; tick < 600; tick++) {
      if (tick % 10 === 0) for (const piece of pieces) peak = Math.max(peak, clippedArea(globalThis.polyclip.intersection(worldShape(piece), worldShape(parent))));
      sim.step();
    }
    peaks.push(peak);
    sim.dispose();
  }
  // Every crack opens at release, so no piece ever enters its parent. (When
  // collisions were switched off during release, typical blasts pushed about
  // 55 square units into it.)
  assert.ok(Math.max(...peaks) < .01, `peak overlaps ${peaks.map(p => p.toFixed(2)).join(' ')}`);
});

test('gentle fragments move independently through contacts without gaining extra energy', () => {
  const energy = sim => sim.rocks.reduce((sum, { body }) => {
    const v = Body.getVelocity(body), spin = Body.getAngularVelocity(body);
    return sum + body.mass * (v.x ** 2 + v.y ** 2) / 2 + body.inertia * spin ** 2 / 2;
  }, 0);
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed));
    sim.fire(); runToExplosion(sim);
    // Include each piece's delayed tumble, which starts once it is clear.
    for (let i = 0; i < 600 && sim.pendingSpins.length; i++) sim.step();
    const fragments = sim.rocks.filter(r => r !== sim.asteroid), launchEnergy = energy(sim);
    const pairs = fragments.flatMap((a, i) => fragments.slice(i + 1).map(b => ({
      a, b, offset: { x: a.body.position.x - b.body.position.x, y: a.body.position.y - b.body.position.y }
    })));
    // Collisions may bring pieces together again. Check independent movement,
    // not a forced minimum gap or a deadline for every piece to leave the pocket.
    for (let i = 0; i < 1200; i++) sim.step();
    for (const { a, b, offset } of pairs) {
      const change = Math.hypot(a.body.position.x - b.body.position.x - offset.x, a.body.position.y - b.body.position.y - offset.y);
      assert.ok(change > 1, `seed ${seed}: fragments must move independently, changed ${change}`);
    }
    assert.ok(energy(sim) <= launchEnergy * 1.05, `seed ${seed}: passive collisions must not add explosion energy`);
    assert.equal(sim.pendingSpins.length, 0, `seed ${seed}: every piece clears its neighbors and starts tumbling`);
    sim.dispose();
  }
});

test('a centered rock impact rebounds without losing speed and then coasts uniformly', () => {
  const shape = [[{ x: -40, y: -50 }, { x: 40, y: -50 }, { x: 40, y: 50 }, { x: -40, y: 50 }]];
  const sim = new Simulation({ shape, area: shapeArea(shape) });
  Body.setStatic(sim.asteroid.body, true);
  const chip = sim.createRock([[{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }]], { x: 125, y: 0 }, 0, null, true);
  Body.setVelocity(chip.body, { x: .2, y: 0 });
  for (let i = 0; i < 160; i++) sim.step();
  near(Body.getVelocity(chip.body).x, -.2, 1e-4);
  near(Body.getVelocity(chip.body).y, 0, 1e-4);
  const start = { ...chip.body.position };
  for (let i = 0; i < 120; i++) sim.step();
  near(chip.body.position.x - start.x, -12, 1e-3);
  near(chip.body.position.y, start.y, 1e-4);
  sim.dispose();
});

test('overlap corrections stop when an outgoing fragment loses contact', () => {
  const shape = [[{ x: -40, y: -50 }, { x: 40, y: -50 }, { x: 40, y: 50 }, { x: -40, y: 50 }]];
  const sim = new Simulation({ shape, area: shapeArea(shape) });
  Body.setStatic(sim.asteroid.body, true);
  const chip = sim.createRock([[{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }]], { x: 227.5, y: 0 }, 0, null, true);
  Body.setPosition(chip.body, { x: sim.asteroid.body.bounds.max.x + chip.body.position.x - chip.body.bounds.min.x - .5, y: 0 });
  Body.setVelocity(chip.body, { x: .08, y: 0 });
  let touched = false, ended = false;
  Events.on(sim.engine, 'collisionStart', e => { touched ||= e.pairs.some(p => [p.bodyA.parent, p.bodyB.parent].includes(chip.body)); });
  Events.on(sim.engine, 'collisionEnd', e => { ended ||= e.pairs.some(p => [p.bodyA.parent, p.bodyB.parent].includes(chip.body)); });
  for (let i = 0; i < 100 && !ended; i++) sim.step();
  assert.ok(touched && ended);
  for (let i = 0; i < 20; i++) {
    const before = { ...chip.body.position }, velocity = Body.getVelocity(chip.body);
    sim.step();
    near(chip.body.position.x - before.x, velocity.x / 2, 1e-8);
    near(chip.body.position.y - before.y, velocity.y / 2, 1e-8);
  }
  sim.dispose();
});

test('freed rotating fragments resolve later contacts without visible displacement bursts', () => {
  for (const seed of [6, 12, 19, 33, 43, 47, 56, 62, 70, 74]) {
    const sim = new Simulation(asteroid, randomGenerator(seed));
    sim.fire(); runToExplosion(sim);
    const fragments = sim.rocks.filter(r => r !== sim.asteroid);
    fragments.forEach((rock, i) => Body.setPosition(rock.body, { x: -1500, y: i * 200 }));
    sim.step();
    const chip = fragments[0];
    const wall = sim.createRock([[{ x: -20, y: -100 }, { x: 20, y: -100 }, { x: 20, y: 100 }, { x: -20, y: 100 }]], { x: -800, y: 0 });
    Body.setStatic(wall.body, true);
    Body.setAngle(chip.body, .4);
    Body.setPosition(chip.body, { x: wall.body.bounds.max.x + chip.body.position.x - chip.body.bounds.min.x + 4, y: 0 });
    Body.setVelocity(chip.body, { x: -.2, y: 0 }); Body.setAngularVelocity(chip.body, .002);
    const takeCorrections = trackCollisionDisplacement(sim);
    let contacts = 0;
    Events.on(sim.engine, 'collisionStart', event => { contacts += event.pairs.filter(p => [p.collision.parentA, p.collision.parentB].includes(chip.body)).length; });
    for (let tick = 0; tick < 600; tick++) {
      sim.step();
      for (const correction of takeCorrections().values()) {
        const distance = Math.hypot(correction.x, correction.y);
        assert.ok(distance < .04, `seed ${seed}, tick ${tick}: contact shifted a body ${distance} units in one display update`);
      }
    }
    assert.ok(contacts > 0, `seed ${seed}: exercise real contacts after release`);
    sim.dispose();
  }
});

test('thrust and turning keep their acceleration over one second of simulation', () => {
  const sim = new Simulation(asteroid);
  Body.setPosition(sim.ship, { x: -2000, y: 0 });
  for (let tick = 0; tick < 120; tick++) sim.step(new Set(['KeyW']));
  near(Body.getVelocity(sim.ship).x * 60, 160, 1e-5);
  near(Body.getVelocity(sim.ship).y, 0, 1e-5);
  for (let tick = 0; tick < 120; tick++) sim.step(new Set(['KeyA']));
  near(Body.getAngularVelocity(sim.ship) * 60, 1.8, 1e-5);
  const velocity = Body.getVelocity(sim.ship), spin = Body.getAngularVelocity(sim.ship);
  for (let tick = 0; tick < 120; tick++) sim.step();
  near(Body.getVelocity(sim.ship).x, velocity.x);
  near(Body.getAngularVelocity(sim.ship), spin);
  sim.dispose();
});

test('every crack a blast opens is separating at release, against the parent and between siblings', () => {
  const opening = (sim, a, b, normal, point) => {
    const velocity = (rock, p) => {
      const v = Body.getVelocity(rock.body), w = Body.getAngularVelocity(rock.body), r = { x: p.x - rock.body.position.x, y: p.y - rock.body.position.y };
      return { x: v.x - w * r.y, y: v.y + w * r.x };
    };
    const va = velocity(a, point), vb = velocity(b, point);
    return ((va.x - vb.x) * normal.x + (va.y - vb.y) * normal.y) * 60;
  };
  let parentCracks = 0, siblingCracks = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed));
    sim.fire(); runToExplosion(sim);
    // Every rock keeps its outline in the original asteroid's coordinates,
    // so the cracks can be recovered from the new outlines themselves.
    const bodies = [sim.asteroid, ...sim.rocks.filter(r => r !== sim.asteroid)];
    const contacts = sharedBoundaries(bodies.map(r => r.shape));
    assert.ok(contacts.length > 0);
    for (const { a, b, normal, point } of contacts) {
      // The parent has not rotated, so local directions are world directions.
      const speed = opening(sim, bodies[a], bodies[b], normal, localToWorld(sim.asteroid, point));
      assert.ok(speed >= 1 - 1e-6, `seed ${seed}: a shared edge opens at ${speed} units/s`);
      if (a === 0 || b === 0) parentCracks++; else siblingCracks++;
    }
    sim.dispose();
  }
  assert.ok(parentCracks > 20 && siblingCracks > 20, 'exercise both kinds of crack');
});

test('fragments collide with their parent and siblings from the moment of release', () => {
  const sim = new Simulation(asteroid, randomGenerator(13));
  sim.fire(); runToExplosion(sim);
  const [a, b] = sim.rocks.filter(r => r !== sim.asteroid);
  let parentContact = false, siblingContact = false;
  Events.on(sim.engine, 'collisionStart', e => {
    const between = (x, y) => e.pairs.some(p => [p.collision.parentA, p.collision.parentB].includes(x.body) && [p.collision.parentA, p.collision.parentB].includes(y.body));
    parentContact ||= between(a, sim.asteroid); siblingContact ||= between(a, b);
  });
  // Push one piece back into the pocket and the other into it.
  Body.setVelocity(a.body, { x: 1, y: 0 }); Body.setVelocity(b.body, Body.getVelocity(sim.asteroid.body));
  for (let tick = 0; tick < 30 && !(parentContact && siblingContact); tick++) {
    Body.setPosition(b.body, { x: a.body.position.x - 1, y: a.body.position.y });
    sim.step();
  }
  assert.ok(parentContact, 'a piece pushed back into its source collides with it');
  assert.ok(siblingContact, 'siblings collide without waiting for a release phase');
  sim.dispose();
});

test('rocks never visibly overlap during release, tumbling, or later collisions', () => {
  const worldShape = rock => coordinates(rock.shape.map(ring => ring.map(p => localToWorld(rock, p))));
  let worst = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const sim = new Simulation(asteroid, randomGenerator(seed));
    // Later shots throw new chips into the debris of earlier ones.
    for (let shot = 0; shot < 3; shot++) {
      sim.fire();
      for (let tick = 0; tick < 400; tick++) {
        sim.step();
        if (tick % 5) continue;
        for (const [i, a] of sim.rocks.entries()) for (const b of sim.rocks.slice(i + 1)) {
          if (Math.hypot(a.body.position.x - b.body.position.x, a.body.position.y - b.body.position.y) > 300) continue;
          worst = Math.max(worst, clippedArea(globalThis.polyclip.intersection(worldShape(a), worldShape(b))));
        }
      }
    }
    sim.dispose();
  }
  // Colliders are inset by at most a quarter unit, so a hard contact may
  // show a hairline overlap along an edge, never one rock inside another.
  assert.ok(worst < 3, `worst visible overlap ${worst} square units`);
});

test('a piece split again in flight sends its children apart without overlapping its siblings', () => {
  const sim = new Simulation(asteroid, randomGenerator(5));
  sim.fire(); runToExplosion(sim);
  for (let tick = 0; tick < 120; tick++) sim.step();
  // Pick a piece whose path ahead is clear, then fire back along that path.
  const aimAt = rock => {
    const v = Body.getVelocity(rock.body), speed = Math.hypot(v.x, v.y), aim = { x: -v.x / speed, y: -v.y / speed };
    const from = { x: rock.body.position.x - aim.x * 160, y: rock.body.position.y - aim.y * 160 };
    return { aim, from, clear: sim.findHit(from, rock.body.position)?.entity === rock };
  };
  const fragment = sim.rocks.filter(r => r !== sim.asteroid && aimAt(r).clear).sort((a, b) => b.area - a.area)[0];
  assert.ok(fragment, 'some piece has a clear line of fire');
  const siblings = sim.rocks.filter(r => r !== sim.asteroid && r !== fragment);
  const { aim, from } = aimAt(fragment);
  Body.setPosition(sim.ship, from); Body.setVelocity(sim.ship, { x: 0, y: 0 });
  Body.setAngle(sim.ship, Math.atan2(-aim.x, aim.y)); Body.setAngularVelocity(sim.ship, 0);
  const before = new Set(sim.rocks);
  sim.fire(); runToExplosion(sim);
  assert.ok(!sim.rocks.includes(fragment), 'the later bullet splits the released target');
  const children = sim.rocks.filter(r => !before.has(r));
  assertPartition(fragment.shape, children.map(r => r.shape));
  const worldShape = rock => coordinates(rock.shape.map(ring => ring.map(p => localToWorld(rock, p))));
  for (let tick = 0; tick < 240; tick++) {
    sim.step();
    for (const child of children) for (const other of [...children, ...siblings]) {
      if (other === child || !sim.rocks.includes(other) || !sim.rocks.includes(child)) continue;
      assert.ok(clippedArea(globalThis.polyclip.intersection(worldShape(child), worldShape(other))) < 1, `tick ${tick}: children stay clear`);
    }
  }
  sim.dispose();
});

test('a complete small-rock split separates while conserving momentum without a retained parent', () => {
  const shape = [[{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: -40, y: 30 }]];
  const sim = new Simulation({ shape, area: shapeArea(shape) }, randomGenerator(4));
  sim.fire(); runToExplosion(sim);
  assert.equal(sim.lastBlast.mode, 'split'); assertMomentum(sim);
  const [a, b] = sim.rocks;
  const distance = Math.hypot(a.body.position.x - b.body.position.x, a.body.position.y - b.body.position.y);
  for (let i = 0; i < 360; i++) sim.step();
  assert.ok(Math.hypot(a.body.position.x - b.body.position.x, a.body.position.y - b.body.position.y) > distance + 10);
  sim.dispose();
});

test('repeated excavation stays finite without displacement bursts during release', () => {
  const sim = new Simulation(asteroid, randomGenerator(7));
  const takeCorrections = trackCollisionDisplacement(sim);
  function stepWithoutJumps() {
    sim.step();
    for (const correction of takeCorrections().values()) {
      const distance = Math.hypot(correction.x, correction.y);
      assert.ok(distance < .04, `repeated impacts: contact shifted a body ${distance} units in one display update`);
    }
  }
  for (let shot = 0; shot < 24; shot++) {
    const target = sim.asteroid.body.position, angle = Math.PI + shot * .65;
    Body.setPosition(sim.ship, { x: target.x + Math.cos(angle) * 620, y: target.y + Math.sin(angle) * 620 });
    Body.setVelocity(sim.ship, { x: 0, y: 0 }); Body.setAngularVelocity(sim.ship, 0); Body.setAngle(sim.ship, angle + Math.PI / 2);
    const before = sim.explosions;
    sim.fire();
    for (let i = 0; i < 500 && sim.explosions === before; i++) stepWithoutJumps();
    assert.ok(sim.explosions > before, 'a repeated shot must drill and explode');
    if (sim.lastBlast.mode !== 'none') assert.ok(sim.lastBlast.count >= 2 && sim.lastBlast.count <= 4);
    for (let i = 0; i < 40; i++) stepWithoutJumps();
    // Repeated clipping rounds coordinates at 1e-9; accumulated area error
    // is checked relative to the original area rather than one single cut.
    near(totalRockArea(sim), asteroid.area, asteroid.area * 1e-9);
    for (const r of sim.rocks) for (const value of [r.body.position.x, r.body.position.y, r.body.angle, r.body.velocity.x, r.body.velocity.y, r.body.inertia]) assert.ok(Number.isFinite(value));
  }
  assert.ok(sim.retainedArea < asteroid.area * .98);
  sim.dispose();
});

test('rotating rock preserves world placement, inherited motion, and angular momentum at fracture', () => {
  const sim = new Simulation(asteroid, randomGenerator(19));
  Body.setAngle(sim.asteroid.body, .8); Body.setAngularVelocity(sim.asteroid.body, .001); Body.setVelocity(sim.asteroid.body, { x: .1, y: -.05 });
  sim.fire();
  for (let i = 0; i < 500 && !sim.explosions; i++) {
    const original = sim.asteroid, originalBody = original.body;
    sim.step();
    if (sim.explosions) {
      const velocity = Body.getVelocity(originalBody);
      assertMomentum(sim, { x: originalBody.mass * velocity.x, y: originalBody.mass * velocity.y, angular: originalBody.inertia * Body.getAngularVelocity(originalBody) + originalBody.mass * (originalBody.position.x * velocity.y - originalBody.position.y * velocity.x) });
      for (const rock of sim.rocks) for (const point of rock.shape.flat()) {
        const world = localToWorld(rock, point), expected = localToWorld(original, point);
        near(world.x, expected.x); near(world.y, expected.y);
      }
    }
  }
  assert.equal(sim.explosions, 1); sim.dispose();
});

test('pending fracture work leaves physics running and commits at the moving parent current pose', async () => {
  let request, finish;
  const sim = new Simulation(asteroid, randomGenerator(21), input => {
    request = input;
    return new Promise(resolve => { finish = resolve; });
  });
  sim.fire();
  for (let i = 0; i < 200; i++) sim.step();
  assert.ok(request, 'prepare geometry while the bullet drills');
  assert.equal(sim.explosions, 0);
  near(sim.bullets[0].traveled, sim.bullets[0].depth);
  const parent = sim.asteroid;
  Body.setVelocity(parent.body, { x: .3, y: -.1 });
  Body.setAngularVelocity(parent.body, .002);
  const shipBefore = { ...sim.ship.position }, rockBefore = { ...parent.body.position };
  const shipVelocity = Body.getVelocity(sim.ship);
  for (let i = 0; i < 120; i++) sim.step();
  near(sim.ship.position.x - shipBefore.x, shipVelocity.x * 60);
  near(parent.body.position.x - rockBefore.x, 18);
  near(parent.body.position.y - rockBefore.y, -6);
  const result = prepareFracture(request, randomGenerator(request.seed));
  finish(structuredClone(result));
  await Promise.resolve();
  assert.equal(sim.asteroid, parent, 'worker completion must not mutate the physics world');
  sim.step();
  assert.equal(sim.explosions, 1);
  assert.notEqual(sim.asteroid, parent);
  for (const rock of sim.rocks) for (const point of rock.shape.flat()) {
    const world = localToWorld(rock, point), expected = localToWorld(parent, point);
    near(world.x, expected.x); near(world.y, expected.y);
  }
  near(totalRockArea(sim), asteroid.area, 1e-5);
  const v = Body.getVelocity(parent.body);
  assertMomentum(sim, { x: parent.body.mass * v.x, y: parent.body.mass * v.y, angular: parent.body.inertia * Body.getAngularVelocity(parent.body) + parent.body.mass * (parent.body.position.x * v.y - parent.body.position.y * v.x) });
  sim.dispose();
});

test('a second drilling round discards geometry prepared for the replaced parent', async () => {
  const jobs = [];
  const sim = new Simulation(asteroid, randomGenerator(9), request => new Promise(resolve => jobs.push({ request, resolve })));
  sim.fire();
  for (let i = 0; i < 200; i++) sim.step();
  Body.setPosition(sim.ship, { x: 800, y: 30 });
  Body.setAngle(sim.ship, Math.PI / 2);
  Body.setVelocity(sim.ship, { x: 0, y: 0 });
  sim.fire();
  for (let i = 0; i < 200; i++) sim.step();
  assert.equal(jobs.length, 2);
  const oldSecondPlan = prepareFracture(jobs[1].request, randomGenerator(jobs[1].request.seed));
  jobs[0].resolve(prepareFracture(jobs[0].request, randomGenerator(jobs[0].request.seed)));
  await Promise.resolve();
  sim.step();
  assert.equal(sim.explosions, 1); assert.equal(jobs.length, 3);
  const parent = sim.asteroid;
  jobs[1].resolve(oldSecondPlan);
  await Promise.resolve();
  sim.step();
  assert.equal(sim.explosions, 1); assert.equal(sim.asteroid, parent);
  jobs[2].resolve(prepareFracture(jobs[2].request, randomGenerator(jobs[2].request.seed)));
  await Promise.resolve();
  runToExplosion(sim);
  assert.equal(sim.explosions, 2);
  near(totalRockArea(sim), asteroid.area, 1e-5);
  sim.dispose();
});

test('failed asynchronous geometry surfaces an error without replacing the rock', async () => {
  const failure = new Error('Geometry worker unavailable');
  const sim = new Simulation(asteroid, randomGenerator(2), () => Promise.reject(failure));
  const parent = sim.asteroid;
  sim.fire();
  for (let i = 0; i < 200 && !sim.bullets[0]?.plan; i++) sim.step();
  await Promise.resolve();
  assert.throws(() => { for (let i = 0; i < 100; i++) sim.step(); }, error => error === failure);
  assert.equal(sim.asteroid, parent); assert.equal(sim.explosions, 0);
  near(totalRockArea(sim), asteroid.area);
  sim.dispose();
});

test('the ship collides with the asteroid rather than passing through', () => {
  const sim = new Simulation(asteroid); Body.setVelocity(sim.ship, { x: 4, y: 0 });
  let collided = false;
  Events.on(sim.engine, 'collisionStart', event => { collided ||= event.pairs.some(p => p.bodyA.parent === sim.ship || p.bodyB.parent === sim.ship); });
  for (let i = 0; i < 220 && !collided; i++) sim.step();
  assert.ok(collided); assert.ok(sim.ship.velocity.x < 3); sim.dispose();
});

test('a physical hole stays empty for both bullets and collision geometry', () => {
  const shape = [[{ x: -80, y: -80 }, { x: 80, y: -80 }, { x: 80, y: 80 }, { x: -80, y: 80 }], [{ x: -45, y: -45 }, { x: -45, y: 45 }, { x: 45, y: 45 }, { x: 45, y: -45 }]];
  const sim = new Simulation({ shape, area: shapeArea(shape) });
  Body.setPosition(sim.ship, sim.asteroid.body.position);
  let collided = false; Events.on(sim.engine, 'collisionStart', () => { collided = true; });
  for (let i = 0; i < 10; i++) sim.step();
  assert.equal(collided, false);
  const from = localToWorld(sim.asteroid, { x: -20, y: 0 }), to = localToWorld(sim.asteroid, { x: 20, y: 0 });
  assert.equal(sim.findHit(from, to), null);
  near(worldToLocal(sim.asteroid, from).x, -20);
  const detached = sim.createRock(shape, { x: -700, y: 0 }, .6, null, true);
  for (const part of detached.body.parts.slice(1)) for (const vertex of part.vertices) {
    assert.ok(contains(shape, worldToLocal(detached, vertex)), 'inset collision edges stay inside material around the hole');
  }
  Body.setPosition(sim.ship, detached.body.position);
  for (let i = 0; i < 10; i++) sim.step();
  assert.equal(collided, false, 'the inset collider keeps the hole empty too');
  sim.dispose();
});
