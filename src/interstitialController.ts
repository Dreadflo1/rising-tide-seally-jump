// Framework-agnostic interstitial flow controller. Deliberately has NO Phaser /
// DOM imports so it can be unit-tested headlessly
// (see scratchpad/interstitial_test.ts).
//
// Decision rule — deterministic and robust to how the ad SDK reports a no-fill:
// whether a REAL ad played is judged by the SDK's "an ad is displaying" signal
// (GameDistribution fires SDK_GAME_PAUSE ONLY when an ad actually opens), NOT by
// whether showAd()'s Promise resolves or rejects — GD may do EITHER on a
// no-fill, so the Promise result is not a reliable fill signal.
//
//   markAdShown() called (SDK_GAME_PAUSE fired)  => a real ad opened  => onRealAd()
//   markAdShown() never called                    => nothing displayed => onNoAd()
//
// Completion triggers, in order of how fast they usually fire:
//   - markComplete()      : SDK_GAME_START (ad finished, OR resume after no-fill)
//   - Promise reject      : hard no-fill / error
//   - Promise resolve     : if an ad had opened (adShown) -> done; otherwise start
//                           a short GRACE window for a late SDK_GAME_PAUSE, then
//                           treat as no-fill. (GD can resolve at request time on a
//                           frequency-capped no-fill without ever firing an event,
//                           which would otherwise hang until the safety timer.)
//   - safety timer        : last-resort backstop for a totally silent SDK.

export interface InterstitialHooks {
  /** Kick off the real ad. May return a Promise (GameDistribution does). */
  showAd: () => Promise<void> | void;
  /** A real ad actually displayed — continue the game normally. */
  onRealAd: () => void;
  /** No real ad displayed — show the in-game house ad instead. */
  onNoAd: () => void;
  setTimer: (ms: number, cb: () => void) => number;
  clearTimer: (id: number) => void;
  /** How long to wait on a totally silent SDK before giving up (default 60s). */
  safetyMs?: number;
  /** After showAd() resolves with no ad shown, how long to wait for a late
   *  SDK_GAME_PAUSE before deciding it was a no-fill (default 2.5s). */
  graceMs?: number;
}

export interface InterstitialController {
  /** Call when the SDK signals an ad actually opened (e.g. SDK_GAME_PAUSE). */
  markAdShown: () => void;
  /** Call when the SDK signals its ad flow ended (e.g. SDK_GAME_START). */
  markComplete: () => void;
}

export function runInterstitial(hooks: InterstitialHooks): InterstitialController {
  let settled = false;
  let adShown = false;
  let graceTimer: number | null = null;

  const complete = () => {
    if (settled) return;
    settled = true;
    hooks.clearTimer(safety);
    if (graceTimer !== null) hooks.clearTimer(graceTimer);
    if (adShown) hooks.onRealAd();
    else hooks.onNoAd();
  };

  const safety = hooks.setTimer(hooks.safetyMs ?? 60000, complete);

  const onResolve = () => {
    if (settled) return;
    if (adShown) {
      // A real ad had opened and now the Promise resolved => it finished.
      complete();
      return;
    }
    // Resolved but no ad opened yet. Give a short grace for a late
    // SDK_GAME_PAUSE (a real ad still spinning up); if none arrives it was a
    // no-fill. The grace only decides the no-ad case — if a PAUSE does arrive,
    // the ad's own SDK_GAME_START / resolve completes it instead.
    if (graceTimer === null) {
      graceTimer = hooks.setTimer(hooks.graceMs ?? 2500, () => {
        if (!adShown) complete();
      });
    }
  };

  try {
    const p = hooks.showAd();
    if (p && typeof (p as Promise<void>).then === 'function') {
      (p as Promise<void>).then(onResolve, () => complete());
    }
  } catch {
    complete();
  }

  return {
    markAdShown: () => {
      adShown = true;
    },
    markComplete: complete,
  };
}
