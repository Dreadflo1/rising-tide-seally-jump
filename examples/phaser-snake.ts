/**
 * Reference example: classic Snake in Phaser 3.
 *
 * Read this file to learn the Phaser idioms the system prompt expects.
 * Do NOT import it directly into your own game -- copy the patterns instead.
 *
 * Demonstrates:
 *   - Multi-scene flow: Title -> Game -> GameOver (with restart)
 *   - Phaser.Scale.RESIZE so the game fills any viewport / mobile screen
 *   - Webfontloader for a custom Google Font (Press Start 2P)
 *   - Howler audio (the prompt's preferred audio API across engines)
 *   - Built-in Phaser particle system on apple eat
 *   - Camera screen-shake on death (juice!)
 *   - tween.js for a pulsing title animation (engine-agnostic)
 *   - Swipe + keyboard input (mobile-friendly without a virtual joystick)
 *   - High-score persistence to localStorage
 */

import Phaser from "phaser";
import { Howl } from "howler";
import { Tween, Easing } from "@tweenjs/tween.js";
import WebFont from "webfontloader";

// --- Constants -------------------------------------------------------------

const CELL_PX = 24;
const COLS = 18;
const ROWS = 28;
const BOARD_W = COLS * CELL_PX;
const BOARD_H = ROWS * CELL_PX;
const STEP_MS = 110;
const COLORS = {
  bg: "#0d1117",
  snake: "#7ed957",
  head: "#b5ff85",
  apple: "#ff5e5b",
  hud: "#e6e6e6",
} as const;
const FONT_FAMILY = '"Press Start 2P"';
const HIGH_SCORE_KEY = "snake.highScore";

// --- Procedural blip helpers (no .wav assets needed for the example) -------

function makeBlip(freqHz: number, durationS: number, volume = 0.25): Howl {
  // A 1-channel WAV header + sine samples encoded as a data: URL so the
  // example doesn't need any binary assets. Real games should ship .ogg
  // or .wav files via `fetch_game_asset` or by importing them with Vite.
  const sampleRate = 22050;
  const sampleCount = Math.floor(durationS * sampleRate);
  const data = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const envelope = 1 - i / sampleCount;
    const s = Math.sin((i / sampleRate) * freqHz * Math.PI * 2) * envelope;
    data[i] = Math.max(-1, Math.min(1, s)) * 32767;
  }
  const wav = encodeWav(data, sampleRate);
  const url = "data:audio/wav;base64," + btoa(String.fromCharCode(...new Uint8Array(wav)));
  return new Howl({ src: [url], volume });
}

function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return buffer;
}

// --- Boot scene: load the Google Font, then start TitleScene ---------------

class BootScene extends Phaser.Scene {
  constructor() { super("Boot"); }

  create() {
    WebFont.load({
      google: { families: ["Press Start 2P"] },
      active: () => this.scene.start("Title"),
      inactive: () => this.scene.start("Title"),  // fall back to system font
    });
  }
}

// --- Title scene -----------------------------------------------------------

class TitleScene extends Phaser.Scene {
  private titleText!: Phaser.GameObjects.Text;
  private titleTween!: Tween<{ s: number }>;

  constructor() { super("Title"); }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.bg);
    const { centerX, centerY } = this.cameras.main;

    this.titleText = this.add.text(centerX, centerY - 60, "SNAKE", {
      fontFamily: FONT_FAMILY,
      fontSize: "48px",
      color: COLORS.hud,
    }).setOrigin(0.5);

    this.add.text(centerX, centerY + 20, "tap or press SPACE", {
      fontFamily: FONT_FAMILY,
      fontSize: "16px",
      color: COLORS.snake,
    }).setOrigin(0.5);

    const hi = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
    this.add.text(centerX, centerY + 80, `BEST  ${hi}`, {
      fontFamily: FONT_FAMILY,
      fontSize: "14px",
      color: COLORS.apple,
    }).setOrigin(0.5);

    // tween.js v25: must explicitly .start(); update via the scene loop.
    const scale = { s: 1 };
    this.titleTween = new Tween(scale)
      .to({ s: 1.08 }, 700)
      .easing(Easing.Sinusoidal.InOut)
      .yoyo(true)
      .repeat(Infinity)
      .onUpdate(() => this.titleText.setScale(scale.s))
      .start();

    this.input.keyboard?.once("keydown-SPACE", () => this.scene.start("Game"));
    this.input.once("pointerdown", () => this.scene.start("Game"));
  }

  update(time: number) {
    this.titleTween.update(time);
  }
}

// --- Game scene ------------------------------------------------------------

type Cell = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";

class GameScene extends Phaser.Scene {
  private snake: Cell[] = [];
  private direction: Direction = "right";
  private nextDirection: Direction = "right";
  private apple: Cell = { x: 0, y: 0 };
  private elapsed = 0;
  private score = 0;
  private scoreText!: Phaser.GameObjects.Text;
  private particles!: Phaser.GameObjects.Particles.ParticleEmitter;
  private eatSound!: Howl;
  private deathSound!: Howl;
  private swipeStart: { x: number; y: number } | null = null;

  constructor() { super("Game"); }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.bg);

    // Centre the playfield inside the viewport.
    const offsetX = (this.scale.width - BOARD_W) / 2;
    const offsetY = (this.scale.height - BOARD_H) / 2;
    this.cameras.main.setScroll(-offsetX, -offsetY);

    this.add.rectangle(BOARD_W / 2, BOARD_H / 2, BOARD_W, BOARD_H, 0x101820)
      .setStrokeStyle(2, 0x2a2f3a);

    this.snake = [
      { x: 8, y: 14 }, { x: 7, y: 14 }, { x: 6, y: 14 },
    ];
    this.direction = "right";
    this.nextDirection = "right";
    this.score = 0;
    this.elapsed = 0;
    this.spawnApple();

    this.scoreText = this.add.text(8, -28, "Score: 0", {
      fontFamily: FONT_FAMILY,
      fontSize: "16px",
      color: COLORS.hud,
    });

    // Tiny rectangular particle for the eat burst.
    const burstTexKey = "burst-px";
    if (!this.textures.exists(burstTexKey)) {
      const g = this.add.graphics();
      g.fillStyle(0xffe066, 1).fillRect(0, 0, 4, 4);
      g.generateTexture(burstTexKey, 4, 4);
      g.destroy();
    }
    this.particles = this.add.particles(0, 0, burstTexKey, {
      lifespan: 500,
      speed: { min: 80, max: 220 },
      scale: { start: 1.2, end: 0 },
      gravityY: 200,
      emitting: false,
    });

    this.eatSound = makeBlip(880, 0.08, 0.3);
    this.deathSound = makeBlip(140, 0.4, 0.4);

    // Keyboard.
    this.input.keyboard?.on("keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") this.queueDirection("up");
      else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") this.queueDirection("down");
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") this.queueDirection("left");
      else if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") this.queueDirection("right");
    });

    // Touch / mouse swipes.
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.swipeStart = { x: p.x, y: p.y };
    });
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.swipeStart) return;
      const dx = p.x - this.swipeStart.x;
      const dy = p.y - this.swipeStart.y;
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      if (Math.abs(dx) > Math.abs(dy)) this.queueDirection(dx > 0 ? "right" : "left");
      else this.queueDirection(dy > 0 ? "down" : "up");
      this.swipeStart = null;
    });
  }

  update(_time: number, delta: number) {
    this.elapsed += delta;
    if (this.elapsed < STEP_MS) {
      this.redraw();
      return;
    }
    this.elapsed = 0;
    this.step();
    this.redraw();
  }

  private queueDirection(d: Direction) {
    const opposite: Record<Direction, Direction> = {
      up: "down", down: "up", left: "right", right: "left",
    };
    if (d === opposite[this.direction]) return;  // can't reverse into self
    this.nextDirection = d;
  }

  private step() {
    this.direction = this.nextDirection;
    const head = this.snake[0];
    const dx = this.direction === "left" ? -1 : this.direction === "right" ? 1 : 0;
    const dy = this.direction === "up" ? -1 : this.direction === "down" ? 1 : 0;
    const next: Cell = { x: head.x + dx, y: head.y + dy };

    // Wall collision.
    if (next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS) {
      return this.die();
    }
    // Self collision.
    for (const segment of this.snake) {
      if (segment.x === next.x && segment.y === next.y) return this.die();
    }

    this.snake.unshift(next);

    if (next.x === this.apple.x && next.y === this.apple.y) {
      this.score += 10;
      this.scoreText.setText(`Score: ${this.score}`);
      this.eatSound.play();
      const px = this.apple.x * CELL_PX + CELL_PX / 2;
      const py = this.apple.y * CELL_PX + CELL_PX / 2;
      this.particles.emitParticleAt(px, py, 16);
      this.spawnApple();
    } else {
      this.snake.pop();
    }
  }

  private die() {
    this.deathSound.play();
    this.cameras.main.shake(220, 0.012);
    this.time.delayedCall(420, () => {
      this.scene.start("GameOver", { score: this.score });
    });
  }

  private spawnApple() {
    while (true) {
      const candidate: Cell = {
        x: Phaser.Math.Between(0, COLS - 1),
        y: Phaser.Math.Between(0, ROWS - 1),
      };
      if (!this.snake.some((s) => s.x === candidate.x && s.y === candidate.y)) {
        this.apple = candidate;
        return;
      }
    }
  }

  private redraw() {
    // Cheap full redraw — Snake is tiny so this is fine.
    const graphicsKey = "snake-graphics";
    let g = this.children.getByName(graphicsKey) as Phaser.GameObjects.Graphics | null;
    if (!g) {
      g = this.add.graphics();
      g.setName(graphicsKey);
    }
    g.clear();

    g.fillStyle(Phaser.Display.Color.HexStringToColor(COLORS.apple).color);
    g.fillRect(this.apple.x * CELL_PX + 2, this.apple.y * CELL_PX + 2, CELL_PX - 4, CELL_PX - 4);

    for (let i = 0; i < this.snake.length; i++) {
      const c = this.snake[i];
      const color = i === 0 ? COLORS.head : COLORS.snake;
      g.fillStyle(Phaser.Display.Color.HexStringToColor(color).color);
      g.fillRect(c.x * CELL_PX + 1, c.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    }
  }
}

// --- Game over scene -------------------------------------------------------

class GameOverScene extends Phaser.Scene {
  constructor() { super("GameOver"); }

  create(data: { score: number }) {
    this.cameras.main.setBackgroundColor(COLORS.bg);
    const { centerX, centerY } = this.cameras.main;
    const score = data?.score ?? 0;

    const prev = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
    const isNewBest = score > prev;
    if (isNewBest) localStorage.setItem(HIGH_SCORE_KEY, String(score));

    this.add.text(centerX, centerY - 60, "GAME OVER", {
      fontFamily: FONT_FAMILY, fontSize: "32px", color: COLORS.apple,
    }).setOrigin(0.5);

    this.add.text(centerX, centerY, `Score  ${score}`, {
      fontFamily: FONT_FAMILY, fontSize: "20px", color: COLORS.hud,
    }).setOrigin(0.5);

    this.add.text(centerX, centerY + 40, isNewBest ? "NEW BEST!" : `Best  ${prev}`, {
      fontFamily: FONT_FAMILY, fontSize: "14px",
      color: isNewBest ? COLORS.snake : COLORS.hud,
    }).setOrigin(0.5);

    this.add.text(centerX, centerY + 100, "tap to restart", {
      fontFamily: FONT_FAMILY, fontSize: "14px", color: COLORS.snake,
    }).setOrigin(0.5);

    this.input.keyboard?.once("keydown-SPACE", () => this.scene.start("Title"));
    this.input.once("pointerdown", () => this.scene.start("Title"));
  }
}

// --- Game config -----------------------------------------------------------

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: COLORS.bg,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, TitleScene, GameScene, GameOverScene],
});
