/**
 * Reference example: 3D physics-knockdown in Babylon.js + Havok.
 *
 * Read this file to learn the Babylon idioms the system prompt expects.
 * Do NOT import it directly into your own game -- copy the patterns instead.
 *
 * Demonstrates:
 *   - DEEP IMPORTS only (no `from "@babylonjs/core"` barrel — kills tree-shaking)
 *   - `await HavokPhysics()` BEFORE `scene.enablePhysics(...)`
 *   - PhysicsAggregate v2 API (one call for body + shape + properties)
 *   - ArcRotateCamera with attachControl for free orbit
 *   - @babylonjs/gui for HUD that overlays the canvas
 *   - Howler audio (engine-agnostic — even in Babylon)
 *   - Click / touch input for launching projectiles
 *   - Restart loop with full physics-state reset
 *
 * Goal: click anywhere to launch a ball at the cube tower. Knock all 9
 * cubes off the pedestal to win. Refresh / press R to reset.
 */

// --- Deep imports ONLY -----------------------------------------------------

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Loading/loadingScreen";  // side-effect: enables Engine.runRenderLoop default loader
import "@babylonjs/core/Helpers/sceneHelpers";   // side-effect: createDefaultSkybox / createDefaultEnvironment

import HavokPhysics from "@babylonjs/havok";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";

import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { Control } from "@babylonjs/gui/2D/controls/control";

import { Howl } from "howler";

// --- Constants -------------------------------------------------------------

const PEDESTAL_HEIGHT = 1;
const PEDESTAL_RADIUS = 2.2;
const BLOCK_SIZE = 0.6;
const BLOCK_GRID = 3;                  // 3x3x1 tower = 9 blocks
const LAUNCH_SPEED = 22;
const BALL_RADIUS = 0.3;
const KILL_Y = -8;                     // off-pedestal threshold

// --- Audio (procedural blips so the example needs no .wav assets) ----------

function makeBlip(freqHz: number, durationS: number, volume = 0.3): Howl {
  const sr = 22050;
  const n = Math.floor(durationS * sr);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = 1 - i / n;
    data[i] = Math.max(-1, Math.min(1,
      Math.sin((i / sr) * freqHz * Math.PI * 2) * env,
    )) * 32767;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, data[i], true);
  return new Howl({
    src: ["data:audio/wav;base64," + btoa(String.fromCharCode(...new Uint8Array(buf)))],
    volume,
  });
}

const launchSound = makeBlip(440, 0.1, 0.25);
const winSound = makeBlip(880, 0.4, 0.35);

// --- Canvas + engine -------------------------------------------------------

const parent = document.getElementById("game") ?? document.body;
const canvas = document.createElement("canvas");
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.display = "block";
canvas.style.outline = "none";
canvas.tabIndex = 0;
parent.appendChild(canvas);

const engine = new Engine(canvas, true, { stencil: true });

// --- Async scene init (needed for Havok) -----------------------------------

async function createScene(): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);

  const camera = new ArcRotateCamera("camera",
    -Math.PI / 2, Math.PI / 3.2, 12,
    new Vector3(0, 1, 0), scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 22;
  camera.wheelPrecision = 20;

  new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.4;
  const sun = new DirectionalLight("sun", new Vector3(-1, -2, -1), scene);
  sun.intensity = 0.9;

  // Physics — order matters: Havok WASM first, then plugin, then enable.
  const havokInstance = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havokInstance);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havokPlugin);

  buildArena(scene);
  spawnTower(scene);

  return scene;
}

// --- Static arena ---------------------------------------------------------

function buildArena(scene: Scene) {
  // Floor (catches knocked-off blocks so the agent sees them land + bounce).
  const floor = MeshBuilder.CreateGround("floor", { width: 30, height: 30 }, scene);
  floor.position.y = -PEDESTAL_HEIGHT - 0.5;
  const floorMat = new StandardMaterial("floorMat", scene);
  floorMat.diffuseColor = new Color3(0.1, 0.13, 0.18);
  floor.material = floorMat;
  new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // Pedestal — short cylinder; blocks stack on top.
  const pedestal = MeshBuilder.CreateCylinder("pedestal", {
    height: PEDESTAL_HEIGHT, diameter: PEDESTAL_RADIUS * 2,
  }, scene);
  pedestal.position.y = 0;
  const pedMat = new StandardMaterial("pedMat", scene);
  pedMat.diffuseColor = new Color3(0.4, 0.4, 0.45);
  pedestal.material = pedMat;
  new PhysicsAggregate(pedestal, PhysicsShapeType.CYLINDER, { mass: 0 }, scene);
}

// --- Mutable game state ----------------------------------------------------

const blocks: Mesh[] = [];
const balls: Mesh[] = [];
let score = 0;
let won = false;

function spawnTower(scene: Scene) {
  // Clear any leftovers.
  blocks.forEach((b) => b.dispose());
  blocks.length = 0;
  balls.forEach((b) => b.dispose());
  balls.length = 0;
  score = 0;
  won = false;

  const startY = PEDESTAL_HEIGHT / 2 + BLOCK_SIZE / 2 + 0.001;
  for (let row = 0; row < BLOCK_GRID; row++) {
    for (let col = 0; col < BLOCK_GRID; col++) {
      const block = MeshBuilder.CreateBox(`block-${row}-${col}`, {
        size: BLOCK_SIZE,
      }, scene);
      block.position.set(
        (col - 1) * (BLOCK_SIZE + 0.05),
        startY,
        (row - 1) * (BLOCK_SIZE + 0.05),
      );
      const mat = new StandardMaterial(`blockMat-${row}-${col}`, scene);
      mat.diffuseColor = Color3.FromHexString(blockHex(row * BLOCK_GRID + col));
      block.material = mat;
      new PhysicsAggregate(block, PhysicsShapeType.BOX, {
        mass: 0.5, restitution: 0.3, friction: 0.6,
      }, scene);
      blocks.push(block);
    }
  }
  updateHud();
}

function blockHex(i: number): string {
  const palette = ["#ff5e5b", "#ffc145", "#7ed957", "#4fc3f7", "#b06cf0"];
  return palette[i % palette.length];
}

// --- Projectile launch ----------------------------------------------------

function launchBallFromCamera(scene: Scene) {
  if (won) return;
  const camera = scene.activeCamera as ArcRotateCamera;
  const origin = camera.position.clone();
  // Direction from camera toward the tower center.
  const target = new Vector3(0, 0.5, 0);
  const dir = target.subtract(origin).normalize();

  const ball = MeshBuilder.CreateSphere("ball", {
    diameter: BALL_RADIUS * 2, segments: 12,
  }, scene);
  ball.position.copyFrom(origin.add(dir.scale(0.5)));
  const ballMat = new StandardMaterial("ballMat", scene);
  ballMat.diffuseColor = new Color3(1, 0.9, 0.3);
  ballMat.emissiveColor = new Color3(0.5, 0.4, 0.1);
  ball.material = ballMat;

  const agg = new PhysicsAggregate(ball, PhysicsShapeType.SPHERE, {
    mass: 1.5, restitution: 0.4, friction: 0.5,
  }, scene);
  agg.body.setLinearVelocity(dir.scale(LAUNCH_SPEED));

  balls.push(ball);
  launchSound.play();
}

// --- Off-pedestal scoring loop -------------------------------------------

function checkScoring(scene: Scene) {
  // A block counts as "knocked off" once its centre falls below the
  // pedestal surface AND it's outside the pedestal radius (so balls
  // sitting on top of the pedestal don't count).
  for (const block of blocks) {
    if ((block as Mesh & { _scored?: boolean })._scored) continue;
    const p = block.position;
    const offTop = p.y < 0;
    const outside = Math.sqrt(p.x * p.x + p.z * p.z) > PEDESTAL_RADIUS;
    if (offTop && outside) {
      (block as Mesh & { _scored?: boolean })._scored = true;
      score++;
      updateHud();
      if (score >= blocks.length && !won) {
        won = true;
        winSound.play();
        updateHud();
      }
    }
  }

  // Cull balls that fell forever.
  for (let i = balls.length - 1; i >= 0; i--) {
    if (balls[i].position.y < KILL_Y) {
      balls[i].dispose();
      balls.splice(i, 1);
    }
  }
}

// --- HUD (GUI overlay) ----------------------------------------------------

let hudText: TextBlock | undefined;
let hudHint: TextBlock | undefined;

function setupHud(scene: Scene) {
  const ui = AdvancedDynamicTexture.CreateFullscreenUI("ui", true, scene);

  hudText = new TextBlock();
  hudText.text = "";
  hudText.color = "white";
  hudText.fontSize = 28;
  hudText.fontFamily = "Press Start 2P, monospace";
  hudText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  hudText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  hudText.paddingTop = "16px";
  hudText.paddingLeft = "16px";
  ui.addControl(hudText);

  hudHint = new TextBlock();
  hudHint.text = "Click / tap to launch  •  R to reset";
  hudHint.color = "#ffe066";
  hudHint.fontSize = 18;
  hudHint.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  hudHint.paddingBottom = "16px";
  ui.addControl(hudHint);

  updateHud();
}

function updateHud() {
  if (!hudText) return;
  hudText.text = won
    ? `YOU WIN!  ${score}/${blocks.length}`
    : `${score}/${blocks.length}`;
}

// --- Main entry ------------------------------------------------------------

(async () => {
  const scene = await createScene();
  setupHud(scene);

  canvas.addEventListener("pointerdown", () => launchBallFromCamera(scene));
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") spawnTower(scene);
    if (e.code === "Space") launchBallFromCamera(scene);
  });

  scene.onBeforeRenderObservable.add(() => checkScoring(scene));

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
})();
