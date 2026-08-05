[OPEN] Debug Session: verify-no-ad

## Symptom
- Game loads in GameMonetize Verify, but no ad appears during the expected verify/play flow.

## Scope
- Runtime debugging only.
- No gameplay/ad-policy logic changes before evidence.

## Hypotheses
1. The game is not actually calling the GameMonetize interstitial/rewarded SDK path when Verify expects it.
2. The game calls the SDK, but GameMonetize Verify suppresses the ad and only emits SDK lifecycle events.
3. The current uploaded bundle is stale, so Verify is still running an older ad path than the latest source.
4. A local fallback or scene transition resumes gameplay before a real SDK ad can display.
5. Unrelated portal API errors like `/api/leaderboard` 404 are noisy but not the root cause of the missing ad.

## Evidence Log
- User confirms game now renders in Verify.
- Verify console shows `sdk.js` loaded with a permissions-policy warning only.
- Verify console shows repeated `/api/leaderboard` 404s.
- Static code path confirms first title-screen play is intentionally free, while `GameOverScene` `PLAY AGAIN` always calls `showInterstitial()`.
- Ad-path instrumentation added to title play, game-over replay, SDK event handling, and `showInterstitial()`.
- Latest user-provided console still shows the old `attempting service worker registration` line and none of the new `[debug verify-no-ad]` logs.
- That is strong evidence Verify is still serving an older uploaded package, not the current ad-debug build.
- Added startup build marker `[debug build-id] gm-ad-debug-2026-07-30-b` to remove ambiguity on the next upload.
- To defeat portal-side caching of the root bundle, production entry filenames were changed from stable `game.js` / `game.css` to versioned root files using build tag `gm-ad-debug-2026-07-30-c`.
- Rebuilt `dist` and confirmed it now only contains `game-gm-ad-debug-2026-07-30-c.js` / `.css`, not `game.js` / `game.css`.
- Repacked `gamemonetize-upload-gm-ad-debug-2026-07-30-c.zip` with Python `zipfile` and verified the archive contains only `index.html`, `game-gm-ad-debug-2026-07-30-c.js`, and `game-gm-ad-debug-2026-07-30-c.css` as root entry files.
- User's newest Verify console still reports source locations as `game.js:87` and still logs `attempting service worker registration`, which is conclusive evidence that GameMonetize is serving stale HTML/JS from a previous upload or cache layer.
- User-provided Network screenshot shows many requests initiated by `sw.js:59` and fulfilled by `ServiceWorker`, while runtime requests still originate from `game.js:68`, further confirming the hosted page is controlled by an old service worker and old startup bundle rather than the new `game-gm-ad-debug-2026-07-30-c.js` build.
- User-provided later console shows runtime source still as `game.js` and uses older `[seal-ad]` diagnostics that do not exist in the current source, confirming Verify is serving neither the newest `-c` bundle nor the current `debug verify-no-ad` instrumentation.
- The same later console also shows real GameMonetize SDK failures before gameplay starts: `AD_SDK_ERROR ReferenceError: google is not defined`, `AD_CANCELED`, `SDK_ERROR The SDK failed`, and later `SDK_SHOW_BANNER Advertisements are disabled`.
- That evidence indicates a second independent blocker beyond stale hosting: even on the stale build, the provider SDK is failing/no-filling in the Verify session, so no ad can render regardless of the game's replay flow.

## Status
- Waiting for portal-side cache to serve the new versioned entry files before continuing real ad-path diagnosis.
