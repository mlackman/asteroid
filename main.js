import * as THREE from './vendor/three.module.js';
import { makeAsteroid, randomGenerator, onSegment, rotate, triangulate } from './fracture.js?v=20261004';
import { Simulation, STEP } from './physics.js?v=20261004';
import { FracturePlanner } from './fracture-planner.js?v=20261004';
import { Game, payout, stepGame } from './game.js?v=20261004';
import { placeOre } from './ore.js?v=20261004';
import { ORE, STATION, POLES, DEBUG } from './config.js?v=20261004';
import { updateHud, showEvent, describeBlast } from './hud.js?v=20261004';

const status = document.querySelector('#status');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (error) {
  status.textContent = 'This demo needs a browser with WebGL enabled.';
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x060b12);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-800, 800, 450, -450, .1, 100);
camera.position.z = 20;
const rockMaterial = new THREE.MeshBasicMaterial({ map: createRockTexture(), color: 0xffffff });
const borderMaterial = new THREE.LineBasicMaterial({ color: 0xadc1c9, transparent: true, opacity: .45 });
const oreMaterial = new THREE.MeshBasicMaterial({ color: 0xd8a93f });
const oreEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xffe7a1 });
// Debug view of buried ore, drawn over the rock.
const hiddenOreMaterial = new THREE.MeshBasicMaterial({ color: 0xff5fd2, transparent: true, opacity: .35, depthTest: false });
const hiddenOreEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xff8fe0, depthTest: false });
const cutMaterial = new THREE.LineBasicMaterial({ color: 0x59efb9, transparent: true, opacity: .9, depthTest: false });
const rockVisuals = new Map();
let simulation, fracturePlanner, paused = false, showCuts = false, showOre = DEBUG.showOre, followShip = false, zoom = 1, accumulator = 0, last = 0;
const game = new Game();
let blastSerial = 0, grabSerial = 0, telemetryTime = 0;
const keys = new Set(), particles = [], flashes = [];
const rockLayer = new THREE.Group(); scene.add(rockLayer);

function createRockTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d'), random = randomGenerator(3921);
  ctx.fillStyle = '#697478'; ctx.fillRect(0, 0, 1024, 1024);
  // Multiscale mineral grain remains in original asteroid coordinates after
  // fracture, so its texture also fits back together with the actual polygons.
  for (const size of [128, 64, 32, 16, 8, 3]) {
    for (let y = 0; y < 1024; y += size) for (let x = 0; x < 1024; x += size) {
      ctx.fillStyle = random() < .5 ? `rgba(5,10,16,${random() * .13})` : `rgba(202,210,197,${random() * .1})`;
      ctx.fillRect(x, y, size + 1, size + 1);
    }
  }
  for (let i = 0; i < 115; i++) {
    const x = random() * 1024, y = random() * 1024, r = 6 + random() ** 2 * 85;
    const shadow = ctx.createRadialGradient(x + r * .15, y + r * .18, r * .08, x, y, r);
    shadow.addColorStop(0, '#18262b94'); shadow.addColorStop(.64, '#21303470'); shadow.addColorStop(.85, '#14202795'); shadow.addColorStop(1, '#a8b2aa00');
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#bac1b34b'; ctx.lineWidth = 1 + r / 25;
    ctx.beginPath(); ctx.arc(x - 1, y - 1, r * .91, Math.PI * .95, Math.PI * 1.7); ctx.stroke();
  }
  const shade = ctx.createLinearGradient(0, 0, 1024, 1024);
  shade.addColorStop(0, '#dce1c63a'); shade.addColorStop(.5, '#26374310'); shade.addColorStop(1, '#020811c9');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, 1024, 1024);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function createRockVisual(entity) {
  const group = new THREE.Group(), content = new THREE.Group();
  content.position.set(-entity.pivot.x, -entity.pivot.y, 0); group.add(content);
  const positions = [], uvs = [];
  for (const triangle of entity.triangles) for (const p of triangle) {
    positions.push(p.x, p.y, 0); uvs.push((p.x + 360) / 720, (p.y + 360) / 720);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  content.add(new THREE.Mesh(geometry, rockMaterial));
  const boundary = [], cuts = [], original = simulation.originalShape[0];
  for (const ring of entity.shape) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    boundary.push(a.x, a.y, .2, b.x, b.y, .2);
    if (!original.some((p, j) => onSegment(a, p, original[(j + 1) % original.length], 1e-5) && onSegment(b, p, original[(j + 1) % original.length], 1e-5))) {
      cuts.push(a.x, a.y, .3, b.x, b.y, .3);
    }
  }
  const edgeGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(boundary, 3));
  content.add(new THREE.LineSegments(edgeGeometry, borderMaterial));
  const cutGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(cuts, 3));
  const cutLines = new THREE.LineSegments(cutGeometry, cutMaterial); cutLines.visible = showCuts; cutLines.renderOrder = 1; content.add(cutLines);
  // Ore stays hidden inside the rock until enough of it has been exposed.
  // The debug view draws buried nuggets too.
  const oreGeometries = [], hiddenOre = new THREE.Group();
  hiddenOre.visible = showOre; hiddenOre.renderOrder = 2; content.add(hiddenOre);
  for (const ore of entity.ores) {
    const fill = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(triangulate(ore.shape).flat().flatMap(p => [p.x, p.y, .25]), 3));
    const edge = new THREE.BufferGeometry().setFromPoints(ore.shape[0].map(p => new THREE.Vector3(p.x, p.y, .35)));
    if (ore.revealed) content.add(new THREE.Mesh(fill, oreMaterial), new THREE.LineLoop(edge, oreEdgeMaterial));
    else hiddenOre.add(new THREE.Mesh(fill, hiddenOreMaterial), new THREE.LineLoop(edge, hiddenOreEdgeMaterial));
    oreGeometries.push(fill, edge);
  }
  rockLayer.add(group);
  rockVisuals.set(entity, { group, geometry, cutLines, edgeGeometry, cutGeometry, oreGeometries, hiddenOre });
}
function removeRockVisual(entity, visual) {
  rockLayer.remove(visual.group); visual.geometry.dispose(); visual.edgeGeometry.dispose(); visual.cutGeometry.dispose();
  for (const geometry of visual.oreGeometries) geometry.dispose();
  rockVisuals.delete(entity);
}
function clearRockVisuals() {
  for (const [entity, visual] of rockVisuals) removeRockVisual(entity, visual);
}
function syncRocks() {
  const existing = new Set(simulation.rocks);
  for (const [entity, visual] of rockVisuals) if (!existing.has(entity)) {
    removeRockVisual(entity, visual);
  }
  for (const entity of simulation.rocks) {
    if (!rockVisuals.has(entity)) createRockVisual(entity);
    const visual = rockVisuals.get(entity);
    visual.group.position.set(entity.body.position.x, entity.body.position.y, 0);
    visual.group.rotation.z = entity.body.angle;
  }
}

// The station is a docking ring: arrive slowly inside it to sell and refuel.
const stationVisual = new THREE.Group(); scene.add(stationVisual);
stationVisual.position.set(STATION.position.x, STATION.position.y, -1);
stationVisual.add(new THREE.Mesh(new THREE.RingGeometry(STATION.radius - 1.5, STATION.radius, 96), new THREE.MeshBasicMaterial({ color: 0x5fd0b0, transparent: true, opacity: .55 })));
stationVisual.add(new THREE.Mesh(new THREE.RingGeometry(10, 14, 6), new THREE.MeshBasicMaterial({ color: 0x9df0d3 })));

// The ship is an actual open V: two narrow wings meet at the firing tip.
const shipVisual = new THREE.Group(); scene.add(shipVisual);
// Drawn in ship coordinates; the group is offset by the center of mass, which
// moves when the ship holds something.
const shipFrame = new THREE.Group(); shipVisual.add(shipFrame);
const shipShape = new THREE.Shape();
shipShape.moveTo(-13, -15); shipShape.lineTo(0, 20); shipShape.lineTo(13, -15); shipShape.lineTo(0, -6); shipShape.closePath();
const shipMesh = new THREE.Mesh(new THREE.ShapeGeometry(shipShape), new THREE.MeshBasicMaterial({ color: 0x142f3b }));
shipFrame.add(shipMesh);
const shipOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-13, -15, .1), new THREE.Vector3(0, 20, .1), new THREE.Vector3(13, -15, .1), new THREE.Vector3(0, -6, .1)
]), new THREE.LineBasicMaterial({ color: 0xadf8e2 }));
shipFrame.add(shipOutline);
const flameShape = new THREE.Shape(); flameShape.moveTo(-4, -7); flameShape.lineTo(0, -30); flameShape.lineTo(4, -7); flameShape.closePath();
const flame = new THREE.Mesh(new THREE.ShapeGeometry(flameShape), new THREE.MeshBasicMaterial({ color: 0x91efd4, transparent: true, opacity: .7 }));
shipFrame.add(flame);
const engineGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x84eaca, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
engineGlow.position.set(0, -12, .3); engineGlow.scale.set(32, 32, 1); shipFrame.add(engineGlow);
const poleMaterial = new THREE.LineBasicMaterial({ color: 0xc9d6dd });
const poleLines = [-1, 1].map(() => {
  const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)), poleMaterial);
  line.frustumCulled = false; shipFrame.add(line);
  return line;
});
function syncPoles() {
  simulation.poles.forEach((pole, i) => {
    const line = poleLines[i], mount = simulation.poleTip(pole, 0), tip = simulation.poleTip(pole);
    line.visible = pole.extension > 0;
    line.geometry.attributes.position.array.set([mount.x, mount.y, .2, tip.x, tip.y, .2]);
    line.geometry.attributes.position.needsUpdate = true;
  });
}
function glowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(.12, '#ffffffc0'); gradient.addColorStop(.4, '#ffffff20'); gradient.addColorStop(1, '#ffffff00');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
const pointGeometry = new THREE.BufferGeometry();
const pointPositions = new Float32Array(6000), pointColors = new Float32Array(6000);
pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3).setUsage(THREE.DynamicDrawUsage));
pointGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3).setUsage(THREE.DynamicDrawUsage));
const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
points.frustumCulled = false; scene.add(points);
const bulletGeometry = new THREE.BufferGeometry(), bulletPositions = new Float32Array(100 * 6);
bulletGeometry.setAttribute('position', new THREE.BufferAttribute(bulletPositions, 3).setUsage(THREE.DynamicDrawUsage));
const bulletLines = new THREE.LineSegments(bulletGeometry, new THREE.LineBasicMaterial({ color: 0xffd7a2 }));
bulletLines.frustumCulled = false; scene.add(bulletLines);

const starPositions = [], starColors = [], starRandom = randomGenerator(4197);
for (let i = 0; i < 3200; i++) {
  starPositions.push((starRandom() - .5) * 10000, (starRandom() - .5) * 10000, -5);
  const light = .16 + starRandom() ** 3 * .55;
  starColors.push(light * .8, light * .9, light);
}
const starGeometry = new THREE.BufferGeometry(); starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3)); starGeometry.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true })); scene.add(stars);
const gridVertices = [];
for (let x = -5000; x <= 5000; x += 120) gridVertices.push(x, -5000, -6, x, 5000, -6);
for (let y = -5000; y <= 5000; y += 120) gridVertices.push(-5000, y, -6, 5000, y, -6);
const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gridVertices, 3)), new THREE.LineBasicMaterial({ color: 0x365363, transparent: true, opacity: .095 })); scene.add(grid);

function blastEffect(blast) {
  for (let i = 0; i < 85; i++) {
    const angle = Math.random() * Math.PI * 2, speed = 20 + Math.random() * 140;
    particles.push({ x: blast.center.x, y: blast.center.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .3 + Math.random() * .8, maxLife: 1.1, warm: true });
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(.91, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffc18a, transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false }));
  ring.position.set(blast.center.x, blast.center.y, 2); scene.add(ring);
  flashes.push({ ring, age: 0 });
  showEvent(describeBlast(blast, simulation.explosions));
}
function effects(dt) {
  let count = 0;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (count >= 2000) continue;
    const alpha = Math.min(1, p.life / p.maxLife);
    pointPositions.set([p.x, p.y, 2], count * 3);
    pointColors.set(p.warm ? [alpha, alpha * .63, alpha * .3] : [alpha * .35, alpha * .9, alpha * .74], count * 3);
    count++;
  }
  pointGeometry.setDrawRange(0, count); pointGeometry.attributes.position.needsUpdate = true; pointGeometry.attributes.color.needsUpdate = true;
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]; f.age += dt; f.ring.scale.setScalar(4 + f.age * 125); f.ring.material.opacity = Math.max(0, .65 * (1 - f.age / .5));
    if (f.age > .5) { scene.remove(f.ring); f.ring.geometry.dispose(); f.ring.material.dispose(); flashes.splice(i, 1); }
  }
}
function syncBullets() {
  let count = 0;
  for (const bullet of simulation.bullets) {
    if (count >= 100) break;
    const direction = bullet.state === 'flying' ? bullet.velocity : rotate(bullet.direction, bullet.entity.body.angle);
    const size = Math.hypot(direction.x, direction.y) || 1;
    const tail = bullet.state === 'drilling' ? 3 : 12;
    bulletPositions.set([bullet.position.x, bullet.position.y, 3, bullet.position.x - direction.x / size * tail, bullet.position.y - direction.y / size * tail, 3], count * 6);
    count++;
  }
  bulletGeometry.setDrawRange(0, count * 2); bulletGeometry.attributes.position.needsUpdate = true;
}
function reset() {
  if (simulation) simulation.dispose();
  if (fracturePlanner) fracturePlanner.dispose();
  clearRockVisuals();
  fracturePlanner = new FracturePlanner();
  const asteroid = makeAsteroid();
  asteroid.ores = placeOre(asteroid.shape, randomGenerator(Math.floor(Math.random() * 4294967296)));
  simulation = new Simulation(asteroid, Math.random, request => fracturePlanner.prepare(request));
  particles.length = 0;
  for (const f of flashes) { scene.remove(f.ring); f.ring.geometry.dispose(); f.ring.material.dispose(); } flashes.length = 0;
  blastSerial = 0; grabSerial = 0; accumulator = 0; keys.clear(); game.newRun();
  paused = false; updatePauseButton(); camera.position.set(-70, 0, 20);
  showEvent('READY · Point the bow at the surface and fire.');
  syncRocks(); syncBullets(); updateHud(game, simulation);
  status.hidden = true;
}
const cargoItem = rock => ({ oreArea: rock.oreArea, rockArea: rock.rockArea < ORE.cleanTolerance ? 0 : rock.rockArea });
function describePiece(rock) {
  if (!rock.ores.length) return `${rock.area.toFixed(0)} m² rock · no ore`;
  const item = cargoItem(rock);
  return `${item.oreArea.toFixed(0)} m² ore${item.rockArea ? ` + ${item.rockArea.toFixed(0)} m² rock` : ' · clean'} · worth ${payout(item).toFixed(0)} CR`;
}
// E: extend the poles, or retract them. Retracting stows small ore-bearing
// pieces in the hold; anything else stays on its pole.
function togglePoles() {
  if (!simulation.polesOut) { simulation.extendPoles(); showEvent('POLES OUT · Touch a piece with a pole tip to grab it.'); return; }
  const stowed = [], kept = [];
  for (const rock of simulation.held) {
    if (!rock.ores.length) kept.push('no ore, release it with Q');
    else if (rock.area > POLES.stowMaxArea) kept.push('too big to stow, carry it to the station');
    else if (!game.collect(cargoItem(rock))) kept.push('hold full');
    else { stowed.push(cargoItem(rock)); simulation.removeRock(rock); }
  }
  simulation.retractPoles();
  const parts = [];
  if (stowed.length) parts.push(`STOWED · ${stowed.reduce((sum, item) => sum + item.oreArea, 0).toFixed(0)} m² ore`);
  if (kept.length) parts.push(`HELD · ${kept.join(' · ')}`);
  showEvent(parts.length ? parts.join(' · ') : 'POLES IN');
}
function releasePoles() {
  if (!simulation.held.length) return;
  simulation.releaseAll();
  showEvent('RELEASED');
}
// Dock slowly inside the ring: sell the hold and the ore carried on the poles.
function dock() {
  const ship = simulation.ship, carried = simulation.held.filter(rock => rock.ores.length);
  const distance = Math.hypot(ship.position.x - STATION.position.x, ship.position.y - STATION.position.y);
  const sale = game.updateDocking(distance, Math.hypot(ship.velocity.x, ship.velocity.y) * 60, carried.map(cargoItem));
  if (!sale) return;
  for (const rock of carried) simulation.removeRock(rock);
  showEvent(sale.items ? `DOCKED · Sold ${sale.items} ${sale.items === 1 ? 'piece' : 'pieces'} for ${sale.credits.toFixed(0)} CR · refuelled and rearmed` : 'DOCKED · Refuelled and rearmed');
}
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  const h = Math.max(850, 1350 / (innerWidth / innerHeight)) / zoom;
  camera.left = -h * innerWidth / innerHeight / 2; camera.right = -camera.left;
  camera.top = h / 2; camera.bottom = -h / 2; camera.updateProjectionMatrix();
}
function updatePauseButton() {
  const button = document.querySelector('#pause'); button.textContent = paused ? 'RESUME' : 'PAUSE'; button.setAttribute('aria-pressed', String(paused));
}
function togglePause() { paused = !paused; accumulator = 0; keys.clear(); updatePauseButton(); }
window.addEventListener('resize', resize);
window.addEventListener('keydown', event => {
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyP', 'KeyE', 'KeyQ'].includes(event.code)) event.preventDefault();
  if (event.code === 'KeyR' && !event.repeat) reset();
  else if (event.code === 'KeyP' && !event.repeat) togglePause();
  else if (event.code === 'KeyE' && !event.repeat && !paused) togglePoles();
  else if (event.code === 'KeyQ' && !event.repeat && !paused) releasePoles();
  else if (event.code === 'Space' && !event.repeat && !paused) {
    if (game.tryFire()) simulation.fire();
    keys.add(event.code);
  }
  else keys.add(event.code);
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { keys.clear(); accumulator = 0; last = 0; });
window.addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(.35, Math.min(2, zoom * Math.exp(-event.deltaY * .001))); resize(); }, { passive: false });
document.querySelector('#reset').addEventListener('click', event => { reset(); event.currentTarget.blur(); });
document.querySelector('#pause').addEventListener('click', event => { togglePause(); event.currentTarget.blur(); });
const oreButton = document.querySelector('#ore');
oreButton.setAttribute('aria-pressed', String(showOre));
oreButton.addEventListener('click', event => {
  showOre = !showOre; event.currentTarget.setAttribute('aria-pressed', String(showOre));
  for (const visual of rockVisuals.values()) visual.hiddenOre.visible = showOre;
  event.currentTarget.blur();
});
document.querySelector('#cuts').addEventListener('click', event => {
  showCuts = !showCuts; event.currentTarget.setAttribute('aria-pressed', String(showCuts));
  for (const visual of rockVisuals.values()) visual.cutLines.visible = showCuts;
  event.currentTarget.blur();
});
document.querySelector('#follow').addEventListener('click', event => {
  followShip = !followShip;
  event.currentTarget.setAttribute('aria-pressed', String(followShip));
  if (!followShip) camera.position.set(-70, 0, 20);
  event.currentTarget.blur();
});
function frame(time) {
  requestAnimationFrame(frame);
  const dt = last ? Math.min((time - last) / 1000, .05) : 0; last = time;
  if (!paused) {
    accumulator += dt * 1000;
    while (accumulator >= STEP) {
      try {
        stepGame(game, simulation, keys, STEP / 1000);
      } catch (error) {
        paused = true; updatePauseButton();
        status.textContent = `Fracture calculation failed: ${error.message}`;
        status.hidden = false;
        accumulator = 0;
        break;
      }
      if (simulation.explosions > blastSerial) { blastSerial = simulation.explosions; blastEffect(simulation.lastBlast); }
      if (simulation.grabs > grabSerial) { grabSerial = simulation.grabs; showEvent(`GRABBED · ${describePiece(simulation.lastGrab)}`); }
      accumulator -= STEP;
    }
    if (game.thrusting && Math.random() < dt * 90) {
      const dir = new THREE.Vector2(0, -1).rotateAround(new THREE.Vector2(), simulation.ship.angle);
      const engine = simulation.shipToWorld({ x: 0, y: -12 });
      particles.push({ x: engine.x, y: engine.y, vx: dir.x * 80 + simulation.ship.velocity.x * 60, vy: dir.y * 80 + simulation.ship.velocity.y * 60, life: .35, maxLife: .35, warm: false });
    }
    effects(dt);
    dock();
  }
  syncRocks(); syncBullets();
  shipVisual.position.set(simulation.ship.position.x, simulation.ship.position.y, 2);
  shipVisual.rotation.z = simulation.ship.angle;
  shipFrame.position.set(-simulation.shipPivot.x, -simulation.shipPivot.y, 0);
  syncPoles();
  flame.visible = engineGlow.visible = game.thrusting && !paused;
  flame.scale.y = .8 + Math.random() * .4;
  // A fixed world view makes constant-velocity drift visible. Optional follow
  // tracks directly; easing would make coasting pieces appear to speed up/slow down.
  if (followShip && !paused) {
    camera.position.x = simulation.ship.position.x + 270;
    camera.position.y = simulation.ship.position.y;
  }
  grid.position.set(Math.round(camera.position.x / 120) * 120, Math.round(camera.position.y / 120) * 120, 0);
  telemetryTime += dt;
  if (telemetryTime > .1) { telemetryTime = 0; updateHud(game, simulation); }
  renderer.render(scene, camera);
}
resize(); reset(); requestAnimationFrame(frame);
