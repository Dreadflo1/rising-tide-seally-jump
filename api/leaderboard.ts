// Durable, global leaderboard — a Vercel serverless function backed by
// Upstash Redis (called via its plain REST API, no SDK dependency, so this
// needs zero additions to package.json).
//
// ---- One-time setup ----
// 1. In the Vercel dashboard, open this project -> Storage tab -> Browse
//    Marketplace -> "Upstash" -> create a free Redis database and connect
//    it to this project. That automatically sets the two env vars this
//    file reads (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) —
//    nothing to copy/paste by hand.
// 2. Redeploy. That's it — no code changes needed.
//
// Without those env vars set, every request below returns 503 and the
// game quietly falls back to its local-only leaderboard (see
// fetchGlobalLeaderboard/submitScoreGlobal in src/state.ts), so the game
// keeps working before you've set this up.
//
// Data model: one Redis sorted set (`seal-jump:leaderboard`), member =
// username, score = personal-best meters. ZADD's GT flag means a
// worse run never overwrites a player's best — exactly "durable personal
// best on a global board", same shape as Doodle Jump's Game Center board.

// Per-map boards (Option A): scores are only comparable within the same map,
// since maps differ in difficulty. One Redis sorted set per map, keyed
// seal-jump:leaderboard:v2:<map>. (Bumped to :v2 for a clean launch — the old
// single-board key is orphaned/ignored. Bump the version to wipe again.)
const VALID_MAPS = ['lagoon', 'reef', 'storm'];
const DEFAULT_MAP = 'lagoon';
function lbKey(map: string): string {
  return `seal-jump:leaderboard:v2:${map}`;
}
function sanitizeMap(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return VALID_MAPS.includes(s) ? s : DEFAULT_MAP;
}
const MAX_USERNAME_LEN = 16;
const MAX_LIMIT = 100;
// Anti-cheat: a legit run can't exceed this height, and a real client submits
// at most once per game-over — so cap both.
const MAX_PLAUSIBLE_METERS = 100_000;
const MAX_SUBMITS_PER_MIN = 30;

type RedisEnv = { url: string; token: string };

function getRedisEnv(): RedisEnv | null {
  // Works with either the direct Upstash integration (UPSTASH_REDIS_REST_*) or
  // the Vercel KV / Upstash-via-Marketplace integration (KV_REST_API_*) — both
  // expose the same Upstash REST pipeline API.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisPipeline(env: RedisEnv, commands: (string | number)[][]): Promise<any[]> {
  const res = await fetch(`${env.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    throw new Error(`redis pipeline failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

function sanitizeUsername(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw : '';
  const cleaned = s.trim().replace(/[^a-zA-Z0-9_ ]/g, '').slice(0, MAX_USERNAME_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function parseTopResult(flat: string[] | undefined): { username: string; meters: number }[] {
  if (!flat) return [];
  const out: { username: string; meters: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ username: flat[i], meters: Number(flat[i + 1]) });
  }
  return out;
}

// req/res are the standard Vercel Node function request/response objects.
// Not importing @vercel/node's types here on purpose — this file lives
// outside tsconfig.json's "include" (src only), so it's compiled/typed by
// Vercel's own build step, not the frontend's `tsc` check.
export default async function handler(req: any, res: any) {
  const env = getRedisEnv();
  if (!env) {
    res.status(503).json({ error: 'leaderboard not configured yet' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const limitRaw = parseInt(String(req.query?.limit ?? '50'), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : 50;
      const username = sanitizeUsername(req.query?.username);
      const key = lbKey(sanitizeMap(req.query?.map));

      const commands: (string | number)[][] = [['ZREVRANGE', key, 0, limit - 1, 'WITHSCORES']];
      if (username) {
        commands.push(['ZREVRANK', key, username], ['ZSCORE', key, username], ['ZCARD', key]);
      }

      const results = await redisPipeline(env, commands);
      const top = parseTopResult(results[0]?.result);

      let me = null;
      if (username) {
        const rank = results[1]?.result;
        const score = results[2]?.result;
        const total = results[3]?.result;
        if (rank !== null && rank !== undefined && score !== null && score !== undefined) {
          me = { username, meters: Number(score), rank: Number(rank) + 1, total: Number(total) };
        }
      }

      res.status(200).json({ top, me });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const username = sanitizeUsername(body.username);
      const meters = Number(body.meters);
      const key = lbKey(sanitizeMap(body.map));

      // Plausibility guard: the game tops out in the low thousands of metres even
      // on a perfect climb, so anything above MAX_PLAUSIBLE_METERS is a tamper.
      if (!username || !Number.isFinite(meters) || meters < 0 || meters > MAX_PLAUSIBLE_METERS) {
        res.status(400).json({ error: 'invalid submission' });
        return;
      }

      // Basic anti-spam: cap submissions per IP per minute (a real client only
      // POSTs once per game-over). Redis counter with a 60s TTL.
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
        .split(',')[0]
        .trim();
      const rlKey = `seal-jump:rl:${ip}`;
      const rl = await redisPipeline(env, [
        ['INCR', rlKey],
        ['EXPIRE', rlKey, 60],
      ]);
      if (Number(rl[0]?.result ?? 0) > MAX_SUBMITS_PER_MIN) {
        res.status(429).json({ error: 'too many requests' });
        return;
      }

      const commands: (string | number)[][] = [
        ['ZADD', key, 'GT', 'CH', meters, username],
        ['ZREVRANK', key, username],
        ['ZSCORE', key, username],
        ['ZCARD', key],
      ];
      const results = await redisPipeline(env, commands);
      const rank = results[1]?.result;
      const bestScore = results[2]?.result;
      const total = results[3]?.result;

      res.status(200).json({
        ok: true,
        username,
        meters: bestScore !== null && bestScore !== undefined ? Number(bestScore) : meters,
        rank: rank !== null && rank !== undefined ? Number(rank) + 1 : null,
        total: total !== null && total !== undefined ? Number(total) : null,
      });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('[leaderboard api]', err);
    res.status(500).json({ error: 'internal error' });
  }
}
