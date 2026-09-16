import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S } from '../constants';
import { getState, registerRun, MAPS, SKINS, MAX_LIVES, addLife, spendLife, resetRunLives, addTrashCleaned } from '../state';
import { crazyGameplayStart, crazyGameplayStop } from '../crazyAds';
import { playSfx, gestureUnlock } from '../audio';
import { tuning } from '../tuning';

type PlatKind = 'normal' | 'move' | 'break' | 'spring' | 'slip';
type HazardKind = 'trash' | 'rock' | 'oil' | 'shark' | 'human';

interface PowerupData {
  kind: 'dolphin' | 'law' | 'shield';
}

// ---- Jump physics (design-pixel units, scaled by S() at use-site) ----
// gravity: S(1400) is set in main.ts's physics config
const GRAVITY = 1400;
const NORMAL_JUMP_VEL = 560; // magnitude; applied as negative (upward)
const SPRING_JUMP_VEL = 820;

// Max apex height reachable above a bounce point: v^2 / (2g)
const NORMAL_APEX = (NORMAL_JUMP_VEL * NORMAL_JUMP_VEL) / (2 * GRAVITY); // ~112 design px
// Safety margin so every generated gap is *comfortably* reachable with a
// normal bounce, leaving slack for imperfect timing / horizontal drift.
const MAX_SAFE_GAP = NORMAL_APEX * 0.8; // ~90 design px
const MIN_GAP = 62;

// Max horizontal distance the player can realistically cover during a
// bounce arc (time-to-apex-and-back at max horizontal speed, with margin).
const MAX_HORIZONTAL_OFFSET = 118;

const MOVE_SPEED = 280; // player horizontal move speed (design px/s)

// ---- Mobile touch steering ----
// Half-screen model (the genre standard, and what players instinctively try):
// touch/hold the LEFT half of the screen → steer left, the RIGHT half → steer
// right, at full speed. A quick tap on a side nudges that way; holding keeps
// going. Only a thin dead band at the exact centre line yields no steering, so
// "I tapped and nothing happened" can't occur off-centre. The velocity smoothing
// below still ramps the speed up softly, so it never feels twitchy. (The old
// "steer toward your finger, with a dead zone AROUND the seal" model made a tap
// near the seal's column — often the centre — do nothing, which read as broken.)
const TOUCH_CENTER_DEADBAND_DESIGN = 14;

// ---- Progression zones (metres) ----
// Onboarding: safe, teaches the jump + item shapes. Flow: ramps gap/hazards
// smoothly. Mastery: fullest mix, but the tide speed is capped so the challenge
// comes from placement + timing, not an unsurvivable speed wall.
const ONBOARDING_M = 300;
const FLOW_M = 800;

// ---- Tide tuning (design-pixel units) ----
// The tide rises at a CONSTANT speed for the ENTIRE run — the same rate at 20 m
// as at 2500 m. It never accelerates and never "chases": predictable, learnable
// pressure. ALL of the escalating difficulty comes from the traps, placed on a
// randomised metre grid in generatePlatformAt (random type + random spacing).
//
// The player climbs at ~85–95 design px/s when bouncing cleanly, so a constant
// 74 keeps the water just behind a competent climber — you stay ahead while you
// keep moving, but any obstacle that knocks you back or slows your line lets it
// close in. Scaled per map by tideMult (lagoon 1 / reef 1.15 / storm 1.35).
// Only two things ever touch the rate: the opening grace, and the Ocean-Law
// powerup (slows it briefly).
const TIDE_SPEED = 92; // constant base rise (design px/s), same pace all run long
const TIDE_START_OFFSET_DESIGN = 250; // how far below the first platform the tide starts
const TIDE_START_GRACE_MS = 2500; // opening window where the tide barely moves
const TIDE_START_GRACE_MAX_SPEED = 6; // max design px/s during that window
// LEASH (hard rule): the tide is never more than tuning.maxMetersBelow METRES
// below the seal, measured against a SMOOTHED seal height (an EMA of the seal's y)
// so a one-off spring apex he falls back from doesn't yank the water up. A capped
// catch-up closes the gap smoothly as it nears the leash, and a hard clamp
// guarantees it never exceeds it — so the water stays just under you, always
// visible and looming, and can never be escaped for good.
const TIDE_CATCHUP_GAIN_M = 22; // extra design px/s of catch-up per metre beyond the leash
const TIDE_CATCHUP_MAX = 130; // cap on the catch-up

// ---- Positive-item spacing (metres) ----
// Deterministic cadences so items never clump. Doubled from the first pass.
const PEARL_SPACING_M = 16; // a pearl every ~16 m (occasional reward, not clutter)
const POWERUP_SPACING_M = 48; // a power-up every ~48 m
const LIFE_SPACING_M = 360; // a life every 360 m
const FIRST_TRAP_M = 50; // generous onboarding: NO traps in the first ~50 m
const LITTER_SPACING_M = 15; // metres between collectible ocean-trash pieces (cleanup mechanic)

export default class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private platforms!: Phaser.Physics.Arcade.Group;
  private coins!: Phaser.Physics.Arcade.Group;
  private powerups!: Phaser.Physics.Arcade.Group;
  private hazards!: Phaser.Physics.Arcade.Group;
  private hearts!: Phaser.Physics.Arcade.Group;
  private litter!: Phaser.Physics.Arcade.Group; // collectible ocean trash (the cleanup mechanic)

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private pointerDown = false;
  private pointerX = 0;

  private tideY = 0;
  private tideSpeed = TIDE_SPEED; // design px per second, rises (decreasing y)
  private baseTideSpeed = TIDE_SPEED;
  private tideSealRefY = 0; // smoothed seal height the leash measures against (0 = uninit)
  private runStartTime = 0;
  private tideSlowUntil = 0;
  private tideGraceUntil = 0; // opening grace: tide held gentle so the first jumps are safe
  private tideSprite!: Phaser.GameObjects.TileSprite;

  private highestY = 0; // smallest y reached (highest point)
  private scoreMeters = 0;
  private coinsCollected = 0;
  private scoreText!: Phaser.GameObjects.Text;
  private tideWarnText!: Phaser.GameObjects.Text;

  private lastPlatformY = 0;
  private lastPlatformX = 0;
  private difficultyLevel = 0;
  // Rhythm counter: 0,1 = calm steps, 2 = "technical" step (bigger gap/offset).
  // Cycles 0→1→2→0.
  private stepInPattern = 0;
  // Rock-type variety system (design guidelines): the last few platform kinds, to
  // enforce fairness constraints (≤2 non-stable in a row, ≥1 stable per 5), and a
  // counter so Bouncy springs are never placed two too close together.
  private recentKinds: PlatKind[] = [];
  private platsSinceSpring = 99;
  // Near-miss beats (design guidelines): periodically stage a stable→move→break
  // sequence — land on a drifting rock, then a crumbling one you must leave fast —
  // for the "I only just made it" thrill. Always reachable/fair.
  private nextNearMissMeter = 55;
  private nearMissStage: 'none' | 'move' | 'break' = 'none';

  private invulnerableUntil = 0;
  private slipperyUntil = 0;
  private lastAnnouncedLevel = 1;
  private shieldActive = false;
  private shieldIcon?: Phaser.GameObjects.Arc; // protective bubble drawn around the seal
  private speedBoostUntil = 0;
  private pushCompanion?: Phaser.GameObjects.Image;

  private isGameOver = false;
  private bgKey = 'bg_lagoon';
  private bg!: Phaser.GameObjects.Image;

  private jokerCooldownText?: Phaser.GameObjects.Text;
  private comboCoins = 0;
  private comboTimer = 0;

  // Per-map gameplay modifiers (set from the selected map in create()).
  private hazardMult = 1;
  private coinMult = 1;
  private mapTideMult = 1; // per-map tide multiplier; combined live with tuning.tideSpeed

  // Lives HUD (hearts). Lives are collected as ❤️ pickups while climbing.
  private livesText!: Phaser.GameObjects.Text;
  // World-y of the last heart spawned, to keep hearts rare and well-spaced.
  // Deterministic item/trap placement, keyed by climb height in metres. Each is
  // the next height at which that thing may appear; they self-correct after one
  // placement (so a mid-run revive picks up cleanly).
  // Height (m) of the LAST time each was placed — compared live against tuning.*
  // each spawn, so changing a slider mid-run takes effect on the next platform.
  private lastPearlMeter = 0;
  private lastPowerupMeter = 0;
  private lastLifeMeter = 0;
  private lastLitterMeter = 0; // cadence for collectible trash (the cleanup mechanic)
  private nextTrapMeter = FIRST_TRAP_M; // no traps before this, then randomised gaps
  private nextProjectileMeter = 200; // fly-across hazards (rock @200m, shark @800m), launched from the live view
  // Cleanup mechanic: collect trash to fill this gauge; when full a cleanup boat
  // sweeps the screen and buys a tide breather. Run-local; reset each run.
  private cleanupCount = 0;
  private cleanupGoal = 8;
  private trashThisRun = 0; // total trash collected this run (for the Game Over highlights)
  private boatsThisRun = 0; // cleanup boats triggered this run (highlight)
  private cleanupLabel?: Phaser.GameObjects.Text;
  private boatBusy = false; // guards against re-triggering the boat mid-sweep
  // Shuffle-bag of power-up kinds so the SAME one never repeats redundantly — each
  // of the three is dealt once before any can appear again (varied across any run of 5).
  private powerupBag: PowerupData['kind'][] = [];

  // Coins already banked to the profile for this session. Normally 0 (a run
  // banks everything when it ends), but a rewarded-ad revive carries forward
  // how much was banked at the previous death so the continued run only ever
  // banks the *new* coins collected afterwards — no double-counting.
  private bankedCoins = 0;
  private reviveData: { meters: number; coins: number; bankedCoins: number; adRevived?: boolean } | null = null;
  // True once an AD-revive has been used in this run chain — capped at 1/run so
  // watching ads can't inflate a leaderboard score. (Heart revives are separate.)
  private adRevivedThisRun = false;

  constructor() {
    super('GameScene');
  }

  init(data?: { revive?: { meters: number; coins: number; bankedCoins: number; adRevived?: boolean } }) {
    this.reviveData = data?.revive ?? null;
    this.adRevivedThisRun = data?.revive?.adRevived ?? false;
  }

  create() {
    gestureUnlock(this);
    this.isGameOver = false;
    // CrazyGames: signal active gameplay (no-op off their portal).
    crazyGameplayStart();
    // Mark that a run has begun this session — the title screen uses this to
    // require the ad on every subsequent PLAY (so the menu can't dodge it).
    this.registry.set('playedThisSession', true);
    const st = getState();
    this.bgKey = mapIdToBg(st.selectedMap);

    // Apply the selected map's gameplay flavor: tougher maps rise faster and
    // spawn more hazards (but more coins). This is what makes each unlocked map
    // actually play differently, not just look different.
    const mapDef = MAPS.find((m) => m.id === st.selectedMap) ?? MAPS[0];
    this.mapTideMult = mapDef.tideMult;
    this.baseTideSpeed = tuning.tideSpeed * mapDef.tideMult;
    this.hazardMult = mapDef.hazardMult;
    this.coinMult = mapDef.coinMult;

    const w = this.scale.width;
    const h = this.scale.height;
    this.physics.world.setBounds(0, -10000000, w, 10000000 + h);

    // Single stretched backdrop (like the menus) — the art is one full scene
    // (sun, island, ocean). Tiling it repeated the sun ("two suns"); stretching
    // one copy matches the near-identical canvas aspect with no distortion.
    this.bg = this.add
      .image(w / 2, h / 2, this.bgKey)
      .setDisplaySize(w, h)
      .setScrollFactor(0)
      .setDepth(-10);

    this.platforms = this.physics.add.group({ allowGravity: false, immovable: true });
    this.coins = this.physics.add.group({ allowGravity: false });
    this.powerups = this.physics.add.group({ allowGravity: false });
    this.hazards = this.physics.add.group({ allowGravity: false });
    this.hearts = this.physics.add.group({ allowGravity: false });
    this.litter = this.physics.add.group({ allowGravity: false });

    // Player — sprite + optional tint from the selected skin.
    const skinDef = SKINS.find((s) => s.id === st.selectedSkin) ?? SKINS[0];
    this.player = this.physics.add.sprite(w / 2, h - S(160), skinDef.sprite);
    if (skinDef.tint !== undefined) this.player.setTint(skinDef.tint);
    this.player.setScale(S(0.28));
    this.player.setCollideWorldBounds(false);
    this.player.setBounce(0);
    this.player.setDepth(20);
    this.player.setSize(this.player.width * 0.5, this.player.height * 0.5);

    // Reset run difficulty/score UP-FRONT: Phaser reuses the scene instance on
    // restart, so the class field initialisers don't re-run — without this the
    // starting staircase (generated just below) would use the *previous* run's
    // difficulty, i.e. "restart at the highest level, not from scratch". The
    // full reset block further down (and the revive branch) still applies too.
    this.scoreMeters = 0;
    this.difficultyLevel = 0;
    this.stepInPattern = 0;
    this.lastPearlMeter = 0;
    this.lastPowerupMeter = 0;
    this.lastLifeMeter = 0;
    this.lastLitterMeter = 0;
    this.cleanupCount = 0;
    this.trashThisRun = 0;
    this.boatsThisRun = 0;
    this.boatBusy = false;
    this.nextTrapMeter = tuning.firstTrapM;
    this.nextProjectileMeter = 200; // first poacher rock unlocks at 200 m
    this.powerupBag = [];
    this.recentKinds = [];
    this.platsSinceSpring = 99;
    this.nextNearMissMeter = 55;
    this.nearMissStage = 'none';

    // Equal footing: a FRESH run always starts with 0 lives (persisted/bought
    // lives never carry in), so every player begins the same. Hearts collected
    // during the run still grant revives. A revive (reviveData set) keeps the
    // remaining lives and the run's score — hearts are part of that run.
    if (!this.reviveData) resetRunLives();

    // Starting platform right under player, then a guaranteed-reachable
    // staircase of platforms leading upward.
    this.spawnPlatform(w / 2, h - S(100), 'normal');
    this.lastPlatformY = h - S(100);
    this.lastPlatformX = w / 2;
    for (let i = 1; i < 14; i++) {
      this.generateNextPlatform();
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.pointerDown = true;
      this.pointerX = p.x;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.pointerDown) this.pointerX = p.x;
    });
    this.input.on('pointerup', () => (this.pointerDown = false));

    this.physics.add.collider(this.player, this.platforms, this.handlePlatformCollide, this.checkPlatformCollide, this);
    this.physics.add.overlap(this.player, this.coins, this.handleCoin, undefined, this);
    this.physics.add.overlap(this.player, this.powerups, this.handlePowerup, undefined, this);
    this.physics.add.overlap(this.player, this.hazards, this.handleHazard, undefined, this);
    this.physics.add.overlap(this.player, this.hearts, this.handleHeart, undefined, this);
    this.physics.add.overlap(this.player, this.litter, this.handleLitter, undefined, this);

    // Tide (rising ocean). Starts well below the opening platform so the first
    // jumps are safe; from then on it rises at a constant speed.
    this.tideY = h + S(TIDE_START_OFFSET_DESIGN);
    this.tideSealRefY = 0; // re-init the leash reference each run (set to the seal on frame 1)
    this.tideSprite = this.add
      .tileSprite(w / 2, this.tideY, w, S(260), 'bg_storm')
      .setDepth(15)
      .setAlpha(0.001);
    this.buildTideVisual();

    this.cameras.main.startFollow(this.player, true, 0, 0.12);
    this.cameras.main.setDeadzone(w, h * 0.35);
    this.cameras.main.setFollowOffset(0, -h * 0.18);

    // HUD
    this.scoreText = this.add
      .text(S(16), S(16), '0 m', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(22)}px`,
        color: '#ffffff',
        stroke: '#0b3d5c',
        strokeThickness: S(5),
      })
      .setScrollFactor(0)
      .setDepth(200);

    this.tideWarnText = this.add
      .text(w - S(14), S(14), '', {
        fontFamily: '"Baloo 2","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif',
        fontSize: `${S(21)}px`,
        color: '#8fe3ff',
        stroke: '#0b3d5c',
        strokeThickness: S(5),
        align: 'right',
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(200);

    this.jokerCooldownText = this.add
      .text(w / 2, S(44), '', { fontFamily: FONT_BODY, fontSize: `${S(13)}px`, color: '#06d6a0' })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(200);

    // Lives HUD (hearts) under the score.
    this.livesText = this.add
      .text(S(16), S(46), '', { fontFamily: FONT_BODY, fontSize: `${S(18)}px` })
      .setScrollFactor(0)
      .setDepth(200);
    this.updateLivesHud();

    // Trash counter (top-left, under the hearts): a simple ♻️ tally of ocean trash
    // collected this run. Trash is the currency you spend on skins; collecting
    // enough still launches the cleanup boat (see triggerCleanupBoat).
    this.cleanupLabel = this.add
      .text(S(16), S(82), '', {
        fontFamily: '"Baloo 2","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif',
        fontSize: `${S(16)}px`,
        color: '#7ff0e0',
        stroke: '#0b3d5c',
        strokeThickness: S(4),
      })
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(200);
    this.updateCleanupGauge();

    this.highestY = this.player.y;
    this.scoreMeters = 0;
    this.coinsCollected = 0;
    this.bankedCoins = 0;
    this.tideSpeed = this.baseTideSpeed;
    this.runStartTime = this.time.now;
    this.tideGraceUntil = this.time.now + TIDE_START_GRACE_MS;
    this.slipperyUntil = 0;
    this.lastAnnouncedLevel = 1;

    // Fresh-run goal banner: states the two-pillar objective — climb UP and clean
    // the ocean — then fades so it never gets in the way. Skipped on a revive.
    if (!this.reviveData) {
      const w = this.scale.width;
      const goal = this.add
        .text(w / 2, S(150), '🧗 Jump higher\n♻️ Scoop the trash to clean the ocean', {
          fontFamily: '"Baloo 2","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif',
          fontSize: `${S(16)}px`,
          color: '#eafcff',
          align: 'center',
          stroke: '#0b3d5c',
          strokeThickness: S(5),
          lineSpacing: S(4),
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(210);
      this.tweens.add({
        targets: goal,
        alpha: 0,
        y: S(120),
        delay: 3000,
        duration: 1100,
        ease: 'sine.in',
        onComplete: () => goal.destroy(),
      });
    }

    // Rewarded-ad revive: keep the previous run's score/coins and difficulty,
    // but drop back into a fresh, safe climb (player already spawns at the
    // bottom with the tide well below) plus a brief invulnerability + upward
    // boost so the player isn't immediately re-drowned. The tide's time-based
    // acceleration restarts here — a deliberate "second wind" for watching the
    // ad — while difficulty (and thus hazard density) carries over.
    if (this.reviveData) {
      this.scoreMeters = this.reviveData.meters;
      this.coinsCollected = this.reviveData.coins;
      this.bankedCoins = this.reviveData.bankedCoins;
      this.difficultyLevel = Math.floor(this.scoreMeters / 120);
      this.lastAnnouncedLevel = Math.floor(this.scoreMeters / 100) + 1;
      this.scoreText.setText(`${Math.floor(this.scoreMeters)} m  ·  Lv.${this.lastAnnouncedLevel}`);
      this.invulnerableUntil = this.time.now + 2500;
      this.player.setVelocityY(-S(900));
      this.floatText('Revived! 🐬', this.player.x, this.player.y - S(50), '#06d6a0');
      this.reviveData = null;
    }
  }

  private updateLivesHud() {
    const lives = getState().lives;
    let hearts = '';
    for (let i = 0; i < MAX_LIVES; i++) hearts += i < lives ? '❤️' : '🤍';
    this.livesText.setText(hearts);
  }

  private buildTideVisual() {
    this.tideSprite.setVisible(false);
    // Depth 19.5: ABOVE platforms/pearls/traps (18–19) but BELOW the seal (20), so
    // anything the rising water reaches is drawn UNDER a translucent layer — it
    // reads as submerged/covered — while the seal always stays visible on top.
    this.tideGraphics = this.add.graphics().setDepth(19.5);
    this.drawTide();
  }

  private tideGraphics!: Phaser.GameObjects.Graphics;

  private drawTide(): void {
    const w = this.scale.width;
    const g = this.tideGraphics;
    g.clear();
    const t = this.time.now / 300;
    const left = -S(60);
    const right = w + S(60);
    const step = S(20); // small step → smooth crest; it's still just 2 draw calls
    const amp = S(7);
    const crest = (x: number) => this.tideY + Math.sin(x * 0.02 + t) * amp;
    // Water body: ONE filled polygon with a smooth wavy top edge. Translucent
    // (~0.7) and drawn ABOVE the pieces (depth 19.5) so submerged platforms/pearls/
    // traps show through, tinted — they read as covered by the rising water.
    const bottom = this.tideY + S(4000);
    g.fillStyle(0x0b4f6c, 0.7);
    g.beginPath();
    g.moveTo(left, bottom);
    g.lineTo(left, crest(left));
    for (let x = left; x <= right; x += step) g.lineTo(x, crest(x));
    g.lineTo(right, bottom);
    g.closePath();
    g.fillPath();
    // Brighter shallow band just under the crest → a sense of depth (darker below).
    g.fillStyle(0x1e86ad, 0.28);
    g.beginPath();
    g.moveTo(left, crest(left));
    for (let x = left; x <= right; x += step) g.lineTo(x, crest(x));
    for (let x = right; x >= left; x -= step) g.lineTo(x, crest(x) + S(80));
    g.closePath();
    g.fillPath();
    // Foam highlight running along the crest.
    g.lineStyle(S(4), 0x59c6e6, 0.9);
    g.beginPath();
    g.moveTo(left, crest(left));
    for (let x = left; x <= right; x += step) g.lineTo(x, crest(x));
    g.strokePath();
  }

  private zoneFor(m: number): 0 | 1 | 2 {
    return m < ONBOARDING_M ? 0 : m < FLOW_M ? 1 : 2;
  }

  /** Soft outer glow so every interactable reads at a glance (Rule of
   *  Distinction). GPU-only (WebGL); silently no-ops on the Canvas renderer. */
  private glow(obj: any, color: number, strength = 4) {
    // Each preFX glow is a per-object shader pass — cheap on desktop, a real FPS
    // drain on mobile GPUs. Skip on non-desktop; items stay readable by shape/colour.
    if (!this.game.device.os.desktop) return;
    try {
      obj.preFX?.addGlow?.(color, strength, 0);
    } catch {
      /* Canvas renderer — no preFX pipeline */
    }
  }

  /** Draw the next power-up kind from a shuffle-bag: all three are dealt once
   *  before any repeats, so the same power-up never appears redundantly. */
  private drawPowerup(): PowerupData['kind'] {
    // 'law' (tide-slower) removed on request — only the dolphin boost and turtle
    // shield remain, so nothing ever tampers with the tide's steady pace.
    if (this.powerupBag.length === 0) {
      this.powerupBag = Phaser.Utils.Array.Shuffle<PowerupData['kind']>(['dolphin', 'shield']);
    }
    return this.powerupBag.pop()!;
  }

  /** Height-scaled probability table for the platform kind (design guidelines).
   *  Slippery is gated to >1200 m. Returns a raw weighted pick — constraints are
   *  applied by chooseKind(). */
  private weightedKind(m: number): PlatKind {
    // More variety than a stable-heavy start (user request): springs & moving
    // rocks (the fun ones) are common early, breakables kept moderate, and the
    // slippery rock unlocks from 400 m instead of 1200 m.
    let normal: number, brk: number, move: number, spring: number, slip: number;
    if (m < 400) {
      normal = 52; brk = 14; move = 17; spring = 17; slip = 0;
    } else if (m < 1000) {
      normal = 42; brk = 18; move = 18; spring = 15; slip = 7;
    } else if (m < 2000) {
      normal = 33; brk = 22; move = 18; spring = 15; slip = 12;
    } else {
      normal = 25; brk = 22; move = 20; spring = 16; slip = 17;
    }
    // Live variety knob: scales the non-stable weights up/down (stable stays fixed).
    const vy = tuning.variety;
    brk *= vy; move *= vy; spring *= vy; slip *= vy;
    let roll = Math.random() * (normal + brk + move + spring + slip);
    if ((roll -= normal) < 0) return 'normal';
    if ((roll -= brk) < 0) return 'break';
    if ((roll -= move) < 0) return 'move';
    if ((roll -= spring) < 0) return 'spring';
    return 'slip';
  }

  /** Choose the next platform kind with the guidelines' hard fairness constraints:
   *  after a big gap force a safe landing; never >2 non-stable in a row; ≥1 stable
   *  every 5; and Bouncy springs never two too close. */
  private chooseKind(platMeter: number, gapDesign: number, forced?: PlatKind): PlatKind {
    this.platsSinceSpring++;
    let kind: PlatKind;

    if (forced) {
      // Near-miss beat (see generatePlatformAt) — kept here so bookkeeping
      // (recentKinds / spring spacing) stays consistent.
      kind = forced;
    } else if (gapDesign > MAX_SAFE_GAP * 0.92) {
      // Big reach → the landing must be dependable (Stable, or an occasional Bouncy).
      kind = this.platsSinceSpring >= 3 && Math.random() < 0.4 ? 'spring' : 'normal';
    } else {
      const recent = this.recentKinds;
      const last = recent[recent.length - 1];
      const prev = recent[recent.length - 2];
      const trailingNonStable = (last && last !== 'normal' ? 1 : 0) + (prev && prev !== 'normal' ? 1 : 0);
      const noStableInLast4 = recent.length >= 4 && !recent.slice(-4).includes('normal');
      if (trailingNonStable >= 2 || noStableInLast4) {
        kind = 'normal'; // guarantee a solid rock so there's always a safe path
      } else {
        kind = this.weightedKind(platMeter);
        if (kind === 'spring' && this.platsSinceSpring < 3) kind = 'normal'; // no two springs too close
      }
    }

    if (kind === 'spring') this.platsSinceSpring = 0;
    this.recentKinds.push(kind);
    if (this.recentKinds.length > 6) this.recentKinds.shift();
    return kind;
  }

  /** Vertical gap (DESIGN px). Zone-based + rhythmic: onboarding is easy and
   *  uniform; the flow zone ramps the ceiling; "technical" steps reach toward the
   *  safe max while the two calm steps between them stay comfortable. Always
   *  <= MAX_SAFE_GAP so every jump is completable with a normal bounce. */
  private pickGapDesign(technical: boolean): number {
    const m = this.scoreMeters;
    let lo: number;
    let hi: number;
    if (m < ONBOARDING_M) {
      lo = MIN_GAP;
      hi = MIN_GAP + 14;
    } else if (m < FLOW_M) {
      const t = (m - ONBOARDING_M) / (FLOW_M - ONBOARDING_M);
      lo = MIN_GAP + 10;
      hi = Phaser.Math.Linear(MIN_GAP + 18, MAX_SAFE_GAP * 0.9, t);
    } else {
      lo = MIN_GAP + 18;
      hi = MAX_SAFE_GAP;
    }
    if (!technical) hi = Phaser.Math.Linear(lo, hi, 0.5); // calm steps stay gentle
    return Phaser.Math.Between(Math.round(lo), Math.round(Math.max(lo, hi)));
  }

  /** Horizontal offset (DESIGN px, signed). Calm steps drift little (near-straight
   *  climbs); technical steps use more of the reachable width. */
  private pickHorizontalOffsetDesign(gapDesign: number, technical: boolean): number {
    const gapRatio = Phaser.Math.Clamp(gapDesign / MAX_SAFE_GAP, 0, 1);
    let maxOffset = Phaser.Math.Linear(MAX_HORIZONTAL_OFFSET, MAX_HORIZONTAL_OFFSET * 0.55, gapRatio);
    if (!technical) maxOffset *= 0.5;
    return Phaser.Math.Between(-Math.round(maxOffset), Math.round(maxOffset));
  }

  /** Generates the next platform above lastPlatformY/X on a 2-calm-then-1-technical
   *  rhythm, always with a guaranteed-reachable gap + offset. */
  private generateNextPlatform() {
    const technical = this.stepInPattern === 2;
    this.stepInPattern = (this.stepInPattern + 1) % 3;
    const gapDesign = this.pickGapDesign(technical);
    const offsetDesign = this.pickHorizontalOffsetDesign(gapDesign, technical);
    const w = this.scale.width;
    const margin = S(46);
    const y = this.lastPlatformY - S(gapDesign);
    const x = Phaser.Math.Clamp(this.lastPlatformX + S(offsetDesign), margin, w - margin);
    this.generatePlatformAt(x, y, gapDesign);
  }

  private generatePlatformAt(x: number, y: number, gapDesign = MIN_GAP) {
    const w = this.scale.width;
    const margin = S(46);
    const platMeter = this.scoreMeters + (this.player.y - y) / S(20);

    // Rock/platform TYPE is the primary source of variety (design guidelines):
    // height-scaled probability tables + hard fairness constraints. Five kinds —
    // Stable / Crumbling(break) / Moving(move) / Bouncy(spring) / Slippery(slip).
    //
    // NEAR-MISS BEAT: every ~24-34 m (after the 55 m onboarding), and only on a
    // comfortable-gap step launched from a stable rock, stage move→break — a
    // drifting platform followed by a crumbling one you must leave quickly. Only
    // ever forces this pair; the fairness constraints resume right after.
    let forced: PlatKind | undefined;
    const comfyGap = gapDesign <= MAX_SAFE_GAP * 0.85;
    if (comfyGap) {
      if (this.nearMissStage === 'break') {
        forced = 'break';
        this.nearMissStage = 'none';
      } else if (this.nearMissStage === 'move') {
        forced = 'move';
        this.nearMissStage = 'break';
      } else if (platMeter >= this.nextNearMissMeter && this.recentKinds[this.recentKinds.length - 1] === 'normal') {
        forced = 'move';
        this.nearMissStage = 'break';
        this.nextNearMissMeter = platMeter + Phaser.Math.Between(24, 34);
      }
    }
    const kind = this.chooseKind(platMeter, gapDesign, forced);
    this.spawnPlatform(x, y, kind);

    // ---- Item + trap placement — deterministic cadences so nothing clumps ----
    // Positive items sit on a fixed grid (pearl · power-up · life); traps use a
    // randomised grid + random type. All "next…Meter" trackers self-correct after
    // one placement, so a revive at height picks up cleanly.

    // POWER-UP — every ~48 m. Rendered as a clean EMOJI ("in nothing" — no bubble/
    // circle art), kind chosen from a shuffle-bag so it never repeats redundantly.
    let positivePlaced = false;
    if (platMeter - this.lastPowerupMeter >= tuning.powerupSpacingM) {
      this.lastPowerupMeter = platMeter;
      const k = this.drawPowerup();
      const emoji = k === 'dolphin' ? '🐬' : k === 'law' ? '📜' : '🐢';
      const pu = this.add.text(x, y - S(48), emoji, { fontSize: `${S(40)}px` }).setOrigin(0.5).setDepth(19);
      this.physics.add.existing(pu);
      this.powerups.add(pu as any);
      pu.setData('kind', k);
      const body = pu.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setSize(S(38), S(38));
      this.tweens.add({ targets: pu, y: pu.y - S(7), duration: 800, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      positivePlaced = true;
    } else if (platMeter - this.lastLifeMeter >= tuning.lifeSpacingM) {
      // LIFE — kept on the grid (skipped silently when already full).
      this.lastLifeMeter = platMeter;
      if (getState().lives < MAX_LIVES) {
        const heart = this.add.text(x, y - S(46), '❤️', { fontSize: `${S(36)}px` }).setOrigin(0.5).setDepth(19);
        this.physics.add.existing(heart);
        this.hearts.add(heart as any);
        const body = heart.body as Phaser.Physics.Arcade.Body;
        body.setAllowGravity(false);
        body.setSize(S(34), S(34));
        this.tweens.add({ targets: heart, y: heart.y - S(6), duration: 700, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        positivePlaced = true;
      }
    }

    // PEARL — every ~5 m, skipped on a platform that already took a power-up/life
    // so the two never sit on top of each other. Bigger, plain gold-glow pearl.
    if (!positivePlaced && platMeter - this.lastPearlMeter >= tuning.pearlSpacingM) {
      this.lastPearlMeter = platMeter;
      const coin = this.coins.create(x + Phaser.Math.Between(-S(12), S(12)), y - S(34), 'coin_pearl');
      coin.setScale(S(0.2));
      coin.body.setAllowGravity(false);
      coin.setDepth(19);
      this.glow(coin, 0xfff2b0, 6);
      this.tweens.add({ targets: coin, y: coin.y - S(7), duration: 700, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    }

    // LITTER — collectible ocean trash on its own cadence, placed a step to ONE
    // SIDE (a small detour off the straight climb line) so grabbing it is a
    // positioning CHOICE, not automatic. Harmless (no damage): fills the cleanup
    // gauge → the boat sweep. This is the game's signature "clean the ocean" loop.
    if (platMeter >= FIRST_TRAP_M * 0.5 && platMeter - this.lastLitterMeter >= LITTER_SPACING_M) {
      this.lastLitterMeter = platMeter;
      const side = Math.random() < 0.5 ? -1 : 1;
      const lx = Phaser.Math.Clamp(x + side * Phaser.Math.Between(S(70), S(120)), margin, w - margin);
      this.spawnLitter(lx, y - Phaser.Math.Between(S(30), S(70)));
    }

    // TRAP — RARE and always DODGEABLE (guidelines: never block the only path,
    // generous start). None before FIRST_TRAP_M. Random type from a pool that
    // already has variety at the FIRST trap (trash + oil), widening with height so
    // it's never "always the same sack". Placed clearly to ONE SIDE, well off the
    // straight-up bounce line, so the player can always steer around it — never a
    // dead end. Sparse spacing (~30-50 m early → ~16-28 m high), ÷hazardMult.
    if (platMeter >= this.nextTrapMeter) {
      // Trash is no longer a hazard — it's the collectible for the cleanup mechanic
      // (spawned separately below). PLACEMENT hazards are the ones that WAIT at
      // their spot for the climber: the oil slick and the poacher diver. The
      // fly-across projectiles (rock, shark) are launched from the live view in
      // update() instead — spawning them here (900 px above) meant they crossed
      // and despawned before the player ever reached that height.
      const pool: HazardKind[] = ['oil'];
      if (platMeter >= 300) pool.push('human');
      const hk = Phaser.Utils.Array.GetRandom(pool);
      // Place the trap IN the ascent corridor just above this platform, only a
      // modest step to one side — so it's actually on the route the seal jumps
      // through (a real, timed dodge) instead of floating far out in open water.
      // Bias to the side away from where the seal came from so it reads as an
      // obstacle "ahead", and there's always a clear lane on the other side.
      const side = this.lastPlatformX > x ? -1 : this.lastPlatformX < x ? 1 : Math.random() < 0.5 ? -1 : 1;
      const hx = Phaser.Math.Clamp(x + side * Phaser.Math.Between(S(46), S(88)), margin, w - margin);
      this.spawnHazard(hx, y - Phaser.Math.Between(S(50), S(80)), hk, w, margin);
      const t = Phaser.Math.Clamp(platMeter / 3000, 0, 1);
      const gap = Phaser.Math.Between(
        Math.round(Phaser.Math.Linear(30, 16, t)),
        Math.round(Phaser.Math.Linear(50, 28, t))
      );
      this.nextTrapMeter = platMeter + Math.max(10, (gap * tuning.trapRarity) / this.hazardMult);
    }

    this.lastPlatformY = y;
    this.lastPlatformX = x;
  }

  /** Creates one of the three hazard kinds at (x, y). No new binary assets
   * needed — rock/oil use plain Phaser shapes + emoji text, matching how
   * the ad overlays already render '🌊🦭' as text instead of a sprite. */
  private spawnHazard(x: number, y: number, kind: HazardKind, w: number, margin: number) {
    if (kind === 'shark') {
      // A shark lunges across the screen from one side — fast, and a hard hit.
      const fromLeft = Math.random() < 0.5;
      const startX = fromLeft ? -S(30) : w + S(30);
      const speed = S(150 + Math.min(this.difficultyLevel * 7, 110));
      const dir = fromLeft ? 1 : -1;
      const shark = this.add
        .text(startX, y, '🦈', { fontSize: `${S(38)}px` })
        .setOrigin(0.5)
        .setDepth(19)
        .setFlipX(fromLeft);
      this.physics.add.existing(shark);
      this.hazards.add(shark as any);
      const body = shark.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setVelocityX(dir * speed);
      body.setSize(S(26), S(20));
      shark.setData('kind', 'shark');
      this.glow(shark, 0xff4d4d, 5);
      // Telegraph: a ⚠️ flashes at the edge the shark enters from, giving the
      // player visual lead-time before it crosses the play area.
      const warn = this.add
        .text(fromLeft ? S(14) : w - S(14), y, '⚠️', { fontSize: `${S(20)}px` })
        .setOrigin(0.5)
        .setDepth(20)
        .setAlpha(0);
      this.tweens.add({ targets: warn, alpha: 1, duration: 150, yoyo: true, repeat: 1, onComplete: () => warn.destroy() });
      return;
    }

    if (kind === 'human') {
      // A poacher diver drifting side to side — bump them and you get knocked back.
      const human = this.add.text(x, y, '🤿', { fontSize: `${S(31)}px` }).setOrigin(0.5).setDepth(19);
      this.physics.add.existing(human);
      this.hazards.add(human as any);
      const body = human.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setSize(S(24), S(24));
      human.setData('kind', 'human');
      this.glow(human, 0xff4d4d, 4);
      this.tweens.add({
        targets: human,
        x: Phaser.Math.Clamp(x + Phaser.Math.Between(-S(55), S(55)), margin, w - margin),
        duration: 1800,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
      return;
    }

    if (kind === 'rock') {
      const fromLeft = Math.random() < 0.5;
      const startX = fromLeft ? -S(20) : w + S(20);
      const speed = S(90 + Math.min(this.difficultyLevel * 6, 90));
      const dir = fromLeft ? 1 : -1;

      // Quick flash of the poacher at the edge the rock is thrown from —
      // purely cosmetic, self-destroys, never joins the hazards group so
      // it can't collide or need cleanup bookkeeping.
      const thrower = this.add
        .text(fromLeft ? S(10) : w - S(10), y, '🧍', { fontSize: `${S(22)}px` })
        .setOrigin(0.5)
        .setDepth(18)
        .setAlpha(0);
      this.tweens.add({
        targets: thrower,
        alpha: 1,
        duration: 200,
        yoyo: true,
        hold: 400,
        onComplete: () => thrower.destroy(),
      });

      const rock = this.add.text(startX, y, '🪨', { fontSize: `${S(27)}px` }).setOrigin(0.5).setDepth(19);
      this.physics.add.existing(rock);
      // Cast to `any` here on purpose: Group.add()'s TS typings want a
      // GameObjectWithBody with a *required* body property, but Text's
      // body is declared optional on the base GameObject class. Runtime
      // behavior is unaffected — physics.add.existing() already attached
      // a real Arcade body above.
      this.hazards.add(rock as any);
      const body = rock.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setVelocityX(dir * speed);
      body.setSize(S(18), S(18));
      rock.setData('kind', 'rock');
      this.glow(rock, 0xff7a3d, 4);
      this.tweens.add({ targets: rock, angle: dir * 360, duration: 900, repeat: -1 });
      return;
    }

    if (kind === 'oil') {
      // Depth 19 (above platforms) so the slick is never hidden beneath one, with
      // a purple rim so it reads as a distinct SLIP hazard (not a damage one).
      const oil = this.add.ellipse(x, y, S(66), S(26), 0x0a0a12, 0.85).setDepth(19).setStrokeStyle(S(2), 0x7b5cff, 0.9);
      this.physics.add.existing(oil);
      this.hazards.add(oil as any); // see rock's comment above
      const body = oil.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setSize(S(58), S(20));
      oil.setData('kind', 'oil');
      this.glow(oil, 0x9b6bff, 5);
      this.tweens.add({ targets: oil, alpha: 0.5, duration: 900, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      return;
    }

    // trash (default) — floating plastic debris drifting side to side. The bag art
    // is teal (same family as the water), so a strong red danger halo + a bigger
    // size make it read as a threat at a glance rather than blending in.
    const hz = this.hazards.create(x, y, 'trash_hazard');
    hz.setScale(S(0.21));
    hz.body.setAllowGravity(false);
    // Fair, forgiving hitbox (smaller than the art, which has transparent padding)
    // and NO horizontal drift — it stays put in its lane so it can be read and
    // steered around, never wandering into the player's path. The 0.4 factor keeps
    // the hitbox roughly unchanged even though the art is now a bit bigger.
    hz.body.setSize(hz.width * 0.4, hz.height * 0.4);
    hz.setDepth(19);
    hz.setData('kind', 'trash');
    this.glow(hz, 0xff3b2f, 8);
    this.tweens.add({ targets: hz, y: hz.y - S(6), duration: 900, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  }

  private spawnPlatform(x: number, y: number, kind: PlatKind) {
    // Slippery reuses the normal rock art with an icy-blue tint so it reads as
    // "slick" at a glance (colour-coded affordance, per the guidelines).
    const key =
      kind === 'move' ? 'platform_move' : kind === 'break' ? 'platform_break' : kind === 'spring' ? 'platform_spring' : 'platform_normal';
    const plat = this.platforms.create(x, y, key) as Phaser.Physics.Arcade.Sprite;
    plat.setScale(S(0.21));
    plat.refreshBody();
    plat.setSize(plat.width * 0.9, plat.height * 0.5);
    if (kind === 'slip') plat.setTint(0x8fd3ff);
    plat.setData('kind', kind);
    plat.setDepth(18);
    if (kind === 'move') {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const speed = S(60 + Math.min(this.difficultyLevel * 5, 60));
      plat.setData('vx', dir * speed);
      // Moving platforms drift only a modest amount so they don't wander
      // out of jump range before the player lands.
      plat.setData('originX', x);
      plat.setData('range', S(46));
    }
    return plat;
  }

  private checkPlatformCollide(_player: any, platform: any) {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    return body.velocity.y >= 0 && this.player.y < platform.y;
  }

  private handlePlatformCollide(_player: any, platformObj: any) {
    const platform = platformObj as Phaser.Physics.Arcade.Sprite;
    const kind = platform.getData('kind') as PlatKind;
    if (kind === 'break') {
      this.tweens.add({
        targets: platform,
        alpha: 0,
        y: platform.y + S(20),
        duration: 250,
        onComplete: () => platform.destroy(),
      });
    }
    const jumpVel = kind === 'spring' ? -S(SPRING_JUMP_VEL) : -S(NORMAL_JUMP_VEL);
    this.player.setVelocityY(jumpVel);
    if (kind === 'slip') {
      // Slippery rock — a LIGHT horizontal drift + brief sluggish steering. Milder
      // than an oil slick: you skid a little off your line, adding a moment of
      // recovery rather than a punishing slide.
      const dir = this.player.body!.velocity.x >= 0 ? 1 : -1;
      this.player.setVelocityX(this.player.body!.velocity.x + dir * S(130));
      this.slipperyUntil = this.time.now + 850;
    }
    playSfx('jump');
    this.cameras.main.shake(kind === 'spring' ? 90 : 40, kind === 'spring' ? 0.006 : 0.002);
    this.tweens.killTweensOf(this.player);
    this.player.setScale(S(0.34), S(0.2));
    this.tweens.add({ targets: this.player, scaleX: S(0.28), scaleY: S(0.28), duration: 180, ease: 'back.out' });
  }

  private handleCoin(_player: any, coinObj: any) {
    coinObj.destroy();
    // Combo: grabbing pearls in quick succession (within the 900ms window) ramps
    // the payout up to +5 per pearl; letting the window lapse resets the chain.
    const now = this.time.now;
    if (now > this.comboTimer) this.comboCoins = 0;
    this.comboCoins += 1;
    this.comboTimer = now + 900;
    const bonus = Math.min(this.comboCoins, 5);
    this.coinsCollected += bonus;
    playSfx('coin');
    this.floatText(`+${bonus} 🦪`, this.player.x, this.player.y - S(40), '#ffd166');
  }

  private handleHeart(_player: any, heartObj: any) {
    heartObj.destroy();
    playSfx('powerup');
    if (addLife()) {
      this.updateLivesHud();
      this.floatText('+1 Life ❤️', this.player.x, this.player.y - S(50), '#ef476f');
    }
  }

  /** Spawn one collectible ocean-trash piece. Harmless — a friendly cyan "grab me"
   *  glow + a ♻ badge, NOT the red danger halo the old trash trap used. */
  private spawnLitter(x: number, y: number) {
    const t = this.litter.create(x, y, 'trash_hazard');
    t.setScale(S(0.19));
    t.body.setAllowGravity(false);
    t.body.setSize(t.width * 0.6, t.height * 0.6); // generous grab box (it's a reward)
    t.setDepth(19);
    this.glow(t, 0x2ee6c8, 6); // cyan = collectible/good, not a threat
    this.tweens.add({ targets: t, y: t.y - S(6), duration: 900, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    const tag = this.add.text(x, y - S(24), '♻️', { fontSize: `${S(15)}px` }).setOrigin(0.5).setDepth(19);
    t.setData('tag', tag);
    this.tweens.add({ targets: tag, y: tag.y - S(6), duration: 900, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  }

  private handleLitter(_player: any, litterObj: any) {
    const tag = litterObj.getData('tag') as Phaser.GameObjects.Text | undefined;
    if (tag) tag.destroy();
    litterObj.destroy();
    playSfx('coin');
    addTrashCleaned(1);
    this.cleanupCount += 1;
    this.trashThisRun += 1;
    this.floatText('♻️ +1', this.player.x, this.player.y - S(46), '#7ff0e0');
    if (this.cleanupCount >= this.cleanupGoal && !this.boatBusy) this.triggerCleanupBoat();
    else this.updateCleanupGauge();
  }

  /** Cleanup boat: sweeps the screen, clears on-screen dangers + remaining litter,
   *  and buys a tide breather (recede + slow ~3.5 s). The payoff for a full gauge. */
  private triggerCleanupBoat() {
    this.boatBusy = true;
    this.cleanupCount = 0;
    this.boatsThisRun += 1;
    this.updateCleanupGauge();
    const w = this.scale.width;
    const camTop = this.cameras.main.scrollY;
    const camBot = camTop + this.scale.height;
    playSfx('powerup');
    this.floatText('🚢 Ocean cleaned!', this.player.x, this.player.y - S(62), '#7ff0e0');
    this.cameras.main.flash(220, 120, 240, 220);

    // Clear on-screen dangers with a little poof.
    (this.hazards.getChildren() as any[]).slice().forEach((hz: any) => {
      if (hz && typeof hz.y === 'number' && hz.y > camTop - S(60) && hz.y < camBot + S(60)) {
        this.tweens.add({ targets: hz, alpha: 0, scale: 0, duration: 220, onComplete: () => hz.destroy() });
      }
    });
    // Vacuum any remaining litter on screen (bonus cleanup).
    (this.litter.getChildren() as any[]).slice().forEach((lt: any) => {
      const tag = lt.getData?.('tag') as Phaser.GameObjects.Text | undefined;
      if (tag) tag.destroy();
      addTrashCleaned(1);
      lt.destroy();
    });

    // Tide breather: recede a little + slow it for a few seconds (reuses tideSlow).
    this.tideY += S(150);
    this.tideSlowUntil = this.time.now + 3500;

    // The boat: a big emoji sweeping across, screen-fixed so the camera can't drift it.
    const boat = this.add
      .text(-S(80), this.scale.height * 0.32, '🚢', { fontSize: `${S(56)}px` })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(210);
    this.tweens.add({
      targets: boat,
      x: w + S(80),
      duration: 1400,
      ease: 'sine.inOut',
      onComplete: () => {
        boat.destroy();
        this.boatBusy = false;
      },
    });
  }

  // Refresh the trash counter HUD (a plain tally, not a gauge). Shows how much
  // ocean trash has been scooped this run — the ♻️ currency added to the player's
  // balance at game over and spent on skins.
  private updateCleanupGauge() {
    if (this.cleanupLabel) this.cleanupLabel.setText(`♻️ ${this.trashThisRun}`);
  }

  private handlePowerup(_player: any, puObj: any) {
    const kind = puObj.getData('kind');
    puObj.destroy();
    playSfx('powerup');
    if (kind === 'dolphin') {
      this.floatText('🐬 Dolphin Push!', this.player.x, this.player.y - S(50), '#06d6a0');
      this.speedBoostUntil = this.time.now + 4000;
      this.invulnerableUntil = this.time.now + 4000;
      this.player.setVelocityY(-S(1000));
      this.spawnCompanion();
    } else if (kind === 'law') {
      this.floatText('📜 Ocean Law Passed!', this.player.x, this.player.y - S(50), '#9be7ff');
      this.tideSlowUntil = this.time.now + 5000;
    } else if (kind === 'shield') {
      this.floatText('🐢 Shield Up!', this.player.x, this.player.y - S(50), '#a8e6cf');
      this.shieldActive = true;
      // A clean protective BUBBLE drawn around the seal (soft cyan fill + bright
      // rim + gentle pulse) instead of the old flat shield PNG slapped on top.
      const r = this.player.displayWidth * 0.62;
      this.shieldIcon = this.add
        .circle(this.player.x, this.player.y, r, 0x2ee6c8, 0.12)
        .setStrokeStyle(S(3.5), 0x8affea, 0.95)
        .setDepth(21);
      this.tweens.add({
        targets: this.shieldIcon,
        scale: 1.06,
        duration: 620,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
    }
  }

  private spawnCompanion() {
    if (this.pushCompanion) this.pushCompanion.destroy();
    const c = this.add.image(this.player.x - S(40), this.player.y + S(20), 'powerup_dolphin').setScale(S(0.3)).setDepth(19);
    this.pushCompanion = c;
    this.tweens.add({
      targets: c,
      alpha: 0,
      duration: 4000,
      onComplete: () => c.destroy(),
    });
  }

  private handleHazard(_player: any, hazObj: any) {
    if (this.time.now < this.invulnerableUntil) return;
    const kind = (hazObj.getData('kind') as HazardKind) ?? 'trash';

    if (this.shieldActive) {
      this.shieldActive = false;
      if (this.shieldIcon) {
        this.tweens.killTweensOf(this.shieldIcon); // stop the pulse before removing it
        // Quick "pop" as the bubble absorbs the hit.
        const bubble = this.shieldIcon;
        this.tweens.add({ targets: bubble, scale: 1.4, alpha: 0, duration: 200, onComplete: () => bubble.destroy() });
        this.shieldIcon = undefined;
      }
      if (kind !== 'oil') hazObj.destroy();
      this.floatText('Shield Absorbed!', this.player.x, this.player.y - S(40), '#a8e6cf');
      this.invulnerableUntil = this.time.now + 800;
      return;
    }

    if (kind === 'oil') {
      // OIL SLICK — a real SLIP. Seally skids sideways the way he was already
      // drifting (or a random side if steady) and can't correct for ~2 s: steering
      // goes sluggish so he keeps sliding across, leaning into the skid. Doesn't
      // knock him down, but on a tight line it's genuinely dangerous. The slick
      // stays put (a patch, not a pickup); brief i-frames stop instant re-triggers.
      const vx = this.player.body!.velocity.x;
      const dir = Math.abs(vx) > S(20) ? Math.sign(vx) : Math.random() < 0.5 ? -1 : 1;
      this.player.setVelocityX(dir * S(340)); // the skid
      this.slipperyUntil = this.time.now + 1900; // sluggish steering — can't stop the slide
      this.invulnerableUntil = this.time.now + 1200;
      this.cameras.main.shake(140, 0.005);
      playSfx('click');
      this.floatText('Slipping! 🛢️', this.player.x, this.player.y - S(40), '#b39dff');
      return;
    }

    hazObj.destroy();
    const isShark = kind === 'shark';
    const isRock = kind === 'rock';
    const isHuman = kind === 'human';
    // Sharks hit hardest.
    const knock = isShark ? S(300) : S(220);
    this.player.setVelocityX(this.player.body!.velocity.x > 0 ? -knock : knock);
    this.player.setVelocityY(isShark ? -S(40) : S(60));
    this.cameras.main.shake(isShark ? 260 : isRock ? 200 : 150, isShark ? 0.02 : isRock ? 0.015 : 0.01);
    const msg = isShark
      ? 'Shark attack! 🦈'
      : isHuman
      ? 'Poacher! 🤿'
      : isRock
      ? 'Hit by a rock! 🪨'
      : 'Ouch! 🗑️';
    this.floatText(msg, this.player.x, this.player.y - S(40), '#ef476f');
    this.invulnerableUntil = this.time.now + (isShark ? 1300 : isRock ? 1100 : 900);
  }

  private floatText(msg: string, x: number, y: number, color: string) {
    const t = this.add
      .text(x, y, msg, { fontFamily: FONT_BODY, fontSize: `${S(15)}px`, color, stroke: '#0b3d5c', strokeThickness: S(3) })
      .setOrigin(0.5)
      .setDepth(300);
    this.tweens.add({ targets: t, y: y - S(40), alpha: 0, duration: 900, onComplete: () => t.destroy() });
  }

  update(time: number, delta: number) {
    if (this.isGameOver) return;
    const dt = delta / 1000;
    const w = this.scale.width;

    // Input movement. Keyboard stays a crisp -1/0/1 direction with the same
    // linear smoothing as before. Pointer/touch uses the 3-segment design
    // curve (dead → soft → full) so tiny finger wobbles don't become full
    // steering, and medium drags nudge the seal without flipping it all the
    // way across. Physics outcome is identical on every device (identical
    // targetVX and smoothing), only the *human→input* translation differs.
    let moveX = 0;
    if (this.cursors.left.isDown) moveX = -1;
    else if (this.cursors.right.isDown) moveX = 1;
    else if (this.pointerDown) {
      // Half-screen steering, relative to the screen centre (NOT the seal): touch
      // the left half → full left, the right half → full right. Only a thin dead
      // band at the centre line gives 0 (avoids jitter on a dead-centre hold).
      const diff = this.pointerX - w / 2;
      if (Math.abs(diff) <= S(TOUCH_CENTER_DEADBAND_DESIGN)) moveX = 0;
      else moveX = diff < 0 ? -1 : 1;
    }
    const speedMult = this.time.now < this.speedBoostUntil ? 1.5 : 1;
    const targetVX = moveX * S(MOVE_SPEED) * speedMult;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const isSlippery = this.time.now < this.slipperyUntil;
    body.velocity.x = Phaser.Math.Linear(body.velocity.x, targetVX, isSlippery ? 0.06 : 0.25);

    // Screen wrap
    if (this.player.x < -S(20)) this.player.x = w + S(20);
    if (this.player.x > w + S(20)) this.player.x = -S(20);

    this.player.setRotation(Phaser.Math.Clamp(body.velocity.x / S(1400), -0.3, 0.3));
    this.player.setFlipX(body.velocity.x < -10 ? true : body.velocity.x > 10 ? false : this.player.flipX);

    if (this.shieldIcon) {
      this.shieldIcon.setPosition(this.player.x, this.player.y);
    }

    // Update moving platforms — drift within a bounded range around their
    // spawn point so they never wander out of jump range.
    this.platforms.children.iterate((p: any) => {
      if (!p) return true;
      if (p.getData('kind') === 'move') {
        let vx = p.getData('vx');
        const originX = p.getData('originX') ?? p.x;
        const range = p.getData('range') ?? S(46);
        p.x += vx * dt;
        if (p.x < originX - range || p.x > originX + range || p.x < S(30) || p.x > w - S(30)) {
          vx = -vx;
          p.setData('vx', vx);
        }
        p.body.updateFromGameObject();
      }
      return true;
    });

    // Track highest point & score
    if (this.player.y < this.highestY) {
      const gained = this.highestY - this.player.y;
      this.highestY = this.player.y;
      this.scoreMeters += gained / S(20);
      const level = Math.floor(this.scoreMeters / 100) + 1;
      this.scoreText.setText(`${Math.floor(this.scoreMeters)} m  ·  Lv.${level}`);
      this.difficultyLevel = Math.floor(this.scoreMeters / 120);
      if (level > this.lastAnnouncedLevel) {
        this.lastAnnouncedLevel = level;
        this.floatText(`⬆️ Level ${level}!`, this.player.x, this.player.y - S(60), '#ffd166');
      }
    }

    // PROJECTILE HAZARDS (poacher rocks, then sharks) launched relative to the
    // LIVE view — not at platform-generation time. They sweep across the screen
    // once, so spawning them 900 px above (where platforms generate) meant they'd
    // crossed and despawned before the player climbed there (the "no rocks ever"
    // bug). Here they cross the lane just above the seal, where it must dodge them.
    if (this.scoreMeters >= this.nextProjectileMeter) {
      const w = this.scale.width;
      const margin = S(46);
      const projPool: HazardKind[] = ['rock'];
      if (this.scoreMeters >= 800) projPool.push('shark');
      const kind = Phaser.Utils.Array.GetRandom(projPool);
      const viewY = this.player.y - Phaser.Math.Between(S(110), S(300));
      this.spawnHazard(0, viewY, kind, w, margin);
      // ~every 80 m early, tightening to ~40 m up high; scaled like placement traps.
      const t = Phaser.Math.Clamp(this.scoreMeters / 3000, 0, 1);
      const gapM = (Phaser.Math.Linear(80, 40, t) * tuning.trapRarity) / this.hazardMult;
      this.nextProjectileMeter = this.scoreMeters + Math.max(15, gapM);
    }

    // Generate more platforms above as needed, always using the
    // guaranteed-reachable gap + offset picker.
    while (this.lastPlatformY > this.player.y - S(900)) {
      this.generateNextPlatform();
    }

    // Cleanup platforms/coins far below
    const cleanupY = this.player.y + S(700);
    [this.platforms, this.coins, this.powerups, this.hazards, this.hearts, this.litter].forEach((group) => {
      group.children.iterate((obj: any) => {
        if (obj && obj.y > cleanupY) {
          const tag = obj.getData?.('tag'); // litter carries a ♻ badge — destroy it too
          if (tag) tag.destroy();
          obj.destroy();
        }
        return true;
      });
    });

    // Tide: CONSTANT base pace + a LEASH. The pace never ramps, but the water may
    // never trail more than TIDE_LEASH_DESIGN below the visible bottom — if a
    // strong climber pulls further ahead, a gentle capped catch-up reels it back
    // up to the leash and then it resumes constant pace, so it's always a threat.
    // Modifiers: the opening grace, and the Ocean-Law powerup.
    const inGrace = this.time.now < this.tideGraceUntil;
    const tideSlowActive = this.time.now < this.tideSlowUntil;
    // Leash in METRES against a SMOOTHED seal height (EMA) — a one-off spring apex
    // doesn't yank the water up, but the sustained gap obeys the hard rule.
    if (this.tideSealRefY === 0) this.tideSealRefY = this.player.y;
    this.tideSealRefY = Phaser.Math.Linear(this.tideSealRefY, this.player.y, 0.08);
    const PX_PER_M = S(20); // one metre in render px (matches the HUD gauge below)
    const leashM = tuning.maxMetersBelow;
    const leashGapM = (this.tideY - this.tideSealRefY) / PX_PER_M; // metres the tide sits below the seal
    let effSpeed = tuning.tideSpeed * this.mapTideMult; // constant base pace
    if (leashGapM > leashM) {
      // Firm, rate-limited catch-up: the water's max speed (base + cap ≈ 11 m/s) is
      // well above the seal's climb (~6 m/s), so the gap always converges back to
      // the ≤15 m leash — smoothly, without ever teleporting up on a single bounce.
      effSpeed += Math.min(TIDE_CATCHUP_MAX, (leashGapM - leashM) * TIDE_CATCHUP_GAIN_M);
    }
    if (tideSlowActive) effSpeed *= 0.25;
    if (inGrace) effSpeed = Math.min(effSpeed, TIDE_START_GRACE_MAX_SPEED);
    this.tideSpeed = effSpeed;
    this.tideY -= S(effSpeed) * dt;
    this.drawTide();


    // Real-time tide gauge (top-right HUD): the live distance from the seal down
    // to the water, colour-coded by danger so the player always knows how much
    // runway is left. Big game-font readout, updated every frame.
    const gapM = Math.max(0, Math.round((this.tideY - this.player.y) / S(20)));
    if (gapM <= 5) {
      this.tideWarnText.setText(`⚠️ TIDE ${gapM} m`).setColor('#ff5a5a');
      this.tideWarnText.setScale(1 + 0.06 * Math.sin(this.time.now / 90)); // urgent pulse
    } else {
      this.tideWarnText.setScale(1);
      if (gapM <= 14) this.tideWarnText.setText(`🌊 ${gapM} m`).setColor('#ffd166');
      else this.tideWarnText.setText(`🌊 ${gapM} m`).setColor('#8fe3ff');
    }

    if (this.jokerCooldownText) {
      if (this.time.now < this.speedBoostUntil) this.jokerCooldownText.setText('🐬 Boost Active');
      else if (isSlippery) this.jokerCooldownText.setText('🛢️ Slippery!');
      else if (this.shieldActive) this.jokerCooldownText.setText('🐢 Shielded');
      else this.jokerCooldownText.setText('');
    }

    const camBottom = this.cameras.main.scrollY + this.scale.height;
    if (this.player.y > this.tideY - S(20) || this.player.y > camBottom + S(40)) {
      this.gameOver();
    }
  }

  private gameOver() {
    if (this.isGameOver) return;

    // A spare life saves you: spend it and drop straight back into the run
    // (no ad, no game-over screen), keeping your score & coins.
    if (getState().lives > 0 && spendLife()) {
      this.isGameOver = true; // guard re-entry while the scene restarts
      crazyGameplayStop(); // paired with the gameplayStart in the restarted scene's create()
      playSfx('powerup');
      this.cameras.main.flash(220, 255, 120, 160);
      this.scene.start('GameScene', {
        revive: {
          meters: Math.floor(this.scoreMeters),
          coins: this.coinsCollected,
          bankedCoins: this.bankedCoins,
          adRevived: this.adRevivedThisRun, // carry the ad-revive cap through heart revives
        },
      });
      return;
    }

    this.isGameOver = true;
    crazyGameplayStop(); // CrazyGames: run ended (no-op off their portal)
    playSfx('gameover');
    this.cameras.main.shake(200, 0.015);
    this.physics.pause();
    const finalMeters = Math.floor(this.scoreMeters);
    // Only bank coins collected since the last time they were banked (0 on a
    // normal run = bank everything; on a revived run = just the new coins).
    const newCoins = Math.max(0, this.coinsCollected - this.bankedCoins);
    const result = registerRun(finalMeters, newCoins);
    this.time.delayedCall(400, () => {
      this.scene.start('GameOverScene', {
        meters: finalMeters,
        coins: this.coinsCollected,
        // Everything is now banked — carry that forward so a revive continues
        // to bank only newly-earned coins.
        bankedCoins: this.coinsCollected,
        newBadges: result.newlyUnlockedBadges,
        newMaps: result.newlyUnlockedMaps,
        adRevived: this.adRevivedThisRun, // hide the ad-revive offer if already used
        trashCleaned: this.trashThisRun, // run highlight: ocean trash collected
        boats: this.boatsThisRun, // run highlight: cleanup boats triggered
      });
    });
  }
}

function mapIdToBg(id: string): string {
  return id === 'lagoon' ? 'bg_lagoon' : id === 'reef' ? 'bg_reef' : id === 'storm' ? 'bg_storm' : 'bg_lagoon';
}
