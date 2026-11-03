import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayGuard } from '../cloudflare/replay-guard.js';
class MockStorage {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); }
  async transaction(callback) {
    const previous = this.tail; let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback({
      get: async (key) => this.data.get(key),
      put: async (key, value) => this.data.set(key, value),
    }); } finally { release(); }
  }
  async setAlarm(_timestamp) {}
  async deleteAll() { this.data.clear(); }
}
function makeGuard() { const storage = new MockStorage(); return { guard: new ReplayGuard({ storage }), storage }; }
const future = () => Math.floor(Date.now() / 1000) + 300;

test('accepts a valid unused jti once', async () => {
  const { guard } = makeGuard();
  const response = await guard.fetch(new Request('https://do/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jti: 'jti-valid-1', exp: future() }) }));
  assert.equal(response.status, 201);
});
test('rejects repeated jti with 409', async () => {
  const { guard } = makeGuard(); const body = JSON.stringify({ jti: 'jti-repeat-1', exp: future() });
  const request = () => guard.fetch(new Request('https://do/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  assert.equal((await request()).status, 201); assert.equal((await request()).status, 409);
});
test('concurrent same-jti requests yield exactly one 201 and one 409', async () => {
  const { guard } = makeGuard(); const body = JSON.stringify({ jti: 'jti-race-1', exp: future() });
  const request = () => guard.fetch(new Request('https://do/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  const statuses = await Promise.all([request(), request()]).then((rs) => rs.map((r) => r.status).sort());
  assert.deepEqual(statuses, [201, 409]);
});
test('rejects expired claims', async () => {
  const { guard } = makeGuard();
  const response = await guard.fetch(new Request('https://do/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jti: 'jti-expired-1', exp: Math.floor(Date.now() / 1000) - 5 }) }));
  assert.equal(response.status, 400);
});
test('clears consumed state on expiry alarm', async () => {
  const { guard, storage } = makeGuard(); await storage.transaction((tx) => tx.put('consumed', future()));
  await guard.alarm(); assert.equal(storage.data.size, 0);
});