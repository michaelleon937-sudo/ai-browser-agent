/** Cloudflare Durable Object replay guard. One object per tenantId:jti. */
export class ReplayGuard {
  constructor(state) { this.state = state; this.storage = state.storage; }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const { jti, exp } = body || {};
    const now = Math.floor(Date.now() / 1000);
    if (typeof jti !== 'string' || !jti || jti.length > 256 ||
        !Number.isInteger(exp) || exp <= now || exp - now > 630) {
      return new Response('Invalid replay claim', { status: 400 });
    }
    const accepted = await this.storage.transaction(async (tx) => {
      const consumed = await tx.get('consumed');
      if (consumed !== undefined) return false;
      await tx.put('consumed', exp);
      return true;
    });
    if (!accepted) return new Response('Token already used', { status: 409 });
    await this.storage.setAlarm(exp * 1000);
    return new Response('Accepted', { status: 201 });
  }
  async alarm() { await this.storage.deleteAll(); }
}