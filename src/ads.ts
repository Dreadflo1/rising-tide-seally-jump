// Ad manager: interstitial (between plays) and rewarded (revive) ads,
// backed by the real GameDistribution HTML5 SDK when it's available, with
// a simulated in-canvas fallback for local dev / before the game has a
// real GD gameId registered (see index.html's GD_OPTIONS.gameId).
//
// Banner stays simulated on purpose: GameDistribution serves its own
// display ads around the game *outside* the canvas once you're hosted on
// their portal — you don't build that part. This in-canvas banner is just
// a lightweight house-ad look for when you're self-hosting.

import Phaser from 'phaser';
import { getState } from './state';
import { S } from './constants';
import { runInterstitial, InterstitialController } from './interstitialController';
import { webAdsActive, webRewardedReady, showWebRewarded, showWebInterstitial } from './webAds';
import { crazyActive, crazyRewardedReady, showCrazyRewarded, showCrazyInterstitial } from './crazyAds';

// Pause/resume a Phaser scene around a web (AdSense H5) ad overlay.
function pauseSceneForAd(scene: Phaser.Scene) {
  scene.sound.mute = true;
  if (scene.scene.isActive()) scene.scene.pause();
}
function resumeSceneAfterAd(scene: Phaser.Scene) {
  if (scene.scene.isPaused()) scene.scene.resume();
  scene.sound.mute = getState().muted;
}

declare global {
  interface Window {
    // GameDistribution HTML5 SDK: `gdsdk.showAd()` plays a full-screen video ad
    // (returns a Promise that settles when the ad flow ends) and drives the game
    // via SDK_GAME_PAUSE / SDK_GAME_START events.
    gdsdk?: {
      showAd: (adType?: string) => Promise<void>;
      preloadAd?: (adType?: string) => Promise<void>;
      AdType?: { Interstitial: string; Rewarded: string };
    };
    GD_OPTIONS?: { gameId?: string; onEvent?: (e: { name: string }) => void };
  }
}

const SPONSORS = [
  'Protect Our Reefs Foundation',
  'Blue Wave Ocean Trust',
  'Coral Guardians Alliance',
  'Clean Seas Initiative',
  'Monk Seal Rescue Network',
];

// Quiet, opt-in ad diagnostics. Off by default so the production/Verify console
// stays clean (these used to be console.error, which rendered as red "errors").
// Enable at runtime with `window.__SEAL_AD_DEBUG__ = true` then reproduce.
function adDbg(...args: unknown[]) {
  if ((window as unknown as { __SEAL_AD_DEBUG__?: boolean }).__SEAL_AD_DEBUG__) {
    console.log('[seal-ad]', ...args);
  }
}

// ---- GameDistribution SDK glue ----------------------------------------
//
// GameDistribution's HTML5 SDK (html5.api.gamedistribution.com) uses a
// pause/resume event model: SDK_GAME_PAUSE when an ad opens, SDK_GAME_START
// when it closes (or no-fills). index.html only injects the SDK once a real
// gameId is set, so until then this whole block stays dormant and the
// simulated overlay runs — no console noise, no dead real-ad path.

let gmReady = false;
let activeScene: Phaser.Scene | null = null;
// The controller for the interstitial currently in flight (if any). SDK events
// are routed into it: SDK_GAME_PAUSE => markAdShown, SDK_GAME_START => markComplete.
let activeController: InterstitialController | null = null;
// Rewarded-ad state: set while a rewarded ad is in flight. The reward is granted
// only on SDK_REWARDED_WATCH_COMPLETE (the user watched it fully); the flow
// finishes on SDK_GAME_START (ad closed).
let pendingRewardGrant: (() => void) | null = null;
let pendingRewardClose: (() => void) | null = null;
// True once a rewarded ad has been preloaded and is ready to show. Used to only
// OFFER the "watch an ad for a bonus" buttons when an ad actually exists — no
// point showing a button that just says "no ad available".
let rewardedReady = false;

/** Ask GD to preload a rewarded ad. Sets rewardedReady on success so the UI can
 *  decide whether to show the rewarded buttons. Called on SDK_READY and again
 *  after each rewarded ad is consumed. */
function preloadRewarded() {
  const gd = window.gdsdk;
  if (!canUseRealAds() || !gd || typeof gd.preloadAd !== 'function') {
    rewardedReady = false;
    return;
  }
  const preload = gd.preloadAd;
  const type = gd.AdType && gd.AdType.Rewarded ? gd.AdType.Rewarded : 'rewarded';
  preload(type)
    .then(() => {
      rewardedReady = true;
      adDbg('rewarded preloaded -> available');
    })
    .catch(() => {
      rewardedReady = false;
      adDbg('rewarded preload failed -> unavailable');
    });
}

/** Synchronous check for the UI: is a rewarded ad ready to show right now? */
export function isRewardedReady(): boolean {
  return rewardedReady || crazyRewardedReady() || webRewardedReady();
}

function resumeActiveScene() {
  if (activeScene && activeScene.scene.isPaused()) {
    activeScene.scene.resume();
    activeScene.sound.mute = getState().muted;
  }
}

window.addEventListener('gm-sdk-event', (e: Event) => {
  const name = (e as CustomEvent).detail?.name;
  // Diagnostic: shows every GameDistribution SDK event in the browser console so
  // ad behaviour (fill / no-fill / errors) is visible during the Verify step.
  adDbg('SDK event:', name);
  switch (name) {
    case 'SDK_READY':
      gmReady = true;
      // Warm up a rewarded ad so the Game Over screen knows whether to offer it.
      preloadRewarded();
      break;
    case 'SDK_GAME_PAUSE':
      // An ad is actually opening — pause gameplay/sound underneath it, and mark
      // that a REAL ad displayed (this is our fill signal, not the Promise).
      if (activeScene && activeScene.scene.isActive()) {
        activeScene.sound.mute = true;
        activeScene.scene.pause();
      }
      activeController?.markAdShown();
      break;
    case 'SDK_REWARDED_WATCH_COMPLETE':
      // The user watched a rewarded ad all the way through — mark it so the
      // reward is granted when the ad flow finishes.
      if (pendingRewardGrant) pendingRewardGrant();
      break;
    case 'SDK_GAME_START':
      // Ad closed (or the SDK is resuming the game) — resume, then let whichever
      // ad is in flight finish (interstitial controller, or a rewarded ad).
      resumeActiveScene();
      activeController?.markComplete();
      if (pendingRewardClose) {
        const cb = pendingRewardClose;
        pendingRewardClose = null;
        cb();
      }
      break;
    default:
      break;
  }
});

/** True only once a *real* gameId has been wired into index.html. Until then
 * the SDK isn't even loaded, so real ads are unavailable and the simulated
 * overlays run instead. */
function hasRealGameId(): boolean {
  const gid = window.GD_OPTIONS?.gameId;
  return typeof gid === 'string' && gid.length > 0 && gid !== 'YOUR_GAMEDISTRIBUTION_ID';
}

/** True when a real gameId is set and the GameDistribution SDK object is present.
 * We intentionally do NOT wait on the SDK_READY event here — if the SDK is
 * loaded we call gdsdk.showAd() and let it own the ad slot, so a genuine
 * GameDistribution ad is always requested (and can be verified) rather than
 * being skipped in favour of the simulated fallback. */
function canUseRealAds(): boolean {
  const ready = hasRealGameId() && typeof window.gdsdk?.showAd === 'function';
  adDbg('canUseRealAds', {
    hasRealGameId: hasRealGameId(),
    sdkType: typeof window.gdsdk,
    showAdType: typeof window.gdsdk?.showAd,
    gmReady,
    ready,
  });
  return ready;
}

// ---- Public API ---------------------------------------------------------

export function showBanner(scene: Phaser.Scene, y: number) {
  if (getState().adsRemoved) return null;
  const w = scene.scale.width;
  const container = scene.add.container(0, y).setDepth(500);
  const bg = scene.add.rectangle(w / 2, 0, w, S(46), 0x0a2436, 0.92).setStrokeStyle(S(1), 0x2a6f7f);
  const label = scene.add
    .text(w / 2, -S(10), 'ADVERTISEMENT', {
      fontFamily: '"Nunito", sans-serif',
      fontSize: `${S(10)}px`,
      color: '#7fdfff',
    })
    .setOrigin(0.5);
  const sponsor = Phaser.Utils.Array.GetRandom(SPONSORS);
  const msg = scene.add
    .text(w / 2, S(8), `💚 Sponsored by ${sponsor}`, {
      fontFamily: '"Nunito", sans-serif',
      fontSize: `${S(13)}px`,
      color: '#ffffff',
    })
    .setOrigin(0.5);
  container.add([bg, label, msg]);
  return container;
}

/** Interstitial shown between plays.
 *
 * Fill is decided by the SDK's SDK_GAME_PAUSE event (a real ad actually opened),
 * NOT by the showAd() Promise — see interstitialController.ts. If GameDistribution
 * has an ad, it plays and then we continue. If GD serves nothing (unapproved
 * preview, or a frequency-capped replay), the player just continues for FREE —
 * no house ad. This keeps replays smooth and shows a real ad only when GD
 * actually has one (which is where the revenue is anyway). */
export function showInterstitial(scene: Phaser.Scene, onDone: () => void) {
  adDbg('showInterstitial called', {
    adsRemoved: getState().adsRemoved,
    scene: scene.scene.key,
  });
  if (getState().adsRemoved) {
    adDbg('skipping interstitial because adsRemoved');
    onDone();
    return;
  }
  if (!canUseRealAds()) {
    // No GameDistribution source. On the CrazyGames portal, let their SDK serve
    // the interstitial; on our own site, try the web ad provider (AdSense H5);
    // otherwise continue for FREE.
    if (crazyActive()) {
      pauseSceneForAd(scene);
      showCrazyInterstitial(() => {
        resumeSceneAfterAd(scene);
        onDone();
      });
      return;
    }
    if (webAdsActive()) {
      pauseSceneForAd(scene);
      showWebInterstitial(() => {
        resumeSceneAfterAd(scene);
        onDone();
      });
      return;
    }
    adDbg('SDK not loaded -> free replay');
    onDone();
    return;
  }
  activeScene = scene;
  activeController = runInterstitial({
    showAd: () => {
      const gd = window.gdsdk!;
      // Documented interstitial call is a bare showAd() with no arguments; the
      // ad lifecycle is driven by SDK_GAME_PAUSE / SDK_GAME_START, not the return
      // value. (AdType/args are only needed for rewarded.)
      adDbg('calling gdsdk.showAd()', {
        sdkType: typeof gd,
        showAdType: typeof gd.showAd,
        gmReady,
      });
      return gd.showAd();
    },
    onRealAd: () => {
      adDbg('real GD ad displayed -> continue');
      activeController = null;
      resumeActiveScene();
      onDone();
    },
    onNoAd: () => {
      // GameDistribution has no ad to serve right now (frequency cap / no-fill).
      // Give the player a free replay instead of a house ad — better UX, and the
      // real GD ad still shows whenever GD does have one.
      adDbg('no GD ad -> free replay');
      activeController = null;
      resumeActiveScene();
      onDone();
    },
    setTimer: (ms, cb) => window.setTimeout(cb, ms),
    clearTimer: (id) => window.clearTimeout(id),
    safetyMs: 60000,
    graceMs: 2500,
  });
}

/** Rewarded ad (opt-in): the player chooses to watch a full ad for a bonus.
 *
 * The reward is granted ONLY if the ad is watched to completion
 * (SDK_REWARDED_WATCH_COMPLETE). If GameDistribution has no rewarded ad to serve
 * (no-fill — common on the unapproved preview) or the player closes it early,
 * `onUnavailable` runs and NO reward is given. GD rewarded ads are preloaded
 * before showing, per their SDK. */
export function showRewardedAd(scene: Phaser.Scene, onReward: () => void, onUnavailable: () => void) {
  if (!canUseRealAds() || !rewardedReady) {
    // No GD rewarded ad. On the CrazyGames portal, use their rewarded ad first.
    if (crazyActive()) {
      pauseSceneForAd(scene);
      showCrazyRewarded(
        () => {
          resumeSceneAfterAd(scene);
          onReward();
        },
        () => {
          resumeSceneAfterAd(scene);
          onUnavailable();
        }
      );
      return;
    }
    // On our own site, try the web provider (AdSense H5).
    if (webAdsActive()) {
      pauseSceneForAd(scene);
      showWebRewarded(
        () => {
          resumeSceneAfterAd(scene);
          onReward();
        },
        () => {
          resumeSceneAfterAd(scene);
          onUnavailable();
        }
      );
      return;
    }
    adDbg('rewarded: none ready -> unavailable');
    onUnavailable();
    return;
  }
  rewardedReady = false; // consuming the preloaded ad
  activeScene = scene;
  let watched = false;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(safety);
    pendingRewardGrant = null;
    pendingRewardClose = null;
    resumeActiveScene();
    preloadRewarded(); // warm up the next one for later
    if (watched) onReward();
    else onUnavailable();
  };
  // SDK_REWARDED_WATCH_COMPLETE marks the reward as earned; SDK_GAME_START
  // (ad closed) finishes the flow. Safety net for a silent SDK.
  pendingRewardGrant = () => {
    watched = true;
  };
  pendingRewardClose = finish;
  const safety = window.setTimeout(finish, 60000);
  try {
    const gd = window.gdsdk!;
    const type = gd.AdType && gd.AdType.Rewarded ? gd.AdType.Rewarded : 'rewarded';
    adDbg('rewarded: showAd', { type });
    // Ad was already preloaded (rewardedReady). A rejection = it failed -> finish
    // (unavailable). The success path is driven by the SDK events above.
    Promise.resolve(gd.showAd(type)).catch((err) => {
      adDbg('rewarded: showAd rejected -> unavailable', err);
      finish();
    });
  } catch (err) {
    adDbg('rewarded: threw -> unavailable', err);
    finish();
  }
}
