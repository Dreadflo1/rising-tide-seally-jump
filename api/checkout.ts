// Creates a Stripe Checkout Session for a pearl pack. The player must be logged
// into a cloud account (their session token identifies WHOM to credit); the
// pearls are granted server-side by the webhook (api/stripe-webhook.ts) only
// after Stripe confirms payment — never trusted from the client.
//
// No Stripe SDK dependency: we call Stripe's REST API directly with the secret
// key. Requires env: STRIPE_SECRET_KEY + a STRIPE_PRICE_* per pack + the
// KV/Upstash Redis vars. Self-contained (Vercel runs /api as ESM).
import crypto from 'node:crypto';

const PEARL_PACKS: Record<string, { pearls: number; priceEnv: string }> = {
  p500: { pearls: 500, priceEnv: 'STRIPE_PRICE_P500' },
  p1500: { pearls: 1500, priceEnv: 'STRIPE_PRICE_P1500' },
  p4000: { pearls: 4000, priceEnv: 'STRIPE_PRICE_P4000' },
};

function getKvToken(): string | null {
  return process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || null;
}

// Stateless HMAC session token (same scheme as api/account.ts): base64url(id).hexsig.
function verifyToken(token: unknown, secret: string): string | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let subject: string;
  try {
    subject = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(subject).digest('hex');
  if (sig.length !== expect.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? subject : null;
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const kvToken = getKvToken();
  if (!secretKey || !kvToken) {
    res.status(503).json({ error: 'store not configured yet' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const profileId = verifyToken(body.token, kvToken);
    if (!profileId) {
      res.status(401).json({ error: 'log in to buy pearls' });
      return;
    }
    const pack = PEARL_PACKS[body.packId];
    if (!pack) {
      res.status(400).json({ error: 'unknown pack' });
      return;
    }
    const priceId = process.env[pack.priceEnv] || '';
    if (!priceId) {
      res.status(503).json({ error: 'this pack is not available yet' });
      return;
    }

    const origin =
      (typeof body.origin === 'string' && /^https?:\/\//.test(body.origin) && body.origin) ||
      req.headers['origin'] ||
      `https://${req.headers['host'] || 'rising-tide-seal-jump-source.vercel.app'}`;

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form({
        mode: 'payment',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        success_url: `${origin}/?purchase=success&pack=${body.packId}`,
        cancel_url: `${origin}/?purchase=cancel`,
        'metadata[profileId]': profileId,
        'metadata[packId]': String(body.packId),
        'metadata[pearls]': String(pack.pearls),
        client_reference_id: `${profileId}:${body.packId}`,
      }),
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok || !session.url) {
      console.error('[checkout] stripe error', session?.error?.message || stripeRes.status);
      res.status(502).json({ error: 'could not start checkout' });
      return;
    }
    res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[checkout]', err);
    res.status(500).json({ error: 'internal error' });
  }
}
