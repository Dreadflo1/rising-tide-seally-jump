// Persistent, per-account game state. Stored via the `store` shim: normally
// window.localStorage, but the CrazyGames Data Module inside their portal iframe
// (localStorage isn't persisted there — see storage.ts).
// Each logged-in username gets its own save slot so progress is tied to
// "your" profile and survives across sessions/reloads.

import { store } from './storage';
import { onCrazyGames } from './crazyAds';
import { isOwnHost } from './hosts';

export interface BadgeDef {
  id: string;
  name: string;
  threshold: number; // meters
  icon: string;
  reward: number; // pearls granted the first time it's earned
}

export interface MapDef {
  id: string;
  name: string;
  bg: string;
  unlockThreshold: number; // meters
  // Per-map gameplay so unlocking a map actually changes how it PLAYS, not just
  // how it looks: tougher maps rise faster and throw more hazards, but pay out
  // more pearls to reward the risk.
  tideMult: number;
  hazardMult: number;
  coinMult: number;
  blurb: string;
}

export interface SkinDef {
  id: string;
  name: string;
  sprite: string;
  tint?: number; // optional color tint applied over the base sprite
  cost: number;
}

export const BADGES: BadgeDef[] = [
  { id: 'b50', name: 'First Splash', threshold: 50, icon: '🐚', reward: 20 },
  { id: 'b100', name: 'Tide Pool Rookie', threshold: 100, icon: '🥉', reward: 30 },
  { id: 'b175', name: 'Sandbar Scout', threshold: 175, icon: '🐠', reward: 40 },
  { id: 'b250', name: 'Reef Runner', threshold: 250, icon: '🥈', reward: 50 },
  { id: 'b375', name: 'Kelp Climber', threshold: 375, icon: '🌿', reward: 60 },
  { id: 'b500', name: 'Wave Rider', threshold: 500, icon: '🥇', reward: 75 },
  { id: 'b750', name: 'Lagoon Legend', threshold: 750, icon: '🏄', reward: 100 },
  { id: 'b1000', name: 'Current Champion', threshold: 1000, icon: '💎', reward: 125 },
  { id: 'b1500', name: 'Deep Diver', threshold: 1500, icon: '🐬', reward: 150 },
  { id: 'b2000', name: 'Storm Survivor', threshold: 2000, icon: '👑', reward: 200 },
  { id: 'b2750', name: 'Abyss Ace', threshold: 2750, icon: '🦈', reward: 250 },
  { id: 'b3500', name: 'Ocean Guardian', threshold: 3500, icon: '🌊', reward: 300 },
];

export const MAPS: MapDef[] = [
  { id: 'lagoon', name: 'Sunny Lagoon', bg: 'bg_lagoon', unlockThreshold: 0, tideMult: 1, hazardMult: 1, coinMult: 1, blurb: 'Calm waters — a gentle climb' },
  { id: 'reef', name: 'Coral Reef', bg: 'bg_reef', unlockThreshold: 250, tideMult: 1.15, hazardMult: 1.3, coinMult: 1.3, blurb: 'Faster tide, more hazards · +30% pearls' },
  { id: 'storm', name: 'Storm Depths', bg: 'bg_storm', unlockThreshold: 1000, tideMult: 1.35, hazardMult: 1.6, coinMult: 1.6, blurb: 'Brutal tide, heavy hazards · +60% pearls' },
];

// Skins are bought with TRASH COLLECTED (the ♻️ cleanup currency), not pearls, so
// `cost` here is in pieces of ocean trash. Priced as long-haul goals (a good run
// nets ~15-30 pieces) so costumes stay aspirational, ramping to the rare ones.
export const SKINS: SkinDef[] = [
  { id: 'seal', name: 'Seally', sprite: 'player_seal', cost: 0 },
  { id: 'surfer', name: 'Surfer Seally', sprite: 'seal_skin_surfer', cost: 400 },
  { id: 'cool', name: 'Cool Seally', sprite: 'seal_skin_cool', cost: 750 },
  { id: 'scuba', name: 'Scuba Seally', sprite: 'seal_skin_scuba', cost: 1300 },
  { id: 'floatie', name: 'Floatie Seally', sprite: 'seal_skin_floatie', cost: 2000 },
  { id: 'pirate', name: 'Pirate Seally', sprite: 'seal_skin_pirate', cost: 3200 },
  { id: 'astronaut', name: 'Astronaut Seally', sprite: 'seal_skin_astronaut', cost: 5000 },
  { id: 'neptune', name: 'King Neptune Seally', sprite: 'seal_skin_neptune', cost: 8000 },
];

// Extra lives: earned every 350 m in a run and purchasable in the shop, capped
// at MAX_LIVES. A life is spent automatically to continue after a fatal fall.
export const MAX_LIVES = 3;

interface GameState {
  profileId: string;
  username: string;
  totalCoins: number;
  highScoreMeters: number;
  badges: string[];
  unlockedMaps: string[];
  selectedMap: string;
  ownedSkins: string[];
  selectedSkin: string;
  adsRemoved: boolean;
  muted: boolean;
  runsPlayed: number;
  charityMeter: number;
  trashCleaned: number; // total pieces of ocean trash collected across all runs (the cleanup mechanic)
  totalSharesCount: number;
  lastLoginDate: string; // 'YYYY-MM-DD', local time
  loginStreak: number;
  lives: number; // extra lives inventory (0..MAX_LIVES)
}

export interface LeaderboardEntry {
  username: string;
  meters: number;
  date: number;
}

const PROFILE_PREFIX = 'seal-jump-state-v2:';
const LEADERBOARD_KEY = 'seal-jump-leaderboard-v1';

function defaultState(username: string): GameState {
  return {
    profileId: username.toLowerCase(),
    username,
    totalCoins: 0,
    highScoreMeters: 0,
    badges: [],
    unlockedMaps: ['lagoon'],
    selectedMap: 'lagoon',
    ownedSkins: ['seal'],
    selectedSkin: 'seal',
    adsRemoved: false,
    muted: false,
    runsPlayed: 0,
    charityMeter: 0,
    trashCleaned: 0,
    totalSharesCount: 0,
    lastLoginDate: '',
    loginStreak: 0,
    lives: 0,
  };
}

let state: GameState = defaultState('Guest');

function keyFor(profileId: string) {
  // On the CrazyGames portal the save lives in their per-user Data Module, so one
  // stable key = one persistent save for that CrazyGames player. (Profiles there
  // are ephemeral Guest#### ids that would otherwise change every session and lose
  // the save; the leaderboard/cloud accounts that need distinct keys don't run on
  // their host anyway.)
  if (onCrazyGames()) return `${PROFILE_PREFIX}cg`;
  return `${PROFILE_PREFIX}${profileId.toLowerCase()}`;
}

export function loadProfile(profileId: string, username = profileId): GameState {
  try {
    const raw = store.getItem(keyFor(profileId));
    if (!raw) {
      state = { ...defaultState(username), profileId };
    } else {
      const parsed = JSON.parse(raw);
      state = { ...defaultState(username), ...parsed, profileId, username };
    }
  } catch {
    state = { ...defaultState(username), profileId };
  }
  saveState();
  return state;
}

export function getState(): GameState {
  return state;
}

// Optional hook fired after every local save — cloud.ts registers it to push
// the state to the cross-device cloud save (debounced) when the player is
// logged into a cloud account. Kept as a hook so state.ts has no import cycle
// with cloud.ts.
let stateSaveHook: (() => void) | null = null;
export function setStateSaveHook(fn: (() => void) | null) {
  stateSaveHook = fn;
}

export function saveState() {
  try {
    store.setItem(keyFor(state.profileId), JSON.stringify(state));
  } catch {
    /* ignore */
  }
  if (stateSaveHook) stateSaveHook();
}

/** Replace the whole profile with a cloud save (used right after a cross-device
 *  login/signup), keeping the local copy in sync. */
export function applyCloudState(username: string, cloud: Partial<GameState>, profileId = username.toLowerCase()) {
  state = { ...defaultState(username), ...cloud, profileId, username };
  saveState();
}

export function addCoins(n: number) {
  state.totalCoins += n;
  saveState();
}

export function spendCoins(n: number): boolean {
  if (state.totalCoins < n) return false;
  state.totalCoins -= n;
  saveState();
  return true;
}

function submitToLeaderboard(username: string, meters: number) {
  try {
    const raw = store.getItem(LEADERBOARD_KEY);
    const list: LeaderboardEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ username, meters, date: Date.now() });
    list.sort((a, b) => b.meters - a.meters);
    const trimmed = list.slice(0, 50);
    store.setItem(LEADERBOARD_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

export function getLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = store.getItem(LEADERBOARD_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ---- Durable, global leaderboard (api/leaderboard.ts) -------------------
//
// The functions above (submitToLeaderboard/getLeaderboard) only ever read
// and write localStorage, so they're inherently per-browser — fine as an
// always-available fallback, but not a real "beat the world" leaderboard.
// These two functions talk to /api/leaderboard (a Vercel serverless
// function backed by durable Redis storage). Both fail soft: if the
// endpoint isn't configured yet (no Upstash env vars) or the network is
// down, they fall back to the local cache below instead of breaking
// anything — same pattern as the ads/error-reporting modules.

export interface GlobalRankInfo {
  username: string;
  meters: number;
  rank: number;
  total: number | null;
}

export interface GlobalLeaderboardResult {
  top: LeaderboardEntry[];
  me: GlobalRankInfo | null;
  source: 'global' | 'local';
}

const GLOBAL_LB_CACHE_KEY = 'seal-jump-global-leaderboard-cache-v1';

// The /api/leaderboard backend only exists on our own deployment (Vercel) and
// local dev. On the GameDistribution CDN / portal (html5. or revision.
// gamedistribution.com) there is no backend, so calling it just yields a noisy
// 403 in the console. Skip the network entirely there and use the local board.
function hasLeaderboardBackend(): boolean {
  try {
    return isOwnHost();
  } catch {
    return true;
  }
}

function cacheGlobalTop(top: LeaderboardEntry[]) {
  try {
    store.setItem(GLOBAL_LB_CACHE_KEY, JSON.stringify(top));
  } catch {
    /* ignore */
  }
}

function readCachedGlobalTop(): LeaderboardEntry[] {
  try {
    const raw = store.getItem(GLOBAL_LB_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Fetch the global top scores (and, optionally, a given player's global rank). */
export async function fetchGlobalLeaderboard(username?: string, limit = 50, map?: string): Promise<GlobalLeaderboardResult> {
  if (!hasLeaderboardBackend()) {
    const cached = readCachedGlobalTop();
    return { top: cached.length > 0 ? cached : getLeaderboard(), me: null, source: 'local' };
  }
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (username) params.set('username', username);
    if (map) params.set('map', map);
    const res = await fetch(`/api/leaderboard?${params.toString()}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const top: LeaderboardEntry[] = (data.top ?? []).map((e: { username: string; meters: number }) => ({
      username: e.username,
      meters: e.meters,
      date: Date.now(),
    }));
    cacheGlobalTop(top);
    return { top, me: data.me ?? null, source: 'global' };
  } catch {
    // Offline, not deployed yet, or Upstash isn't configured — fall back
    // to the last known global snapshot if we have one, else the
    // purely-local leaderboard so the screen is never empty.
    const cached = readCachedGlobalTop();
    return { top: cached.length > 0 ? cached : getLeaderboard(), me: null, source: 'local' };
  }
}

/** Submit a run's score to the durable global leaderboard (fire-and-forget friendly). */
export async function submitScoreGlobal(username: string, meters: number, map?: string): Promise<GlobalRankInfo | null> {
  if (!hasLeaderboardBackend()) return null;
  try {
    const res = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, meters, map }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (!data.ok) return null;
    return { username: data.username, meters: data.meters, rank: data.rank, total: data.total };
  } catch {
    // No durable board available right now — the local leaderboard
    // (already updated by registerRun/submitToLeaderboard) still works.
    return null;
  }
}

export function registerRun(meters: number, coinsCollected: number) {
  state.totalCoins += coinsCollected;
  state.runsPlayed += 1;
  const newlyUnlockedBadges: BadgeDef[] = [];
  const newlyUnlockedMaps: MapDef[] = [];
  if (meters > state.highScoreMeters) state.highScoreMeters = meters;

  for (const b of BADGES) {
    if (meters >= b.threshold && !state.badges.includes(b.id)) {
      state.badges.push(b.id);
      state.totalCoins += b.reward; // pearl award for reaching a new medal
      newlyUnlockedBadges.push(b);
    }
  }
  for (const m of MAPS) {
    if (meters >= m.unlockThreshold && !state.unlockedMaps.includes(m.id)) {
      state.unlockedMaps.push(m.id);
      newlyUnlockedMaps.push(m);
    }
  }
  saveState();
  submitToLeaderboard(state.username, meters);
  return { newlyUnlockedBadges, newlyUnlockedMaps };
}

export function registerShare() {
  state.totalSharesCount += 1;
  // small pearl reward for spreading the word — capped per run isn't tracked
  // here for simplicity, kept generous but modest.
  state.totalCoins += 25;
  saveState();
}

export function buySkin(id: string): boolean {
  const skin = SKINS.find((s) => s.id === id);
  if (!skin) return false;
  if (state.ownedSkins.includes(id)) return true;
  // Skins are paid for with TRASH COLLECTED (♻️), not pearls.
  if (!spendTrash(skin.cost)) return false;
  state.ownedSkins.push(id);
  saveState();
  return true;
}

export function selectSkin(id: string) {
  if (state.ownedSkins.includes(id)) {
    state.selectedSkin = id;
    saveState();
  }
}

export function selectMap(id: string) {
  if (state.unlockedMaps.includes(id)) {
    state.selectedMap = id;
    saveState();
  }
}

/** Grant one life (capped at MAX_LIVES). Returns true if a life was actually added. */
export function addLife(): boolean {
  if (state.lives >= MAX_LIVES) return false;
  state.lives += 1;
  saveState();
  return true;
}

/** Spend one life (used to continue after a fatal fall). */
export function spendLife(): boolean {
  if (state.lives <= 0) return false;
  state.lives -= 1;
  saveState();
  return true;
}

/** Reset lives to the per-run baseline (0) so every player starts a game on
 *  equal footing — persisted lives never carry into a run. Hearts collected
 *  DURING the run still grant revives, and a revive keeps the run's score. */
export function resetRunLives() {
  state.lives = 0;
  saveState();
}

/** Buy one life with pearls, capped at MAX_LIVES. */
export function buyLife(cost: number): boolean {
  if (state.lives >= MAX_LIVES) return false;
  if (!spendCoins(cost)) return false;
  state.lives += 1;
  saveState();
  return true;
}

/** Record ocean trash collected via the in-game cleanup mechanic. Not saved per
 *  call (that would thrash localStorage every pickup) — persisted with the run at
 *  game over via registerRun()'s saveState(). */
export function addTrashCleaned(n: number) {
  state.trashCleaned += n;
}

/** Spend trash collected (♻️) — the currency used to buy skins. Returns false if
 *  the player doesn't have enough. */
export function spendTrash(n: number): boolean {
  if (state.trashCleaned < n) return false;
  state.trashCleaned -= n;
  saveState();
  return true;
}

export function donateToCharity(coins: number): boolean {
  if (!spendCoins(coins)) return false;
  state.charityMeter += coins;
  saveState();
  return true;
}

export function toggleMute(): boolean {
  state.muted = !state.muted;
  saveState();
  return state.muted;
}

// ---- Daily-return reward ------------------------------------------------
//
// The endless-jumper loop (instant restart, near-miss tension, visible
// score) is what keeps someone playing *right now* — but nothing before
// this gave a player a reason to open the game again *tomorrow*. This is
// that hook: the first time a player is seen on a new calendar day, they
// get a small pearl bonus, with an escalating streak for consecutive days
// that resets if a day is skipped (classic daily-login pattern).

export interface DailyRewardResult {
  granted: boolean;
  streak: number;
  reward: number;
}

function dateKey(d: Date = new Date()): string {
  // Local calendar day (not UTC) — matches when a player actually feels
  // like "today" ended and a new one began, on their own device.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Call once per session (e.g. on the title screen). Idempotent per
 * calendar day: safe to call every time that screen loads, it only
 * actually grants + reports true once per day. */
export function claimDailyReward(): DailyRewardResult {
  const today = dateKey();
  if (state.lastLoginDate === today) {
    return { granted: false, streak: state.loginStreak, reward: 0 };
  }

  const yesterday = dateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  state.loginStreak = state.lastLoginDate === yesterday ? state.loginStreak + 1 : 1;
  state.lastLoginDate = today;

  // Day 1: 10, Day 2: 15, ... Day 7+: 40 (caps so it never spirals).
  const reward = 10 + Math.min(state.loginStreak - 1, 6) * 5;
  state.totalCoins += reward;
  saveState();

  return { granted: true, streak: state.loginStreak, reward };
}
