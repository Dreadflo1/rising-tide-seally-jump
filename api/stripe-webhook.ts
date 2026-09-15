// Stripe webhook: the ONLY place pearls are granted for a purchase. Verifies the
// Stripe signature over the raw request body (HMAC-SHA256, no Stripe SDK), then
// on `checkout.session.completed` credits the buyer's cloud save. Idempotent:
// each Stripe event id is processed at most once. Self-contained (Vercel ESM).
//
// Requires env: STRIPE_WEBHOOK_SECRET (whsec_...) + the KV/Upstash Redis vars.
// Point your Stripe webhook at /api/stripe-webhook, event `checkout.session.completed`.
import crypto from 'node:crypto';

// Hand us the untouched body so the signature check sees exactly what Stripe
// signed (any reserialization would break it).
export const config = { api: { bodyParser: false } };

type RedisEnv = { url: string; token: string };

function getRedisEnv(): RedisEnv | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(env: RedisEnv, commands: (string | number)[][]): Promise<any[]> {
  const res = await fetch(`${env.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json();
}

const MAX_PEARLS = 100_000_000;

async function creditPearls(env: RedisEnv, profileId: string, pearls: number): Promise<void> {
  const got = await redis(env, [['GET', `seal-jump:save:${profileId}`]]);
  let save: Record<string, any> = {};
  if (got[0]?.result) {
    try {
      save = JSON.parse(got[0].result);
    } catch {
      save = {};
    }
  }
  const current = Number.isFinite(save.totalCoins) ? Math.floor(save.totalCoins) : 0;
  save.totalCoins = Math.min(MAX_PEARLS, Math.max(0, current) + Math.max(0, Math.floor(pearls)));
  await redis(env, [['SET', `seal-jump:save:${profileId}`, JSON.stringify(save)]]);
}

function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// "Stripe-Signature: t=<ts>,v1=<sig>[,v1=...]" — recompute HMAC over
// "<ts>.<rawBody>" and constant-time compare against any provided v1.
function verifyStripeSignature(raw: Buffer, header: string, secret: string): boolean {
  const parts = header.split(',').map((p) => p.split('='));
  const ts = parts.find((p) => p[0] === 't')?.[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!ts || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
  const expBuf = Buffer.from(expected);
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), expBuf));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const env = getRedisEnv();
  if (!secret || !env) {
    res.status(503).json({ error: 'webhook not configured' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    res.status(400).json({ error: 'no body' });
    return;
  }

  const sigHeader = String(req.headers['stripe-signature'] || '');
  if (!sigHeader || !verifyStripeSignature(raw, sigHeader, secret)) {
    res.status(400).json({ error: 'bad signature' });
    return;
  }

  let event: any;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'bad json' });
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      // Idempotency: SET NX on the event id — if it already existed we've already
      // credited this purchase, so ack and stop.
      const first = await redis(env, [['SET', `seal-jump:stripe:evt:${event.id}`, '1', 'NX', 'EX', 2_592_000]]);
      if (!first[0]?.result) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      const session = event.data?.object || {};
      const md = session.metadata || {};
      const profileId = typeof md.profileId === 'string' ? md.profileId : '';
      const pearls = Number(md.pearls);
      const paid = session.payment_status === 'paid' || session.status === 'complete';
      if (profileId && Number.isFinite(pearls) && pearls > 0 && paid) {
        await creditPearls(env, profileId, pearls);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe-webhook]', err);
    res.status(500).json({ error: 'processing error' }); // Stripe retries; crediting is idempotent
  }
}
