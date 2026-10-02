import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.polyclip = require('../vendor/polyclip.min.js');
const { shapeArea, contains } = await import('../fracture.js');

test('the real worker returns complete, complementary rendering and collision geometry', async t => {
  // Node needs an adapter for the browser worker's message API and UMD library.
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.polyclip = require(${JSON.stringify(new URL('../vendor/polyclip.min.js', import.meta.url).pathname)});
    globalThis.self = { postMessage: message => parentPort.postMessage(message) };
    import(${JSON.stringify(new URL('../fracture-worker.js', import.meta.url).href)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
    }).catch(error => { throw error; });
  `, { eval: true });
  t.after(() => worker.terminate());
  const shape = [[{ x: -250, y: -200 }, { x: 250, y: -200 }, { x: 250, y: 200 }, { x: -250, y: 200 }]];
  const response = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  worker.postMessage({ id: 7, request: { shape, entry: { x: 0, y: -200 }, center: { x: 0, y: -174 }, direction: { x: 0, y: 1 }, detached: false, seed: 12 } });
  const { id, result, error } = await response;
  assert.equal(error, undefined); assert.equal(id, 7); assert.equal(result.mode, 'chip');
  assert.ok(result.fragments.length >= 2 && result.fragments.length <= 4);
  const pieces = [...result.retained, ...result.fragments];
  assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + shapeArea(piece.shape), 0) - shapeArea(shape)) < 1e-5);
  for (const { shape, geometry } of pieces) {
    assert.ok(Math.abs(geometry.triangles.reduce((sum, triangle) => sum + shapeArea([triangle]), 0) - shapeArea(shape)) < 1e-5);
    assert.ok(geometry.parts.length > 0);
    for (const { polygon } of geometry.parts) for (const point of polygon) assert.ok(contains(shape, point));
  }
});
