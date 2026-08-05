# Rising Tide: Seal Jump — GameDistribution Submission Pack

Everything you need to publish the game on GameDistribution, in one place.

- **Live test build:** https://rising-tide-seal-jump-source.vercel.app
- **GameDistribution Game ID:** `62e58a7f3fa54dabb434af760a9c6b72`
- **Revision URL (before approval, updates on every upload):** https://revision.gamedistribution.com/62e58a7f3fa54dabb434af760a9c6b72
- **Cached URL (after approval):** https://html5.gamedistribution.com/62e58a7f3fa54dabb434af760a9c6b72/

---

## 1. Files to upload

**UPLOAD tab — game files (.zip):** `rising-tide-seal-jump-source.zip`

**ASSETS tab — images (all .jpg, named by their exact size):**

| GameDistribution slot | File |
|---|---|
| **512 × 384** (Required — main thumbnail) | `store-images/512x384.jpg` |
| **512 × 512** (Required — main thumbnail) | `store-images/512x512.jpg` |
| **200 × 120** (Required — main thumbnail) | `store-images/200x120.jpg` |
| **1280 × 720** (Helpful for marketing) | `store-images/1280x720.jpg` |
| **1280 × 550** (Helpful for marketing) | `store-images/1280x550.jpg` |

The ZIP already has `index.html` at its root, forward-slash paths, the real Game ID, self-hosted fonts, and **zero third-party trackers** — the only outbound call is the required GameDistribution ad SDK (`html5.api.gamedistribution.com`).

---

## 2. Form field values (copy-paste)

- **Name:** `Seally - Rising Tide`
- **Type / Sub Type:** `HTML5` / `Javascript`
- **Category (min 2):** `Arcade`, `Casual`, `Hypercasual`
- **Tags:** `seal, jump, endless jumper, arcade, casual, ocean, animal, one-button, mobile, cute`
- **Width:** `540`   **Height:** `960`   *(portrait 9:16 — NOT the default 800x600)*
- **Compatibility:** `MobileAndDesktop` (keyboard arrows + touch both work)
- **No Blood:** ON · **Child Friendly:** ON · **HTTPS Ready:** ON · **Rewarded Ads:** OFF

**Description:**
> Rising Tide: Seal Jump is a one-thumb vertical jumper. Bounce a Hawaiian monk seal ever higher up the coast — never stop, because the tide is rising and speeding up beneath you! Steer to land on platforms (normal, moving, crumbling, springy), collect pearls for combos, earn 12 medals, unlock costume skins and 3 maps that each play differently, and grab power-ups (Dolphin, Ocean Law, Turtle Shield). Collect hearts for extra lives, and dodge trash, oil slicks, poachers, rock-throwers, sharks and divers past 300 m. Beat your best height and climb the leaderboard! 20% of revenue supports The Ocean Cleanup.

**Controls:**
> Desktop: Arrow keys (Left/Right). Mobile/touch: tap and drag left or right to steer. The seal bounces off platforms automatically — aim your landings, grab power-ups, and dodge hazards.

---

## 3. Activation steps

1. On **UPLOAD**, upload `rising-tide-seal-jump-source.zip`.
2. On **ASSETS**, upload the 5 images above into their matching size slots.
3. On **EDIT**, set **Width 540 / Height 960**, **Compatibility MobileAndDesktop**, and paste the Category / Tags / Description / Controls above.
4. Click **Save**.
5. Open the game **through the iframe on the UPLOAD page** and **watch one full advertisement without skipping** — that is the SDK verification check.
6. Once verified, **Request activation** (CHECKLIST tab).

Portal rules the game already complies with: no floating "More Games" button, no timer-triggered ads (ads only fire on the Play Again / menu-restart button), no external iframes, valid `index.html` at the ZIP root.

---

## 4. What's in the game

- **Core:** endless vertical jumper; smooth rising tide that accelerates; procedurally-fair reachable platforms (normal / moving / crumbling / spring).
- **Progression:** 12 medals (each pays pearls), 3 maps that play differently (tougher tide + hazards, more pearls), pearl combos, daily-streak reward for signed-in players.
- **Skins (costumes):** Seally (free), Seally Gold (700), Violet Seally — urchin hat + skirt (1200), Kelp Seally — kelp mohawk + skirt (1500), Hawaiian Seally — lei + grass skirt (1700).
- **Lives:** collect hearts while climbing (max 3) or buy in the shop; a life auto-continues you after a fatal fall.
- **Power-ups:** Dolphin Push, Ocean Law (slows tide), Turtle Shield.
- **Hazards:** floating trash, oil slicks, rock-throwing poachers, and — past 300 m — sharks and poacher-divers.
- **Meta:** username save (localStorage), global leaderboard (fails soft to local), share, mute.
- **Game over:** one Play Again button — always shows the GameDistribution interstitial, then restarts (deterministic; no free replay, no pay-to-skip).
- **Charity:** "20% of revenue supports The Ocean Cleanup, every 6 months."

---

## 5. Ad SDK integration (GameDistribution)

- `index.html` sets `window.GD_OPTIONS = { gameId: '62e58a7f3fa54dabb434af760a9c6b72', onEvent }` and injects `https://html5.api.gamedistribution.com/main.min.js` (only when a real gameId is set).
- `src/ads.ts` shows the interstitial with `gdsdk.showAd()` and resumes the game when the ad Promise settles or `SDK_GAME_START` fires (with a 60 s safety net). It pauses/mutes on `SDK_GAME_PAUSE`.
- Until the SDK is present (local dev / placeholder id) it falls back to a simulated in-canvas ad — never in Verify or production.

---

## 6. After it's approved (optional, needs your accounts)

- **Custom domain:** ad networks often serve better on a real domain than `*.vercel.app`. Point one at the Vercel project when ready.
- **Global leaderboard:** connect **Upstash Redis** in the Vercel dashboard (Storage → Marketplace → Upstash) → it auto-sets the env vars → redeploy. Until then the game uses a local per-device leaderboard (no errors).

---

## 7. Rebuild / redeploy (for future changes)

From `rising-tide-seal-jump-source/`:

```bash
corepack pnpm install      # first time only
corepack pnpm build        # type-check + build to dist/
corepack pnpm dev          # local dev server at http://localhost:5173
vercel --prod --yes        # deploy the live test build
```

To rebuild the upload ZIP with correct (forward-slash) paths, use `System.IO.Compression.ZipArchive` — **not** plain `Compress-Archive`, which writes backslash paths that break on GameDistribution's server.
