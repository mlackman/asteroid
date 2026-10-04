export class FracturePlanner {
  constructor() {
    this.worker = new Worker(new URL('./fracture-worker.js?v=20261004', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 0;
    this.worker.onmessage = ({ data: { id, result, error } }) => {
      const job = this.pending.get(id);
      if (!job) return;
      this.pending.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    };
    this.worker.onerror = event => {
      this.error = new Error(event.message || 'Fracture worker failed');
      for (const job of this.pending.values()) job.reject(this.error);
      this.pending.clear();
    };
  }
  prepare(request) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request });
    });
  }
  dispose() {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new Error('Fracture planner disposed'));
    this.pending.clear();
  }
}
