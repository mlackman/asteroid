import './vendor/polyclip.min.js';
import { randomGenerator } from './fracture.js?v=20261004';
import { prepareFracture } from './rock-geometry.js?v=20261004';

self.onmessage = ({ data: { id, request } }) => {
  try {
    const result = prepareFracture(request, randomGenerator(request.seed));
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
