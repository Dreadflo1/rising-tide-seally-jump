// Live game-feel tuning knobs. The dev tuning panel (tuningPanel.ts, shown only
// with ?tune=1) writes here and persists to localStorage; GameScene reads these
// every frame / spawn so changes apply live. To ship: bake the values you settle
// on into DEFAULTS below, then delete tuningPanel.ts + its mount — the game keeps
// working straight off this config.

export interface Tuning {
  tideSpeed: number; // constant tide rise, design px/s (before per-map tideMult)
  maxMetersBelow: number; // HARD leash: the tide is never more than this many metres below the seal
  pearlSpacingM: number; // metres between pearls
  powerupSpacingM: number; // metres between power-ups
  lifeSpacingM: number; // metres between extra lives
  firstTrapM: number; // no traps before this height
  trapRarity: number; // × multiplier on trap gaps (1 = default, higher = rarer)
  variety: number; // × multiplier on non-stable platform weights (1 = default, higher = more varied)
}

// Baked from a real tuning session — the values the game felt good at.
const DEFAULTS: Tuning = {
  // 100 px/s: below the seal's steady climb (~117 px/s on avg 74px gaps) on
  // Lagoon (×1.0) so a clean run stays ahead, but close enough to punish stalls.
  // (126 was faster than the average climb → unbeatable; the leash below keeps it
  // fair without making the base out-climb the seal.)
  tideSpeed: 100,
  // HARD leash, in METRES: the tide is never allowed to sit more than this far
  // below the seal (measured against a smoothed seal height so a one-off spring
  // apex doesn't yank the water up). Rule from the designer: max 15 m.
  maxMetersBelow: 15,
  pearlSpacingM: 18,
  powerupSpacingM: 70,
  lifeSpacingM: 520,
  firstTrapM: 140,
  trapRarity: 1.5,
  variety: 2.3,
};

// Bumped v1→v2 so any admin ?tune=1 override saved with the old tideSpeed (126)
// is discarded — everyone falls back to the fair DEFAULTS above. (Same stale-
// localStorage trap as the seed-version pattern: a saved override silently wins
// over new code defaults until the key changes.)
const KEY = 'seal-jump-tuning-v4';

function load(): Tuning {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

/** The single live config object. Mutate its fields in place; call saveTuning() to persist. */
export const tuning: Tuning = load();

export const tuningDefaults: Tuning = { ...DEFAULTS };

export function saveTuning() {
  try {
    localStorage.setItem(KEY, JSON.stringify(tuning));
  } catch {
    /* ignore */
  }
}

export function resetTuning() {
  Object.assign(tuning, DEFAULTS);
  saveTuning();
}

/** True only when the dev tuning panel should be available (opted in via ?tune=1
 *  or localhost). Never shown to normal players. */
export function tuningEnabled(): boolean {
  try {
    if (/[?&]tune=1\b/.test(location.search)) return true;
    return /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  } catch {
    return false;
  }
}
