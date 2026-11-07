import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReplayGuard } from '../cloudflare/replay-guard.js';

class MockStorage {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); }
  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback({
        get: async (key) => this.data.get(key),
        put: async (key, value) => this.data.set(key, value),
      });
    } finally { release(); }
  }
  async setAlarm(_timestamp) {}
  async deleteAll() { this.data.clear(); }
}

function makeGuard() {
  const storage = new MockStorage();
  return { guard: new ReplayGuard({ storage }), storage };
}
const future = () => Math.floor(Date.now() / 1000) + 300;

test('declares a SQLite ReplayGuard migration and an isolated Preview binding', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  expect(config.migrations).toContainEqual({
    tag: 'replayguard-v1',
    new_sqlite_classes: ['ReplayGuard'],
  });
  expect(config.durable_objects.bindings).toContainEqual({
    name: 'REPLAY_GUARD',
    class_name: 'ReplayGuard',
  });
  expect(config.previews.durable_objects.bindings).toContainEqual({
    name: 'REPLAY_GUARD',
    class_name: 'ReplayGuard',
  });
});

test('accepts a valid unused jti once', async () => {
  const { guard } = makeGuard();
  const response = await guard.fetch(new Request('https://do/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jti: 'jti-valid-1', exp: future() }),
  }));
  expect(response.status).toBe(201);
});

test('rejects repeated jti with 409', async () => {
  const { guard } = makeGuard();
  const body = JSON.stringify({ jti: 'jti-repeat-1', exp: future() });
  const request = () => guard.fetch(new Request('https://do/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }));
  expect((await request()).status).toBe(201);
  expect((await request()).status).toBe(409);
});

test('concurrent same-jti requests yield exactly one 201 and one 409', async () => {
  const { guard } = makeGuard();
  const body = JSON.stringify({ jti: 'jti-race-1', exp: future() });
  const request = () => guard.fetch(new Request('https://do/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }));
  const statuses = await Promise.all([request(), request()]).then((responses) => responses.map((r) => r.status).sort());
  expect(statuses).toEqual([201, 409]);
});

test('rejects expired claims', async () => {
  const { guard } = makeGuard();
  const response = await guard.fetch(new Request('https://do/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jti: 'jti-expired-1', exp: Math.floor(Date.now() / 1000) - 5 }),
  }));
  expect(response.status).toBe(400);
});

test('clears consumed state on expiry alarm', async () => {
  const { guard, storage } = makeGuard();
  await storage.transaction((tx) => tx.put('consumed', future()));
  await guard.alarm();
  expect(storage.data.size).toBe(0);
});
