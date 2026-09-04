import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('../../database/index.js', () => ({
notifications: { record: vi.fn() },
}));

import fetch from 'node-fetch';

describe('notifications', () => {
beforeEach(() => {
vi.clearAllMocks();
delete process.env.NOTIFY_WEBHOOK_URL;
});

it('falls back to console logging when no channel is configured', async () => {
vi.resetModules();

const { notify } = await import('../../notifications/index.js');

const result = await notify({
  level: 'info',
  subject: 'test',
  body: 'hello',
});

expect(result.sent).toBe(false);
expect(fetch).not.toHaveBeenCalled();

});

it('posts to the webhook when NOTIFY_WEBHOOK_URL is set', async () => {
process.env.NOTIFY_WEBHOOK_URL = 'https://hooks.example.com/xyz';
fetch.mockResolvedValue({ ok: true, status: 200 });

vi.resetModules();

const { notify } = await import('../../notifications/index.js');

const result = await notify({
  level: 'error',
  subject: 'task failed',
  body: 'details',
});

expect(fetch).toHaveBeenCalledWith(
  'https://hooks.example.com/xyz',
  expect.objectContaining({ method: 'POST' }),
);

expect(result.sent).toBe(true);

});

it('does not throw when the webhook request fails', async () => {
process.env.NOTIFY_WEBHOOK_URL = 'https://hooks.example.com/xyz';
fetch.mockResolvedValue({ ok: false, status: 500 });

vi.resetModules();

const { notify } = await import('../../notifications/index.js');

await expect(
  notify({ subject: 'x', body: 'y' }),
).resolves.toBeDefined();

});
});
