/**
 * Reference example: slingshot projectile game in Phaser 3.
 *
 * Demonstrates the physics patterns that make projectile/slingshot games
 * feel satisfying. Read this before building any game with trajectories,
 * launches, or thrown objects.
 *
 * Key patterns:
 *   - Drag-to-aim with capped sling distance
 *   - Launch velocity from drag vector × sensitivity multiplier
 *   - Dotted trajectory prediction line (kinematic equations)
 *   - Higher gravity (800) for satisfying parabolic arcs
 *   - Destructible targets with collision callbacks
 *   - Camera follow on launched projectile
 *   - Score tracking + round reset
 *   - Touch + mouse input
 *
 * Do NOT import this file into your game. Copy the patterns.
 */
import Phaser from "phaser";
import { Howl } from "howler";

// ── Physics constants ──────────────────────────────────────────────
const GRAVITY = 800;
const LAUNCH_SENSITIVITY = 3;
const MAX_DRAG_DISTANCE = 120;
const MAX_LAUNCH_SPEED = 800;
const PROJECTILE_RADIUS = 16;
const TARGET_SIZE = 40;
const TARGETS_PER_ROUND = 5;
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;
const ANCHOR_X = 200;
const ANCHOR_Y = WORLD_HEIGHT - 200;

// ── Audio (lazy-loaded on first gesture) ───────────────────────────
let launchSfx: Howl | null = null;
let hitSfx: Howl | null = null;
function initAudio() {
  if (launchSfx) return;
  launchSfx = new Howl({ src: ["sounds/launch.wav"], volume: 0.5 });
  hitSfx = new Howl({ src: ["sounds/hit.ogg"], volume: 0.6 });
}

// ── Menu scene ─────────────────────────────────────────────────────
class MenuScene extends Phaser.Scene {
  constructor() {
    super("MenuScene");
  }

  create() {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    this.add.text(cx, cy - 60, "Slingshot", { fontSize: "48px", color: "#fff" }).setOrigin(0.5);
    this.add.text(cx, cy + 20, "Click / Tap to Start", { fontSize: "20px", color: "#aaa" }).setOrigin(0.5);
    this.input.once("pointerdown", () => {
      initAudio();
      this.scene.start("GameScene");
    });
  }
}

// ── Game scene ─────────────────────────────────────────────────────
class GameScene extends Phaser.Scene {
  private projectile!: Phaser.Physics.Arcade.Sprite;
  private targets!: Phaser.Physics.Arcade.StaticGroup;
  private trajectoryDots: Phaser.GameObjects.Arc[] = [];
  private slingLine!: Phaser.GameObjects.Line;
  private scoreText!: Phaser.GameObjects.Text;
  private score = 0;
  private isDragging = false;
  private isLaunched = false;
  private dragStart = { x: 0, y: 0 };

  constructor() {
    super("GameScene");
  }

  create() {
    this.score = 0;
    this.isLaunched = false;

    // World bounds
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Ground
    const ground = this.add.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT - 20, WORLD_WIDTH, 40, 0x4a7c59);
    this.physics.add.existing(ground, true);

    // Sling anchor marker
    this.add.circle(ANCHOR_X, ANCHOR_Y, 8, 0x8b4513);

    // Sling rubber band line (visual only)
    this.slingLine = this.add.line(0, 0, ANCHOR_X, ANCHOR_Y, ANCHOR_X, ANCHOR_Y, 0x8b4513, 1).setLineWidth(3).setOrigin(0);
    this.slingLine.setVisible(false);

    // Projectile
    const gfx = this.add.graphics();
    gfx.fillStyle(0xff4444);
    gfx.fillCircle(PROJECTILE_RADIUS, PROJECTILE_RADIUS, PROJECTILE_RADIUS);
    gfx.generateTexture("ball", PROJECTILE_RADIUS * 2, PROJECTILE_RADIUS * 2);
    gfx.destroy();

    this.projectile = this.physics.add.sprite(ANCHOR_X, ANCHOR_Y, "ball");
    this.projectile.setCircle(PROJECTILE_RADIUS);
    this.projectile.setBounce(0.4);
    this.projectile.setCollideWorldBounds(true);
    this.projectile.body!.setAllowGravity(false);

    // Targets
    this.targets = this.physics.add.staticGroup();
    this.spawnTargets();

    // Collision
    this.physics.add.collider(this.projectile, ground);
    this.physics.add.overlap(this.projectile, this.targets, this.onHitTarget, undefined, this);

    // Trajectory preview dots
    for (let i = 0; i < 30; i++) {
      const dot = this.add.circle(0, 0, 3, 0xffffff, 0.4);
      dot.setVisible(false);
      this.trajectoryDots.push(dot);
    }

    // HUD
    this.scoreText = this.add.text(16, 16, "Score: 0", { fontSize: "24px", color: "#fff" }).setScrollFactor(0);

    // Camera
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // ── Input: drag to aim ─────────────────────────────────────────
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.isLaunched) return;
      const dist = Phaser.Math.Distance.Between(p.worldX, p.worldY, ANCHOR_X, ANCHOR_Y);
      if (dist < 80) {
        this.isDragging = true;
        this.dragStart.x = p.worldX;
        this.dragStart.y = p.worldY;
      }
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.isDragging) return;
      const dx = p.worldX - ANCHOR_X;
      const dy = p.worldY - ANCHOR_Y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      const clamped = Math.min(dist, MAX_DRAG_DISTANCE);
      const angle = Math.atan2(dy, dx);
      const px = ANCHOR_X + Math.cos(angle) * clamped;
      const py = ANCHOR_Y + Math.sin(angle) * clamped;

      this.projectile.setPosition(px, py);
      this.slingLine.setTo(ANCHOR_X, ANCHOR_Y, px, py);
      this.slingLine.setVisible(true);

      // Trajectory preview: launch vector is anchor-to-drag inverted × sensitivity
      const vx = (ANCHOR_X - px) * LAUNCH_SENSITIVITY;
      const vy = (ANCHOR_Y - py) * LAUNCH_SENSITIVITY;
      this.drawTrajectory(ANCHOR_X, ANCHOR_Y, vx, vy);
    });

    this.input.on("pointerup", () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.slingLine.setVisible(false);
      this.hideTrajectory();
      this.launch();
    });
  }

  // ── Launch projectile ────────────────────────────────────────────
  private launch() {
    const px = this.projectile.x;
    const py = this.projectile.y;
    let vx = (ANCHOR_X - px) * LAUNCH_SENSITIVITY;
    let vy = (ANCHOR_Y - py) * LAUNCH_SENSITIVITY;

    // Clamp max speed
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > MAX_LAUNCH_SPEED) {
      const ratio = MAX_LAUNCH_SPEED / speed;
      vx *= ratio;
      vy *= ratio;
    }

    this.projectile.body!.setAllowGravity(true);
    this.projectile.setVelocity(vx, vy);
    this.isLaunched = true;
    this.cameras.main.startFollow(this.projectile, true, 0.1, 0.1);
    launchSfx?.play();

    // Reset after projectile settles (3 seconds)
    this.time.delayedCall(3000, () => this.resetRound());
  }

  // ── Trajectory preview (kinematic equations) ─────────────────────
  private drawTrajectory(startX: number, startY: number, vx: number, vy: number) {
    const dt = 0.016; // one frame at 60fps
    for (let i = 0; i < this.trajectoryDots.length; i++) {
      const t = (i + 1) * 2; // sample every 2 frames for spacing
      const x = startX + vx * t * dt;
      const y = startY + vy * t * dt + 0.5 * GRAVITY * (t * dt) * (t * dt);
      const dot = this.trajectoryDots[i];
      dot.setPosition(x, y);
      dot.setVisible(y < WORLD_HEIGHT && x > 0 && x < WORLD_WIDTH);
    }
  }

  private hideTrajectory() {
    for (const dot of this.trajectoryDots) dot.setVisible(false);
  }

  // ── Target hit ───────────────────────────────────────────────────
  private onHitTarget(
    _proj: Phaser.Types.Physics.Arcade.GameObjectWithBody | Phaser.Tilemaps.Tile,
    target: Phaser.Types.Physics.Arcade.GameObjectWithBody | Phaser.Tilemaps.Tile,
  ) {
    (target as Phaser.GameObjects.GameObject).destroy();
    this.score += 100;
    this.scoreText.setText(`Score: ${this.score}`);
    hitSfx?.play();

    // Screen shake on hit
    this.cameras.main.shake(150, 0.005);

    // Particle burst at hit location
    const t = target as Phaser.GameObjects.Rectangle;
    for (let i = 0; i < 6; i++) {
      const shard = this.add.rectangle(t.x, t.y, 8, 8, 0xffaa00);
      this.tweens.add({
        targets: shard,
        x: t.x + Phaser.Math.Between(-60, 60),
        y: t.y + Phaser.Math.Between(-80, 20),
        alpha: 0,
        scale: 0,
        duration: 400,
        onComplete: () => shard.destroy(),
      });
    }
  }

  // ── Round reset ──────────────────────────────────────────────────
  private resetRound() {
    this.isLaunched = false;
    this.projectile.setPosition(ANCHOR_X, ANCHOR_Y);
    this.projectile.setVelocity(0, 0);
    this.projectile.body!.setAllowGravity(false);
    this.cameras.main.stopFollow();
    this.cameras.main.pan(ANCHOR_X, ANCHOR_Y, 500);

    // Respawn targets if all destroyed
    if (this.targets.countActive() === 0) {
      this.spawnTargets();
    }
  }

  // ── Spawn targets at random positions on right side ──────────────
  private spawnTargets() {
    for (let i = 0; i < TARGETS_PER_ROUND; i++) {
      const x = Phaser.Math.Between(WORLD_WIDTH * 0.5, WORLD_WIDTH - 100);
      const y = Phaser.Math.Between(200, WORLD_HEIGHT - 100);
      const target = this.add.rectangle(x, y, TARGET_SIZE, TARGET_SIZE, 0x44cc44);
      this.targets.add(target);
    }
  }
}

// ── Game config ────────────────────────────────────────────────────
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#1a1a2e",
  physics: {
    default: "arcade",
    arcade: { gravity: { x: 0, y: GRAVITY }, debug: false },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
  },
  scene: [MenuScene, GameScene],
});
