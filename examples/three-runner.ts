/**
 * Reference example: 3D endless-jumper in Three.js + cannon-es.
 *
 * Read this file to learn the Three.js idioms the system prompt expects.
 * Do NOT import it directly into your own game -- copy the patterns instead.
 *
 * Demonstrates:
 *   - Three.js Scene + PerspectiveCamera + WebGLRenderer setup
 *   - cannon-es World with `world.fixedStep()` BEFORE syncing meshes
 *   - postprocessing EffectComposer with RenderPass + BloomEffect
 *   - troika-three-text for crisp UI text rendered into the 3D scene
 *   - Howler audio with a synthesized blip (no .wav files needed)
 *   - tween.js for a "score popup" UI animation
 *   - Touch (tap-to-jump) + keyboard (space) input
 *   - localStorage best-distance persistence
 */

import * as THREE from "three";
import { Body, Box, Plane, Vec3, World } from "cannon-es";
import { Howl } from "howler";
import { Tween, Easing } from "@tweenjs/tween.js";
import { Text } from "troika-three-text";
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from "postprocessing";

// --- Constants -------------------------------------------------------------

const SCROLL_SPEED = 14;                // world units per second
const SPAWN_INTERVAL_MS_START = 1400;
const SPAWN_INTERVAL_MS_MIN = 650;
const SPAWN_INTERVAL_SHRINK_PER_OBSTACLE = 12;
const JUMP_VELOCITY = 7;
const PLAYER_Y_GROUND = 0.5;
const HIGH_SCORE_KEY = "three-runner.bestDistance";

// --- Audio ----------------------------------------------------------------

function makeBlip(freqHz: number, durationS: number, volume = 0.3): Howl {
  const sampleRate = 22050;
  const sampleCount = Math.floor(durationS * sampleRate);
  const data = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const envelope = 1 - i / sampleCount;
    const s = Math.sin((i / sampleRate) * freqHz * Math.PI * 2) * envelope;
    data[i] = Math.max(-1, Math.min(1, s)) * 32767;
  }
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, "RIFF"); view.setUint32(4, 36 + data.length * 2, true);
  write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2, data[i], true);
  const url = "data:audio/wav;base64," + btoa(
    String.fromCharCode(...new Uint8Array(buffer))
  );
  return new Howl({ src: [url], volume });
}

const jumpSound = makeBlip(660, 0.08, 0.25);
const deathSound = makeBlip(140, 0.4, 0.35);

// --- Renderer + scene setup ------------------------------------------------

const parent = document.getElementById("game") ?? document.body;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(parent.clientWidth, parent.clientHeight);
parent.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d1117");
scene.fog = new THREE.Fog("#0d1117", 25, 80);

const camera = new THREE.PerspectiveCamera(
  60, parent.clientWidth / parent.clientHeight, 0.1, 200,
);
camera.position.set(0, 4, 7);
camera.lookAt(0, 1, -10);

scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(8, 12, 6);
scene.add(sun);

// Ground (visual + repeating stripes so motion is readable).
const groundGeo = new THREE.PlaneGeometry(8, 400);
const groundMat = new THREE.MeshStandardMaterial({ color: "#1b2532" });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.z = -180;
scene.add(ground);

const stripes: THREE.Mesh[] = [];
const stripeGeo = new THREE.PlaneGeometry(0.5, 0.5);
const stripeMat = new THREE.MeshStandardMaterial({ color: "#ffe066", emissive: "#ffaa33" });
for (let i = 0; i < 60; i++) {
  const stripe = new THREE.Mesh(stripeGeo, stripeMat);
  stripe.rotation.x = -Math.PI / 2;
  stripe.position.set(0, 0.01, -i * 6);
  scene.add(stripe);
  stripes.push(stripe);
}

// Player.
const playerMat = new THREE.MeshStandardMaterial({
  color: "#7ed957", emissive: "#2c6c2c", emissiveIntensity: 0.4,
});
const player = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), playerMat);
player.position.set(0, PLAYER_Y_GROUND, 0);
scene.add(player);

// --- Physics ---------------------------------------------------------------

const world = new World({ gravity: new Vec3(0, -20, 0) });

const groundBody = new Body({ mass: 0, shape: new Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

const playerBody = new Body({
  mass: 1,
  shape: new Box(new Vec3(0.5, 0.5, 0.5)),
  position: new Vec3(0, PLAYER_Y_GROUND, 0),
  fixedRotation: true,
});
world.addBody(playerBody);

// --- HUD (troika text, rendered into the scene as a sprite) ----------------

const scoreText = new Text();
scoreText.text = "0 m";
scoreText.fontSize = 0.6;
scoreText.color = "#e6e6e6";
scoreText.anchorX = "center";
scoreText.anchorY = "top";
scoreText.position.set(0, 5.5, 4);
scoreText.sync();
scene.add(scoreText);

const bestText = new Text();
bestText.fontSize = 0.3;
bestText.color = "#7ed957";
bestText.anchorX = "center";
bestText.anchorY = "top";
bestText.position.set(0, 5.0, 4);
bestText.sync();
scene.add(bestText);

const statusText = new Text();
statusText.text = "TAP or SPACE to jump";
statusText.fontSize = 0.45;
statusText.color = "#ffe066";
statusText.anchorX = "center";
statusText.anchorY = "middle";
statusText.position.set(0, 2.6, 4);
statusText.sync();
scene.add(statusText);

// --- Postprocessing --------------------------------------------------------

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new EffectPass(camera, new BloomEffect({
  intensity: 0.9,
  luminanceThreshold: 0.25,
  luminanceSmoothing: 0.2,
})));

// --- Obstacles -------------------------------------------------------------

type Obstacle = { mesh: THREE.Mesh; body: Body };
const obstacles: Obstacle[] = [];

function spawnObstacle() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: "#ff5e5b", emissive: "#aa1111", emissiveIntensity: 0.6,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.5, -60);
  scene.add(mesh);

  const body = new Body({
    mass: 0, type: Body.KINEMATIC,
    shape: new Box(new Vec3(0.5, 0.5, 0.5)),
    position: new Vec3(0, 0.5, -60),
  });
  world.addBody(body);

  obstacles.push({ mesh, body });
}

function removeObstacle(o: Obstacle) {
  scene.remove(o.mesh);
  world.removeBody(o.body);
  o.mesh.geometry.dispose();
  (o.mesh.material as THREE.Material).dispose();
}

// --- Game state ------------------------------------------------------------

type Phase = "playing" | "dead";
let phase: Phase = "playing";
let distance = 0;
let bestDistance = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
let onGround = true;
let spawnIntervalMs = SPAWN_INTERVAL_MS_START;
let spawnTimer = 0;
let obstaclesCleared = 0;
bestText.text = `BEST  ${Math.floor(bestDistance)} m`;
bestText.sync();

// Track ground contact via collide event so the player can only jump from the ground.
playerBody.addEventListener("collide", (event: { body: Body }) => {
  if (event.body === groundBody) onGround = true;
});

function jump() {
  if (phase !== "playing" || !onGround) return;
  playerBody.velocity.y = JUMP_VELOCITY;
  onGround = false;
  jumpSound.play();
}

function reset() {
  phase = "playing";
  distance = 0;
  spawnIntervalMs = SPAWN_INTERVAL_MS_START;
  spawnTimer = 0;
  obstaclesCleared = 0;
  while (obstacles.length) removeObstacle(obstacles.pop()!);
  playerBody.velocity.set(0, 0, 0);
  playerBody.position.set(0, PLAYER_Y_GROUND, 0);
  statusText.visible = true;
  statusText.text = "TAP or SPACE to jump";
  statusText.sync();
}

// --- Input -----------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    phase === "dead" ? reset() : jump();
  }
});
parent.addEventListener("pointerdown", () => {
  phase === "dead" ? reset() : jump();
});

// --- Main loop -------------------------------------------------------------

const clock = new THREE.Clock();
function animate(time: number) {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (phase === "playing") {
    // Hide the start prompt as soon as the player jumps once.
    if (playerBody.position.y > PLAYER_Y_GROUND + 0.05) {
      statusText.visible = false;
    }

    distance += SCROLL_SPEED * dt;
    spawnTimer += dt * 1000;
    if (spawnTimer >= spawnIntervalMs) {
      spawnTimer = 0;
      spawnObstacle();
      spawnIntervalMs = Math.max(
        SPAWN_INTERVAL_MS_MIN,
        spawnIntervalMs - SPAWN_INTERVAL_SHRINK_PER_OBSTACLE,
      );
    }

    // Scroll obstacles toward the player; remove past + check collision.
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      const newZ = o.body.position.z + SCROLL_SPEED * dt;
      o.body.position.z = newZ;
      o.mesh.position.z = newZ;
      if (newZ > 6) {
        removeObstacle(o);
        obstacles.splice(i, 1);
        obstaclesCleared++;
      } else if (Math.abs(newZ - playerBody.position.z) < 1 &&
                 Math.abs(playerBody.position.y - 0.5) < 0.9) {
        die();
      }
    }

    // Scroll the visual stripes for parallax (purely cosmetic).
    for (const s of stripes) {
      s.position.z += SCROLL_SPEED * dt;
      if (s.position.z > 8) s.position.z -= 60 * 6;
    }
  }

  // CRITICAL: world.fixedStep() BEFORE syncing meshes. See system prompt.
  world.fixedStep();
  player.position.copy(playerBody.position as unknown as THREE.Vector3);
  player.quaternion.copy(playerBody.quaternion as unknown as THREE.Quaternion);

  // HUD updates.
  scoreText.text = `${Math.floor(distance)} m`;
  scoreText.sync();

  // tween.js needs explicit update each frame.
  scoreTween.update(time);

  composer.render();
}

function die() {
  if (phase === "dead") return;
  phase = "dead";
  deathSound.play();
  const d = Math.floor(distance);
  if (d > bestDistance) {
    bestDistance = d;
    localStorage.setItem(HIGH_SCORE_KEY, String(d));
    bestText.text = `NEW BEST  ${d} m`;
  } else {
    bestText.text = `BEST  ${Math.floor(bestDistance)} m`;
  }
  bestText.sync();
  statusText.text = "TAP or SPACE to retry";
  statusText.visible = true;
  statusText.sync();

  // Pulse the score text on death.
  scoreTween = new Tween({ s: 1 })
    .to({ s: 1.6 }, 250)
    .easing(Easing.Quadratic.Out)
    .yoyo(true)
    .repeat(1)
    .onUpdate(({ s }) => scoreText.scale.setScalar(s))
    .start();
}

let scoreTween: Tween<{ s: number }> = new Tween({ s: 1 });

window.addEventListener("resize", () => {
  const w = parent.clientWidth, h = parent.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
});

animate(performance.now());
