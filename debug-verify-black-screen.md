[OPEN] Debug Session: verify-black-screen

## Symptom
- Game shows a black screen during SDK verify / startup instead of rendering the game.

## Scope
- Runtime debugging only.
- No business-logic fix before evidence.

## Hypotheses
1. A startup exception is thrown during `GameOverScene` or startup module evaluation, preventing Phaser from rendering.
2. The GameMonetize verify environment triggers an SDK/runtime error that blocks the game loop before first frame.
3. A text/emoji/font rendering change in the game-over scene crashes or stalls canvas rendering on the verify browser.
4. Service worker or cached assets are causing stale/broken startup assets to load in Verify.
5. Phaser starts, but a scene transition or fatal async error leaves only the background/blank canvas visible.

## Evidence Log
- Verify console shows `GET https://html5.gamemonetize.com/<game-id>/assets... 404 (Not Found)`.
- Follow-up verify console still shows startup bundle 404s for the latest hashed files, confirming `index.html` updates reach the host while the referenced bundle files do not.
- Verify console shows `GET https://imasdk.googleapis.com/js/sdkloader/ima3.js net::ERR_BLOCKED_BY_CLIENT`.
- Local archive inspection confirms the ZIP contains `index.html` and hashed `assets/...` files with matching references.
- The missing asset request happens before game startup completes, which explains the black screen.
- Post-fix verify logs show `game.js` loads and Phaser reaches `LoginScene`, but nested asset requests like `sprites/player_seal.png` and `backgrounds/bg_lagoon.png` still 404 on `html5.gamemonetize.co`.
- The service-worker debug log showed registration still happening in Verify, which exposed a host-matching bug: code only matched `gamemonetize.com`, while Verify actually runs on `gamemonetize.co`.

## Hypothesis Status
- H1 startup exception in gameplay/share scene: not supported by current evidence.
- H2 SDK/runtime fatal block: partially rejected; `ima3.js` blocked is noisy but the stronger failure is the game asset 404.
- H3 emoji/font rendering crash: not supported by current evidence.
- H4 service worker / cached stale build on portal host: partially supported, plus host-match bug prevented the mitigation from applying on `.co`.
- H5 scene transition leaves blank canvas: not supported by current evidence.

## Confirmed Root Cause
- GameMonetize Verify serves root-level uploaded files, but nested runtime folders are unreliable there in this game's hosting path.
- Our GameMonetize host detection also missed `.co`, so the SW/cache mitigation did not activate in Verify.

## Fix Direction
- Disable service worker usage on GameMonetize hosts and proactively clear old `seal-jump-*` caches / registrations there.
- Rebuild and repackage a fresh upload ZIP after the service-worker mitigation.
- Simplify the production boot files to stable root-level `game.js` and `game.css` so Verify no longer depends on hashed startup files under `assets/`.
- Flatten runtime image/audio files into the ZIP root for production and load those flat paths on GameMonetize hosts.

## Status
- Fix applied and packaged. Awaiting user verification on the new ZIP.
