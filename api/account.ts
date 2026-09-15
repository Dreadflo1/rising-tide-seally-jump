// Lightweight cross-device accounts — a Vercel serverless function backed by
// the same Upstash / Vercel-KV Redis store as the leaderboard. Nickname +
// password (PIN). Passwords are hashed server-side with PBKDF2-SHA256 (built-in
// node:crypto, no dependency) and NEVER stored or logged in the clear. Sessions
// use a stateless HMAC token (signed with the server-only KV token) so no
// per-request DB lookup is needed.
//
// Storage keys (Redis):
//   seal-jump:acct:<user>  -> JSON { salt, hash, createdAt }
//   seal-jump:save:<user>  -> JSON of the player's GameState (cloud save)
//
// Honest limitation: no email = no password recovery. Forgetting the password
// loses access to that account (this is a casual-game convenience login, not a
// full identity system).

import crypto from 'node:crypto';

const MAX_USERNAME_LEN = 16;
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 64;
const MAX_LOGIN_PER_MIN = 12;
const PBKDF2_ITERS = 100_000;

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

function sanitizeUsername(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw : '';
  const cleaned = s.trim().replace(/[^a-zA-Z0-9_ ]/g, '').slice(0, MAX_USERNAME_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERS, 32, 'sha256').toString('hex');
}

function makeToken(subject: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(subject).digest('hex');
  return Buffer.from(subject).toString('base64url') + '.' + sig;
}

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
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  return ok ? subject : null;
}

function normalizeEmail(raw: unknown): string | null {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function emailDisplayName(email: string): string {
  return sanitizeUsername(email.split('@')[0].replace(/[._-]+/g, ' ')) || 'Player';
}

function sanitizeDisplayName(raw: unknown, fallback: string): string {
  return sanitizeUsername(raw) || sanitizeUsername(fallback) || 'Player';
}

function legacyProfileId(username: string): string {
  return username.toLowerCase();
}

function emailProfileId(email: string): string {
  return `email:${email}`;
}

function googleProfileId(sub: string): string {
  return `google:${sub}`;
}

function saveKey(profileId: string): string {
  return `seal-jump:save:${profileId}`;
}

function emailAccountKey(email: string): string {
  return `seal-jump:acct:e:${email}`;
}

function googleAccountKey(sub: string): string {
  return `seal-jump:acct:g:${sub}`;
}

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
}

async function verifyGoogleIdToken(idToken: unknown, clientId: string): Promise<{ sub: string; email: string; username: string } | null> {
  if (typeof idToken !== 'string' || !idToken) return null;
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return null;
  const info = (await res.json()) as GoogleTokenInfo;
  const email = normalizeEmail(info.email);
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!info.sub || !email || !verified || info.aud !== clientId) return null;
  return {
    sub: info.sub,
    email,
    username: sanitizeDisplayName(info.name, emailDisplayName(email)),
  };
}

// Only persist a whitelist of game-state fields (never trust arbitrary blobs).
function sanitizeState(raw: any): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v: any, max: number) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : 0);
  const strArr = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 64) : []);
  return {
    totalCoins: num(raw.totalCoins, 100_000_000),
    highScoreMeters: num(raw.highScoreMeters, 100_000),
    badges: strArr(raw.badges),
    unlockedMaps: strArr(raw.unlockedMaps),
    selectedMap: typeof raw.selectedMap === 'string' ? raw.selectedMap.slice(0, 24) : 'lagoon',
    ownedSkins: strArr(raw.ownedSkins),
    selectedSkin: typeof raw.selectedSkin === 'string' ? raw.selectedSkin.slice(0, 24) : 'seal',
    runsPlayed: num(raw.runsPlayed, 10_000_000),
    charityMeter: num(raw.charityMeter, 100_000_000),
    totalSharesCount: num(raw.totalSharesCount, 10_000_000),
    loginStreak: num(raw.loginStreak, 100_000),
  };
}

export default async function handler(req: any, res: any) {
  const env = getRedisEnv();
  if (!env) {
    res.status(503).json({ error: 'accounts not configured yet' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const secret = env.token; // server-only; never sent to the client

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const action = body.action;

    if (action === 'sync') {
      // Read-only pull of the current cloud save for a logged-in session. Used
      // after a Stripe purchase so newly-credited pearls appear without a
      // re-login.
      const profileId = verifyToken(body.token, secret);
      if (!profileId) {
        res.status(401).json({ error: 'invalid session' });
        return;
      }
      const got = await redis(env, [['GET', saveKey(profileId)]]);
      let state: unknown = {};
      try {
        state = got[0]?.result ? JSON.parse(got[0].result) : {};
      } catch {
        state = {};
      }
      res.status(200).json({ ok: true, state });
      return;
    }

    if (action === 'save') {
      const profileId = verifyToken(body.token, secret);
      if (!profileId) {
        res.status(401).json({ error: 'invalid session' });
        return;
      }
      const clean = sanitizeState(body.state);
      if (!clean) {
        res.status(400).json({ error: 'invalid state' });
        return;
      }
      await redis(env, [['SET', saveKey(profileId), JSON.stringify(clean)]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'email-signup' || action === 'email-login') {
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
        res.status(400).json({ error: `valid email required and password must be ${MIN_PASSWORD_LEN}+ characters` });
        return;
      }

      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const rlKey = `seal-jump:arl:${ip}`;
      const rl = await redis(env, [['INCR', rlKey], ['EXPIRE', rlKey, 60]]);
      if (Number(rl[0]?.result ?? 0) > MAX_LOGIN_PER_MIN) {
        res.status(429).json({ error: 'too many attempts — wait a minute' });
        return;
      }

      const profileId = emailProfileId(email);
      const acctKey = emailAccountKey(email);
      if (action === 'email-signup') {
        const existing = await redis(env, [['GET', acctKey]]);
        if (existing[0]?.result) {
          res.status(409).json({ error: 'that email is already registered' });
          return;
        }
        const username = sanitizeDisplayName(body.displayName, emailDisplayName(email));
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(password, salt);
        const clean = sanitizeState(body.state) ?? {};
        await redis(env, [
          ['SET', acctKey, JSON.stringify({ provider: 'email', email, username, salt, hash, createdAt: Date.now() })],
          ['SET', saveKey(profileId), JSON.stringify(clean)],
        ]);
        res.status(200).json({ ok: true, token: makeToken(profileId, secret), profileId, username, authProvider: 'email', email, state: clean });
        return;
      }

      const got = await redis(env, [['GET', acctKey], ['GET', saveKey(profileId)]]);
      const acctRaw = got[0]?.result;
      if (!acctRaw) {
        res.status(401).json({ error: 'wrong email or password' });
        return;
      }
      const acct = JSON.parse(acctRaw);
      const hash = hashPassword(password, acct.salt);
      const match = hash.length === String(acct.hash).length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(acct.hash));
      if (!match) {
        res.status(401).json({ error: 'wrong email or password' });
        return;
      }
      res.status(200).json({
        ok: true,
        token: makeToken(profileId, secret),
        profileId,
        username: sanitizeDisplayName(acct.username, emailDisplayName(email)),
        authProvider: 'email',
        email,
        state: got[1]?.result ? JSON.parse(got[1].result) : {},
      });
      return;
    }

    if (action === 'google') {
      const clientId = process.env.GOOGLE_CLIENT_ID || '';
      if (!clientId) {
        res.status(503).json({ error: 'google sign-in is not configured yet' });
        return;
      }
      const google = await verifyGoogleIdToken(body.idToken, clientId);
      if (!google) {
        res.status(401).json({ error: 'invalid google sign-in' });
        return;
      }
      const profileId = googleProfileId(google.sub);
      const acctKey = googleAccountKey(google.sub);
      const got = await redis(env, [['GET', acctKey], ['GET', saveKey(profileId)]]);
      const acctRaw = got[0]?.result;
      if (!acctRaw) {
        const clean = sanitizeState(body.state) ?? {};
        await redis(env, [
          ['SET', acctKey, JSON.stringify({ provider: 'google', email: google.email, username: google.username, createdAt: Date.now() })],
          ['SET', saveKey(profileId), JSON.stringify(clean)],
        ]);
        res.status(200).json({
          ok: true,
          token: makeToken(profileId, secret),
          profileId,
          username: google.username,
          authProvider: 'google',
          email: google.email,
          state: clean,
        });
        return;
      }
      const acct = JSON.parse(acctRaw);
      res.status(200).json({
        ok: true,
        token: makeToken(profileId, secret),
        profileId,
        username: sanitizeDisplayName(acct.username, google.username),
        authProvider: 'google',
        email: normalizeEmail(acct.email) || google.email,
        state: got[1]?.result ? JSON.parse(got[1].result) : {},
      });
      return;
    }

    // signup / login both need username + password.
    const username = sanitizeUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
      res.status(400).json({ error: `nickname required and password must be ${MIN_PASSWORD_LEN}+ characters` });
      return;
    }

    // Rate-limit auth attempts per IP.
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const rlKey = `seal-jump:arl:${ip}`;
    const rl = await redis(env, [['INCR', rlKey], ['EXPIRE', rlKey, 60]]);
    if (Number(rl[0]?.result ?? 0) > MAX_LOGIN_PER_MIN) {
      res.status(429).json({ error: 'too many attempts — wait a minute' });
      return;
    }

    const acctKey = `seal-jump:acct:${username}`;

    if (action === 'signup') {
      const existing = await redis(env, [['GET', acctKey]]);
      if (existing[0]?.result) {
        res.status(409).json({ error: 'that nickname is already taken' });
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const clean = sanitizeState(body.state) ?? {};
      await redis(env, [
        ['SET', acctKey, JSON.stringify({ provider: 'local', username, salt, hash, createdAt: Date.now() })],
        ['SET', saveKey(username), JSON.stringify(clean)],
      ]);
      res.status(200).json({ ok: true, token: makeToken(username, secret), profileId: legacyProfileId(username), username, authProvider: 'local', state: clean });
      return;
    }

    if (action === 'login') {
      const got = await redis(env, [['GET', acctKey], ['GET', saveKey(username)]]);
      const acctRaw = got[0]?.result;
      if (!acctRaw) {
        res.status(401).json({ error: 'wrong nickname or password' });
        return;
      }
      const acct = JSON.parse(acctRaw);
      const hash = hashPassword(password, acct.salt);
      const match =
        hash.length === String(acct.hash).length &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(acct.hash));
      if (!match) {
        res.status(401).json({ error: 'wrong nickname or password' });
        return;
      }
      let saveState: unknown = {};
      try {
        saveState = got[1]?.result ? JSON.parse(got[1].result) : {};
      } catch {
        saveState = {};
      }
      res.status(200).json({ ok: true, token: makeToken(username, secret), profileId: legacyProfileId(username), username, authProvider: 'local', state: saveState });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[account api]', err);
    res.status(500).json({ error: 'internal error' });
  }
}
