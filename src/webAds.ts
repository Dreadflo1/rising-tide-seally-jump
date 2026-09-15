// Web ad provider for the self-hosted build (seally.best) — Google AdSense
// "H5 Games Ads" (the adBreak() API) for rewarded + interstitial, plus display
// banners. It only ever activates when ALL of these hold:
//   • an AdSense client id is configured (fetched from /api/config), and
//   • we're NOT on the GameDistribution CDN (that build uses its own SDK), and
//   • the player hasn't bought Remove Ads (state.adsRemoved).
// Everything soft-fails: with no client, an ad blocker, or offline, the game is
// completely unaffected (no ads = free play, nothing breaks).
//
// Requires the user's AdSense account approved for H5 Games Ads. Set env vars
// ADSENSE_CLIENT (ca-pub-…), ADSENSE_SLOT_GAMEOVER, ADSENSE_SLOT_FOOTER — see
// api/config.ts. Nothing here charges or serves until that id is live.

import { getState } from './state';

// Public AdSense publisher id (safe to ship — it's exposed in every ad request).
// Used as the default so the ad script loads on our own domain even before the
// Vercel env vars are set (needed for Google's site review). Env config can still
// override it + supply the display slot ids.
const DEFAULT_CLIENT = 'ca-pub-6872808751357725';

let client = '';
let slotGameOver = '';
let slotFooter = '';
let ready = false; // adConfig onReady fired
let scriptRequested = false;

interface W {
  adsbygoogle?: unknown[];
  adBreak?: (o: Record<string, unknown>) => void;
  adConfig?: (o: Record<string, unknown>) => void;
}

// Standard H5 shims: queue adBreak/adConfig calls until the real script loads.
function ensureShims() {
  const w = window as unknown as W;
  w.adsbygoogle = w.adsbygoogle || [];
  w.adBreak = w.adBreak || ((o) => (w.adsbygoogle as unknown[]).push(o));
  w.adConfig = w.adConfig || ((o) => (w.adsbygoogle as unknown[]).push(o));
}

export function webAdsConfigured(): boolean {
  return !!client;
}

/** Active only on OUR OWN site (seally.best / localhost), with a client set and
 *  ads not removed. Crucially it stays OFF inside any game portal (CrazyGames,
 *  Poki, GameDistribution…) — those serve their own ads via their SDK, and loading
 *  AdSense inside them would break both our and their policies. */
export function webAdsActive(): boolean {
  if (!client) return false;
  try {
    const h = location.hostname;
    const ours = /(^|\.)seally\.best$/i.test(h) || h === 'localhost' || h === '127.0.0.1';
    if (!ours) return false;
  } catch {
    return false;
  }
  return !getState().adsRemoved;
}

/** Fetch the ad config and, if configured, load the AdSense H5 script once. */
export async function initWebAds() {
  // Only ever run on OUR OWN host. On a game portal (CrazyGames, GD…) there's no
  // /api/config to fetch — hitting it just yields a 404 that shows up as a
  // "resource couldn't be loaded" warning in CrazyGames' QA — and AdSense must
  // stay off there anyway (see webAdsActive).
  try {
    const h = location.hostname;
    const ours = /(^|\.)seally\.best$/i.test(h) || h === 'localhost' || h === '127.0.0.1';
    if (!ours) return;
  } catch {
    return;
  }
  let ads: { client?: string; slotGameOver?: string; slotFooter?: string } = {};
  try {
    const res = await fetch('/api/config');
    ads = (await res.json().catch(() => ({})))?.ads || {};
  } catch {
    /* offline / no backend — fall back to the hardcoded default below */
  }
  client = String(ads.client || DEFAULT_CLIENT);
  slotGameOver = String(ads.slotGameOver || '');
  slotFooter = String(ads.slotFooter || '');
  if (!webAdsActive() || scriptRequested) return;
  scriptRequested = true;
  ensureShims();
  const w = window as unknown as W;
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  s.setAttribute('data-ad-frequency-hint', '30s');
  s.onload = () => {
    try {
      w.adConfig?.({
        preloadAdBreaks: 'on',
        sound: 'on',
        onReady: () => {
          ready = true;
        },
      });
    } catch {
      /* ignore */
    }
  };
  s.onerror = () => {
    /* ad blocker / network — provider stays inert, game unaffected */
  };
  document.head.appendChild(s);
}

// Circuit breakers. AdSense H5 "adBreak" only works once the account is APPROVED
// for H5 Games Ads; until then the SDK loads but adBreak() never calls its
// adBreakDone callback — which, because we pause the scene before showing an ad,
// froze the game (the reported "Play Again is stuck / ad never shows" bug). So we
// arm a safety timeout on every adBreak; if it fires, we resume the game AND flag
// the provider as non-functional so subsequent plays skip the ad entirely (free
// replay, no wait). The flags reset on reload, so the moment H5 is approved and
// adBreakDone fires normally they never get set.
let interstitialBroken = false;
let rewardedBroken = false;

const INTERSTITIAL_START_MS = 2500; // if no ad even STARTS within this, continue
const AD_PLAYING_SAFETY_MS = 25000; // once an ad started, absolute cap so we never hang
const REWARDED_TIMEOUT_MS = 30000; // generous: a real rewarded video may run this long

/** Rewarded ads are considered available once the SDK is configured + ready — and
 *  not after it has proven unresponsive this session. */
export function webRewardedReady(): boolean {
  return webAdsActive() && (ready || scriptRequested) && !rewardedBroken;
}

/** Show a rewarded video. onReward fires ONLY if it was watched to completion;
 *  onClose fires if dismissed early / no fill / not configured. */
export function showWebRewarded(onReward: () => void, onClose: () => void) {
  if (!webAdsActive() || rewardedBroken) {
    onClose();
    return;
  }
  const w = window as unknown as W;
  let earned = false;
  let settled = false;
  const done = (reward: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    reward ? onReward() : onClose();
  };
  // Safety net: if the SDK never calls adBreakDone (unapproved H5 / stuck), close
  // out with no reward and stop offering rewarded ads this session.
  const timer = window.setTimeout(() => {
    rewardedBroken = true;
    done(false);
  }, REWARDED_TIMEOUT_MS);
  try {
    w.adBreak?.({
      type: 'reward',
      name: 'reward',
      beforeReward: (showAdFn: () => void) => {
        try {
          showAdFn();
        } catch {
          /* ignore */
        }
      },
      adDismissed: () => done(false),
      adViewed: () => {
        earned = true;
      },
      adBreakDone: () => done(earned),
    });
  } catch {
    done(false);
  }
}

/** Interstitial between plays. ALWAYS calls onDone — quickly — whether or not an
 *  ad showed, so "Play Again" can never freeze on a stuck/unapproved ad SDK. */
export function showWebInterstitial(onDone: () => void) {
  // Not configured, or the SDK already proved unresponsive → replay for free, now.
  if (!webAdsActive() || interstitialBroken) {
    onDone();
    return;
  }
  const w = window as unknown as W;
  let settled = false;
  let timer = 0;
  const finish = (broke: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    if (broke) interstitialBroken = true;
    onDone();
  };
  // Phase 1: if NO ad even starts within INTERSTITIAL_START_MS, it's a no-fill or
  // an unapproved/stuck SDK → continue and stop attempting interstitials this
  // session (self-heals on reload once H5 works). Phase 2: once beforeAd fires a
  // real ad is playing, so we swap to a long absolute cap instead of cutting it off.
  timer = window.setTimeout(() => finish(true), INTERSTITIAL_START_MS);
  try {
    w.adBreak?.({
      type: 'next',
      name: 'replay',
      beforeAd: () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => finish(false), AD_PLAYING_SAFETY_MS);
      },
      adBreakDone: () => finish(false),
    });
  } catch {
    finish(false);
  }
}

/** Mount a display banner into a container. Returns true if a unit was placed.
 *  'gameover' = 300×250; 'footer' = 728×90 desktop / 320×50 mobile. */
export function mountBanner(container: HTMLElement, kind: 'gameover' | 'footer'): boolean {
  if (!webAdsActive()) return false;
  const slot = kind === 'gameover' ? slotGameOver : slotFooter;
  if (!slot) return false;
  container.innerHTML = '';
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'inline-block';
  if (kind === 'gameover') {
    ins.style.width = '300px';
    ins.style.height = '250px';
  } else {
    const desktop = window.innerWidth >= 728;
    ins.style.width = desktop ? '728px' : '320px';
    ins.style.height = desktop ? '90px' : '50px';
  }
  ins.setAttribute('data-ad-client', client);
  ins.setAttribute('data-ad-slot', slot);
  container.appendChild(ins);
  try {
    ((window as unknown as W).adsbygoogle as unknown[]).push({});
  } catch {
    /* ignore */
  }
  return true;
}
