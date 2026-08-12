import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S } from '../constants';
import { getState, registerRun, MAPS, SKINS, MAX_LIVES, addLife, spendLife, resetRunLives } from '../state';
import { playSfx, gestureUnlock } from '../audio';

type PlatKind = 'normal' | 'move' | 'break' | 'spring';
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

// ---- Progression zones (metres) ----
// Onboarding: safe, teaches the jump + item shapes. Flow: ramps gap/hazards
// smoothly. Mastery: fullest mix, but the tide speed is capped so the challenge
// comes from placement + timing, not an unsurvivable speed wall.
const ONBOARDING_M = 300;
const FLOW_M = 800;

// ---- Tide tuning (design-pixel units) ----
// The tide is the run's pressure. It rises SMOOTHLY at a speed and is NEVER
// snapped to the player's position (that made the water "jump" when you
// jumped). Its speed = a constant base (that slowly ramps over the run) PLUS
// an acceleration proportional to how far it has fallen below the bottom of the
// screen. So a fast climber pulls ahead and the tide speeds up to chase;
// slowing/stopping lets it rise into view and drown you; and the time ramp
// makes even a perfect climb unsurvivable eventually.
//
// Player climbs at ~85–95 design px/s on a steady bounce. The cap below (118)
// stays ~1.25× that climb rate, so a skillful player can always outclimb the
// water when moving cleanly. The chase gain (0.24) is gentle: a fast opening
// staircase / springs burst no longer rockets the tide to 3× climb speed.
//
// Two safety rails on the opening:
//   - The tide starts ~120 design px DEEPER below the first platform, so even
//     a slow first bounce isn't an instant drown.
//   - A 3 s opening GRACE clamps the effective rise speed to 6 design px/s and
//     ALSO disables chase entirely in that window, guaranteeing a clean start
//     even if you mis-time the very first jump.
const TIDE_BASE_SPEED = 22; // constant base rise (design px/s)
const TIDE_TIME_ACCEL = 0.48; // base rise gained per second of the run
const TIDE_TARGET_BELOW_SCREEN = -20; // where it "wants" to sit vs the screen bottom (− = just into view)
const TIDE_CHASE_GAIN = 0.24; // extra rise speed per design px it lags below that target
const TIDE_MAX_SPEED = 118; // cap: firm pressure, but never an un-outclimbable rocket
const TIDE_START_EXTRA_PADDING_DESIGN = 120; // start even deeper for the first jumps
const TIDE_START_GRACE_MS = 3000; // opening seconds where the tide barely moves
const TIDE_START_GRACE_MAX_SPEED = 6; // max design px/s during the grace window

export default class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private platforms!: Phaser.Physics.Arcade.Group;
  private coins!: Phaser.Physics.Arcade.Group;
  private powerups!: Phaser.Physics.Arcade.Group;
  private hazards!: Phaser.Physics.Arcade.Group;
  private hearts!: Phaser.Physics.Arcade.Group;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private pointerDown = false;
  private pointerX = 0;

  private tideY = 0;
  private tideSpeed = TIDE_BASE_SPEED; // design px per second, rises (decreasing y)
  private baseTideSpeed = TIDE_BASE_SPEED;
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
  // Rhythm counter: 0,1 = calm steps, 2 = "technical" step (bigger gap/offset,
  // where special platforms + hazards concentrate). Cycles 0→1→2→0.
  private stepInPattern = 0;

  private invulnerableUntil = 0;
  private slipperyUntil = 0;
  private lastAnnouncedLevel = 1;
  private shieldActive = false;
  private shieldIcon?: Phaser.GameObjects.Image;
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

  // Lives HUD (hearts). Lives are collected as ❤️ pickups while climbing.
  private livesText!: Phaser.GameObjects.Text;
  // World-y of the last heart spawned, to keep hearts rare and well-spaced.
  private lastHeartY = 0;

  // Coins already banked to the profile for this session. Normally 0 (a run
  // banks everything when it ends), but a rewarded-ad revive carries forward
  // how much was banked at the previous death so the continued run only ever
  // banks the *new* coins collected afterwards — no double-counting.
  private bankedCoins = 0;
  private reviveData: { meters: number; coins: number; bankedCoins: number } | null = null;

  constructor() {
    super('GameScene');
  }

  init(data?: { revive?: { meters: number; coins: number; bankedCoins: number } }) {
    this.reviveData = data?.revive ?? null;
  }

  create() {
    gestureUnlock(this);
    this.isGameOver = false;
    // Mark that a run has begun this session — the title screen uses this to
    // require the ad on every subsequent PLAY (so the menu can't dodge it).
    this.registry.set('playedThisSession', true);
    const st = getState();
    this.bgKey = mapIdToBg(st.selectedMap);

    // Apply the selected map's gameplay flavor: tougher maps rise faster and
    // spawn more hazards (but more coins). This is what makes each unlocked map
    // actually play differently, not just look different.
    const mapDef = MAPS.find((m) => m.id === st.selectedMap) ?? MAPS[0];
    this.baseTideSpeed = TIDE_BASE_SPEED * mapDef.tideMult;
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

    // Player — sprite + optional tint from the selected skin.
    const skinDef = SKINS.find((s) => s.id === st.selectedSkin) ?? SKINS[0];
    this.player = this.physics.add.sprite(w / 2, h - S(160), skinDef.sprite);
    if (skinDef.tint !== undefined) this.player.setTint(skinDef.tint);
    this.player.setScale(S(0.22));
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

    // Tide (rising ocean). Starts well below the opening platform so a slow
    // first jump isn't an instant drown. (The extra padding means even a
    // graceless first bounce — or the player immediately stalling on the
    // opening platform — still has headroom before the first chase surge kicks
    // in after the grace window.)
    this.tideY = h + S(230) + S(TIDE_START_EXTRA_PADDING_DESIGN);
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
      .text(w - S(16), S(16), '', { fontFamily: FONT_BODY, fontSize: `${S(13)}px`, color: '#ffd166' })
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

    this.highestY = this.player.y;
    this.lastHeartY = this.player.y; // first heart must be climbed to
    this.scoreMeters = 0;
    this.coinsCollected = 0;
    this.bankedCoins = 0;
    this.tideSpeed = this.baseTideSpeed;
    this.runStartTime = this.time.now;
    this.tideGraceUntil = this.time.now + TIDE_START_GRACE_MS;
    this.slipperyUntil = 0;
    this.lastAnnouncedLevel = 1;

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
    this.tideGraphics = this.add.graphics().setDepth(16);
    this.drawTide();
  }

  private tideGraphics!: Phaser.GameObjects.Graphics;

  private drawTide(): void {
    const w = this.scale.width;
    this.tideGraphics.clear();
    this.tideGraphics.fillStyle(0x0b4f6c, 0.92);
    this.tideGraphics.fillRect(-S(50), this.tideY, w + S(100), S(4000));
    this.tideGraphics.fillStyle(0x1a7fa0, 0.9);
    const t = this.time.now / 300;
    for (let x = -S(50); x <= w + S(50); x += S(20)) {
      const wave = Math.sin(x * 0.02 + t) * S(6);
      this.tideGraphics.fillRect(x, this.tideY + wave - S(6), S(20), S(10));
    }
  }

  private zoneFor(m: number): 0 | 1 | 2 {
    return m < ONBOARDING_M ? 0 : m < FLOW_M ? 1 : 2;
  }

  /** Soft outer glow so every interactable reads at a glance (Rule of
   *  Distinction). GPU-only (WebGL); silently no-ops on the Canvas renderer. */
  private glow(obj: any, color: number, strength = 4) {
    try {
      obj.preFX?.addGlow?.(color, strength, 0);
    } catch {
      /* Canvas renderer — no preFX pipeline */
    }
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
    this.generatePlatformAt(x, y, technical);
  }

  private generatePlatformAt(x: number, y: number, technical = false) {
    const w = this.scale.width;
    const margin = S(46);
    const zone = this.zoneFor(this.scoreMeters);

    // Platform kind by zone + rhythm. Onboarding teaches on solid ground (normal,
    // the odd spring). Special mechanics (break/move) appear from the flow zone
    // and mostly on technical steps, so the two calm steps stay dependable.
    let kind: PlatKind = 'normal';
    const r = Math.random();
    if (zone === 0) {
      if (r < 0.14) kind = 'spring';
    } else if (zone === 1) {
      if (technical) {
        if (r < 0.16) kind = 'break';
        else if (r < 0.4) kind = 'move';
        else if (r < 0.52) kind = 'spring';
      } else if (r < 0.14) kind = 'spring';
    } else {
      if (technical) {
        if (r < 0.24) kind = 'break';
        else if (r < 0.52) kind = 'move';
        else if (r < 0.62) kind = 'spring';
      } else if (r < 0.16) kind = 'spring';
      else if (r < 0.24) kind = 'move';
    }

    this.spawnPlatform(x, y, kind);

    // Pearls: far fewer than before (was up to 85% of platforms → "too many").
    // A modest chance, and higher-value clusters sit on technical steps
    // (risk/reward — harder jumps pay more). Each pearl gets a soft gold glow +
    // a readable size so it's obvious at a glance.
    const coinChance = (technical ? 0.42 : 0.22) * this.coinMult;
    if (Math.random() < Math.min(0.5, coinChance)) {
      const cluster = technical && Math.random() < 0.35 ? 3 : 1;
      for (let i = 0; i < cluster; i++) {
        const cx = Phaser.Math.Clamp(x + S((i - (cluster - 1) / 2) * 26), margin, w - margin);
        const coin = this.coins.create(cx, y - S(30), 'coin_pearl');
        coin.setScale(S(0.14));
        coin.body.setAllowGravity(false);
        coin.setDepth(19);
        this.glow(coin, 0xffe08a, 4);
        this.tweens.add({ targets: coin, y: coin.y - S(6), duration: 700, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      }
    }

    // Power-ups: uncommon, now bigger with a type-coloured halo so the three
    // kinds read apart instantly (dolphin=cyan, law=blue, shield=green).
    if (Math.random() < 0.06) {
      const kinds: PowerupData['kind'][] = ['dolphin', 'law', 'shield'];
      const k = Phaser.Utils.Array.GetRandom(kinds);
      const spriteKey = k === 'dolphin' ? 'powerup_dolphin' : k === 'law' ? 'powerup_law' : 'powerup_shield';
      const pu = this.powerups.create(x + Phaser.Math.Between(-S(16), S(16)), y - S(46), spriteKey);
      pu.setData('kind', k);
      pu.setScale(S(0.17));
      pu.body.setAllowGravity(false);
      pu.setDepth(19);
      this.glow(pu, k === 'dolphin' ? 0x4ff0ff : k === 'law' ? 0x6db8ff : 0x7dff9e, 6);
      this.tweens.add({ targets: pu, angle: 360, duration: 3000, repeat: -1 });
    }

    // Heart pickup — a collectible extra life. Kept RARE and well-spaced (~110 m
    // between hearts) and only while below the life cap so none are wasted.
    if (getState().lives < MAX_LIVES && this.lastHeartY - y > S(2200) && Math.random() < 0.06) {
      const heart = this.add
        .text(x + Phaser.Math.Between(-S(18), S(18)), y - S(46), '❤️', { fontSize: `${S(26)}px` })
        .setOrigin(0.5)
        .setDepth(19);
      this.physics.add.existing(heart);
      this.hearts.add(heart as any);
      const body = heart.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setSize(S(24), S(24));
      this.tweens.add({ targets: heart, y: heart.y - S(6), duration: 700, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      this.lastHeartY = y;
    }

    // Hazards: NONE during onboarding (<300 m) so new players learn the jump
    // safely (removes the old un-telegraphed spike). From the flow zone they
    // appear, concentrated on technical steps, ramping with height. The deadly
    // lunging threats (shark, poacher) hold back until the mastery zone (>800 m).
    // Always to the side — never walling the only path.
    if (this.scoreMeters >= ONBOARDING_M) {
      const base = zone === 2 ? 0.16 : 0.08;
      let hazChance = Math.min(0.34, (base + this.difficultyLevel * 0.015) * this.hazardMult);
      if (!technical) hazChance *= 0.4; // keep the calm steps mostly clear
      if (Math.random() < hazChance) {
        const hazOffset = Phaser.Math.Between(-S(70), S(70));
        const hx = Phaser.Math.Clamp(x + hazOffset, margin, w - margin);
        const roll = Math.random();
        let hk: HazardKind = 'trash';
        if (this.scoreMeters > FLOW_M) {
          if (roll < 0.2) hk = 'shark';
          else if (roll < 0.38) hk = 'human';
          else if (roll < 0.55) hk = 'rock';
          else if (roll < 0.75) hk = 'oil';
        } else {
          if (this.difficultyLevel > 4 && roll < 0.22) hk = 'rock';
          else if (this.difficultyLevel > 2 && roll < 0.5) hk = 'oil';
        }
        this.spawnHazard(hx, y - S(58), hk, w, margin);
      }
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
        .text(startX, y, '🦈', { fontSize: `${S(32)}px` })
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
      const human = this.add.text(x, y, '🤿', { fontSize: `${S(26)}px` }).setOrigin(0.5).setDepth(19);
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

      const rock = this.add.text(startX, y, '🪨', { fontSize: `${S(22)}px` }).setOrigin(0.5).setDepth(19);
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
      const oil = this.add.ellipse(x, y, S(64), S(24), 0x090909, 0.82).setDepth(17);
      this.physics.add.existing(oil);
      this.hazards.add(oil as any); // see rock's comment above
      const body = oil.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false);
      body.setSize(S(56), S(18));
      oil.setData('kind', 'oil');
      this.tweens.add({ targets: oil, alpha: 0.45, duration: 900, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      return;
    }

    // trash (default) — floating plastic debris drifting side to side.
    const hz = this.hazards.create(x, y, 'trash_hazard');
    hz.setScale(S(0.13));
    hz.body.setAllowGravity(false);
    hz.setDepth(19);
    hz.setData('kind', 'trash');
    this.glow(hz, 0xff7a3d, 4);
    this.tweens.add({
      targets: hz,
      x: Phaser.Math.Clamp(x + Phaser.Math.Between(-S(40), S(40)), margin, w - margin),
      duration: 2000,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
  }

  private spawnPlatform(x: number, y: number, kind: PlatKind) {
    const key =
      kind === 'normal' ? 'platform_normal' : kind === 'move' ? 'platform_move' : kind === 'break' ? 'platform_break' : 'platform_spring';
    const plat = this.platforms.create(x, y, key) as Phaser.Physics.Arcade.Sprite;
    plat.setScale(S(0.16));
    plat.refreshBody();
    plat.setSize(plat.width * 0.9, plat.height * 0.5);
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
    playSfx('jump');
    this.cameras.main.shake(kind === 'spring' ? 90 : 40, kind === 'spring' ? 0.006 : 0.002);
    this.tweens.killTweensOf(this.player);
    this.player.setScale(S(0.26), S(0.16));
    this.tweens.add({ targets: this.player, scaleX: S(0.22), scaleY: S(0.22), duration: 180, ease: 'back.out' });
  }

  private handleCoin(_player: any, coinObj: any) {
    coinObj.destroy();
    // Combo: grabbing coins in quick succession (within the 900ms window)
    // ramps the payout up to +5 per pearl. The window lapsing resets the
    // chain. Previously the on-screen "+N 🦪" was shown but never actually
    // awarded, and the combo never reset — this makes the reward real.
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
      this.shieldIcon = this.add.image(this.player.x, this.player.y, 'powerup_shield').setScale(S(0.3)).setDepth(21).setAlpha(0.7);
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
      this.shieldIcon?.destroy();
      if (kind !== 'oil') hazObj.destroy();
      this.floatText('Shield Absorbed!', this.player.x, this.player.y - S(40), '#a8e6cf');
      this.invulnerableUntil = this.time.now + 800;
      return;
    }

    if (kind === 'oil') {
      // Doesn't knock you off — it makes you slip: steering gets sluggish
      // for a few seconds. No punt, but genuinely risky near a tight gap
      // since you can't correct your line as fast. The slick itself
      // stays put (it's a hazard patch, not a one-shot pickup).
      this.slipperyUntil = this.time.now + 2500;
      this.invulnerableUntil = this.time.now + 2500;
      this.cameras.main.shake(80, 0.004);
      this.floatText('Slipped on an oil slick! 🛢️', this.player.x, this.player.y - S(40), '#7fdfff');
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

    // Input movement
    let moveX = 0;
    if (this.cursors.left.isDown) moveX = -1;
    else if (this.cursors.right.isDown) moveX = 1;
    else if (this.pointerDown) {
      const diff = this.pointerX - this.player.x;
      moveX = Phaser.Math.Clamp(diff / S(60), -1, 1);
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

    // Generate more platforms above as needed, always using the
    // guaranteed-reachable gap + offset picker.
    while (this.lastPlatformY > this.player.y - S(900)) {
      this.generateNextPlatform();
    }

    // Cleanup platforms/coins far below
    const cleanupY = this.player.y + S(700);
    [this.platforms, this.coins, this.powerups, this.hazards, this.hearts].forEach((group) => {
      group.children.iterate((obj: any) => {
        if (obj && obj.y > cleanupY) obj.destroy();
        return true;
      });
    });

    // Tide: SMOOTH, velocity-based rise (never snapped to the player's
    // position). Speed = a constant base that slowly ramps over the run, plus
    // an acceleration proportional to how far the tide has fallen below the
    // bottom of the view. Measuring against the camera bottom (which moves
    // smoothly, not per-bounce) means the water never "jumps" when you jump —
    // it just rises faster to chase when you pull ahead, and rises into view
    // when you slow or stop.
    const elapsed = (this.time.now - this.runStartTime) / 1000;
    const viewBottom = this.cameras.main.scrollY + this.scale.height;
    const gapBelowScreen = (this.tideY - viewBottom) / S(1); // design px the tide sits below the visible bottom
    // Time-based rise is CAPPED (+80 design px/s over the base) so a long, skilful
    // climb never becomes unsurvivable by tide speed alone — past ~800 m the
    // pressure comes from platform placement + hazards, not a runaway wall. The
    // chase term still lets the tide surge to catch a player who stalls.
    const inGrace = this.time.now < this.tideGraceUntil;
    const baseRise = this.baseTideSpeed + Math.min(80, elapsed * TIDE_TIME_ACCEL);
    // Opening grace: disable chase entirely. This is what stops a fast opening
    // staircase / springs burst from triggering the "3× climb" rocket flood
    // within the first 3 s; after grace, chase is gentle again (0.24).
    const chase = inGrace
      ? 0
      : TIDE_CHASE_GAIN * Math.max(0, gapBelowScreen - TIDE_TARGET_BELOW_SCREEN);
    this.tideSpeed = Math.min(TIDE_MAX_SPEED, baseRise + chase);

    const tideSlowActive = this.time.now < this.tideSlowUntil;
    let effSpeed = tideSlowActive ? this.tideSpeed * 0.25 : this.tideSpeed;
    // Opening grace: clamp the effective rise to a very slow crawl, so the
    // player can afford to miss-tune the very first bounce without being
    // pushed off the bottom by a rising wall.
    if (inGrace) effSpeed = Math.min(effSpeed, TIDE_START_GRACE_MAX_SPEED);
    this.tideY -= S(effSpeed) * dt;
    this.drawTide();


    const distToTide = this.tideY - this.player.y;
    if (tideSlowActive) {
      this.tideWarnText.setText('📜 Law slows the tide!').setColor('#9be7ff');
    } else if (distToTide < S(260)) {
      this.tideWarnText.setText('⚠️ TIDE RISING FAST!').setColor('#ef476f');
    } else {
      this.tideWarnText.setText('🌊 Tide below').setColor('#ffd166');
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
      playSfx('powerup');
      this.cameras.main.flash(220, 255, 120, 160);
      this.scene.start('GameScene', {
        revive: {
          meters: Math.floor(this.scoreMeters),
          coins: this.coinsCollected,
          bankedCoins: this.bankedCoins,
        },
      });
      return;
    }

    this.isGameOver = true;
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
      });
    });
  }
}

function mapIdToBg(id: string): string {
  return id === 'lagoon' ? 'bg_lagoon' : id === 'reef' ? 'bg_reef' : id === 'storm' ? 'bg_storm' : 'bg_lagoon';
}
