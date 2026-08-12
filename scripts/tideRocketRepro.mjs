// Targeted reproduction of the "tide rockets to ~3× climb speed in the first
// jumps" bug. The camera deadzone and follow offset in the real game make the
// opening especially vicious: the player can climb fast without the camera
// actually moving for the first ~100 design px or so, which means the VIEW
// BOTTOM stays FIXED near the spawn point. In the old (281 cap) tuning, the
// chase term (gain 0.38, target just below view) then multiplied the huge
// gapBelowScreen from that first staircase burst and drove the tide speed
// straight into the 281 cap — well above any realistic bounce climb rate of
// ~90 design px/s, so it would overtake between bounces.
//
// This sim reproduces that camera-deadzone behavior explicitly: the camera
// REFUSES to follow until the player has climbed a fixed threshold.

const BASE_HEIGHT = 854;
const DT = 1 / 60;

const LEGACY_OLD = {
  label: 'OLD (legacy 281 cap, gain 0.38, NO real grace — chase allowed from t=0)',
  baseSpeed: 24,
  timeAccel: 0.6,
  targetBelow: -10,
  chaseGain: 0.38,
  maxSpeed: 281,
  graceMs: 0, // old legacy had essentially zero grace on chase
  graceMaxSpeed: 9999,
  startExtraPadding: 0,
  chaseInGrace: true,
};

const PREV_TUNING = {
  label: 'Previous tuning (135 cap, 3s grace=8, but chase STILL ENABLED during grace)',
  baseSpeed: 24,
  timeAccel: 0.6,
  targetBelow: -10,
  chaseGain: 0.38,
  maxSpeed: 135,
  graceMs: 3000,
  graceMaxSpeed: 8,
  startExtraPadding: 0,
  chaseInGrace: true, // <— THE BUG: chase was still computed, so rocket still builds
};

const NEW_CURRENT = {
  label: 'NEW (118 cap, grace=6, chase=0 DURING grace, +120 start padding)',
  baseSpeed: 22,
  timeAccel: 0.48,
  targetBelow: -20,
  chaseGain: 0.24,
  maxSpeed: 118,
  graceMs: 3000,
  graceMaxSpeed: 6,
  startExtraPadding: 120,
  chaseInGrace: false,
};

const TIDE_START_Y_FROM_TOP = BASE_HEIGHT + 230;
const CAMERA_DEADZONE_CLIMB_BEFORE_FOLLOW = 140; // design px climbed before camera starts to scroll
const CAMERA_FOLLOW_OFFSET_BELOW_PLAYER = BASE_HEIGHT * 0.58;
const TIME_CAP_BASE_AT = 80; // design px/s cap added over base (matches in-game Math.min(80, t*accel))

function run(cfg, scenario, durationSec = 10) {
  let tideY = TIDE_START_Y_FROM_TOP + cfg.startExtraPadding;
  let playerY = BASE_HEIGHT - 40;
  const spawnY = playerY;
  let camY = 0; // top of camera (scroll y). Smaller = higher / more scrolled up.
  let tideSpeed = cfg.baseSpeed;
  let tidePeakSpeed = 0;
  let narrowestMargin = Infinity;
  let minMarginAtT = 0;
  let peakGapBelowScreen = 0;
  let tideOvertakeT = null;
  let peakAtT = 0;

  for (let step = 0, t = 0; t <= durationSec; step++, t = +(step * DT).toFixed(4)) {
    const elapsed = t;
    const climbed = spawnY - playerY; // design px climbed so far
    // Camera: DEAD ZONE until CAMERA_DEADZONE_CLIMB_BEFORE_FOLLOW design px climbed.
    // Once it starts following, keep the player at the same follow offset.
    if (climbed > CAMERA_DEADZONE_CLIMB_BEFORE_FOLLOW) {
      camY = Math.min(camY, playerY - CAMERA_FOLLOW_OFFSET_BELOW_PLAYER);
    }
    const viewBottom = camY + BASE_HEIGHT;
    const gapBelowScreen = tideY - viewBottom;
    if (gapBelowScreen > peakGapBelowScreen) {
      peakGapBelowScreen = gapBelowScreen;
      peakAtT = t;
    }
    const inGrace = t * 1000 < cfg.graceMs;
    const timeAdd = cfg.timeAccel <= 0 ? 0 : Math.min(TIME_CAP_BASE_AT, elapsed * cfg.timeAccel);
    const baseRise = cfg.baseSpeed + timeAdd;
    const chaseRaw = cfg.chaseGain * Math.max(0, gapBelowScreen - cfg.targetBelow);
    const chase = inGrace && !cfg.chaseInGrace ? 0 : chaseRaw;
    tideSpeed = Math.min(cfg.maxSpeed, baseRise + chase);
    let effSpeed = tideSpeed;
    if (inGrace) effSpeed = Math.min(effSpeed, cfg.graceMaxSpeed);
    tideY -= effSpeed * DT;

    playerY -= scenario.climb(t, DT);

    tidePeakSpeed = Math.max(tidePeakSpeed, tideSpeed);
    const margin = tideY - playerY;
    if (margin < narrowestMargin) {
      narrowestMargin = margin;
      minMarginAtT = t;
    }
    if (tideOvertakeT === null && margin <= 0) tideOvertakeT = t;
  }

  console.log(`\n## ${cfg.label}`);
  console.log(`   peak tide speed (design px/s): ${tidePeakSpeed.toFixed(1)}  —  ratio to avg climb 92 px/s: ${(tidePeakSpeed / 92).toFixed(2)}×`);
  console.log(`   peak gapBelowScreen (design px below view bottom): ${peakGapBelowScreen.toFixed(0)} at t=${peakAtT.toFixed(2)} s`);
  console.log(`   narrowest tide→player margin (design px): ${narrowestMargin.toFixed(1)} at t=${minMarginAtT.toFixed(1)} s`);
  console.log(`   tide overtook player: ${tideOvertakeT === null ? 'never (over 10 s)' : 't=' + tideOvertakeT.toFixed(2) + ' s'}`);
  console.log(`   final tide→player margin (design px): ${(tideY - playerY).toFixed(1)}`);
}

// Burst profile: an opening staircase with bouncy-spring bounces. Climb rate
// is elevated until about t=3.5 s, then drops back to a realistic steady 92.
function openingSpringBurst() {
  return {
    climb(t, dt) {
      if (t < 0.8) return 132 * dt;
      if (t < 1.6) return 156 * dt;
      if (t < 2.4) return 148 * dt;
      if (t < 3.4) return 122 * dt;
      return 92 * dt;
    },
  };
}

console.log('# Repro: camera deadzone + opening springs staircase');
console.log('# Camera holds for first 140 design px climbed. Units: design pixels (480x854 baseline).\n');

const s = openingSpringBurst();
run(LEGACY_OLD, s, 10);
run(PREV_TUNING, s, 10);
run(NEW_CURRENT, s, 10);
