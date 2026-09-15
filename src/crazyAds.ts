// CrazyGames ad provider — used ONLY when the game is running on the CrazyGames
// portal (an *.crazygames.com host). There we let CrazyGames' own SDK serve the
// rewarded + interstitial ads (that's how the game monetises on their platform),
// and we fire the gameplayStart/gameplayStop signals their QA requires.
//
// Everywhere else (seally.best, GameDistribution, local dev) this stays completely
// inert — the SDK script isn't even loaded — so nothing external is pulled in and
// the other providers (AdSense on our site, GD on their portal) are untouched.
//
// Everything soft-fails: no SDK, an ad-block, or a no-fill just means the reward
// isn't granted / the replay is free. The game is never blocked by an ad.

type AdCallbacks = {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (err: unknown) => void;
};

interface CrazySDK {
  init: () => Promise<void>;
  environment?: string; // 'crazygames' | 'local' | 'disabled'
  ad: { requestAd: (type: 'midgame' | 'rewarded', callbacks: AdCallbacks) => void };
  game: {
    gameplayStart: () => void;
    gameplayStop: () => void;
    happytime: () => void;
  };
  // Data Module — a synchronous, localStorage-shaped store that CrazyGames syncs
  // to the player's account (survives sessions inside their iframe, unlike plain
  // localStorage). Present once init() resolves on their portal. See storage.ts.
  data?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
  };
}

declare global {
  interface Window {
    CrazyGames?: { SDK: CrazySDK };
  }
}

let sdk: CrazySDK | null = null;
let ready = false;
let scriptRequested = false;

/** True only when the page is actually served from the CrazyGames portal. */
export function onCrazyGames(): boolean {
  try {
    return /(^|\.)crazygames\.com$/i.test(location.hostname);
  } catch {
    return false;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('crazygames sdk failed to load'));
    document.head.appendChild(s);
  });
}

/** Load + init the CrazyGames SDK, but only on their portal. No-op elsewhere. */
export async function initCrazyAds(): Promise<void> {
  if (!onCrazyGames() || scriptRequested) return;
  scriptRequested = true;
  try {
    await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js');
    const s = window.CrazyGames?.SDK;
    if (!s) return;
    await s.init();
    sdk = s;
    ready = true;
  } catch {
    // adblock / network / QA-disabled — provider stays inert, game unaffected.
  }
}

/** Active only once the SDK on the CrazyGames portal has initialised. */
export function crazyActive(): boolean {
  return ready && !!sdk;
}

/** Rewarded is considered available whenever the SDK is up (CrazyGames decides
 *  fill at request time and calls adError if there's nothing to serve). */
export function crazyRewardedReady(): boolean {
  return crazyActive();
}

/** Rewarded video. onReward fires only if the ad completed; onClose on any
 *  no-fill / error / adblock. */
export function showCrazyRewarded(onReward: () => void, onClose: () => void): void {
  if (!crazyActive()) {
    onClose();
    return;
  }
  let settled = false;
  const done = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  try {
    sdk!.ad.requestAd('rewarded', {
      adFinished: () => done(onReward),
      adError: () => done(onClose),
    });
  } catch {
    done(onClose);
  }
}

/** Interstitial between plays. onDone runs whether or not an ad showed. */
export function showCrazyInterstitial(onDone: () => void): void {
  if (!crazyActive()) {
    onDone();
    return;
  }
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    onDone();
  };
  try {
    sdk!.ad.requestAd('midgame', { adFinished: done, adError: done });
  } catch {
    done();
  }
}

/** Gameplay signals CrazyGames uses to pause house UI / time ads. Safe no-ops off-portal. */
export function crazyGameplayStart(): void {
  try {
    if (crazyActive()) sdk!.game.gameplayStart();
  } catch {
    /* ignore */
  }
}
export function crazyGameplayStop(): void {
  try {
    if (crazyActive()) sdk!.game.gameplayStop();
  } catch {
    /* ignore */
  }
}
