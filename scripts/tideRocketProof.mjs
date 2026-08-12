// Numerical proof: OLD vs NEW tide model for Seally Jump — reproduction of the
// ORIGINAL worst-case "rocket tide" (old TIDE_MAX_SPEED=281, which was the
// problematic legacy cap; the NEW current cap is 118). This sim intentionally
// uses a 281-peak OLD config to match the "3× climb overtakes between bounces"
// bug described in the fix.
//
// All values are in DESIGN PIXELS (original 480x854 authoring grid).

const BASE_HEIGHT = 854;
const DT = 1 / 60;

const LEGACY_OLD = {
  label: 'OLD (legacy cap 281, chase 0.38)',
  baseSpeed: 24,
  timeAccel: 0.6,
  targetBelow: -10,
  chaseGain: 0.38,
  maxSpeed: 281,
  graceMs: 3000,
  graceMaxSpeed: 8,
  startExtraPadding: 0,
  chaseInGrace: true,
};

const NEW_CURRENT = {
  label: 'NEW (cap 118, chase 0.24, grace, +120 padding)',
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

function run(cfg, scenario, durationSec = 30) {
  let tideY = TIDE_START_Y_FROM_TOP + cfg.startExtraPadding;
  let playerY = BASE_HEIGHT - 40;
  let camY = 0;
  let tideSpeed = cfg.baseSpeed;
  let tidePeakSpeed = 0;
  let narrowestMargin = Infinity;
  let minMarginAtT = 0;
  let tideEnteredViewAtT = null;
  let tideOvertook = null;

  for (let step = 0, t = 0; t <= durationSec; step++, t = +(step * DT).toFixed(4)) {
    const elapsed = t;
    const viewBottom = camY + BASE_HEIGHT;
    const gapBelowScreen = tideY - viewBottom;
    const inGrace = t * 1000 < cfg.graceMs;
    const baseRise = cfg.baseSpeed + Math.min(80, elapsed * cfg.timeAccel);
    const chase =
      inGrace && !cfg.chaseInGrace
        ? 0
        : cfg.chaseGain * Math.max(0, gapBelowScreen - cfg.targetBelow);
    tideSpeed = Math.min(cfg.maxSpeed, baseRise + chase);
    let effSpeed = tideSpeed;
    if (inGrace) effSpeed = Math.min(effSpeed, cfg.graceMaxSpeed);
    tideY -= effSpeed * DT;

    const climb = scenario.climb(t, DT);
    playerY -= climb;

    const desiredCamTop = playerY - BASE_HEIGHT * 0.58;
    camY = Math.min(camY, desiredCamTop);

    tidePeakSpeed = Math.max(tidePeakSpeed, tideSpeed);
    const margin = tideY - playerY;
    if (margin < narrowestMargin) {
      narrowestMargin = margin;
      minMarginAtT = t;
    }
    if (tideEnteredViewAtT === null && gapBelowScreen <= 0) {
      tideEnteredViewAtT = t;
    }
    if (tideOvertook === null && margin <= 0) {
      tideOvertook = t;
    }
  }

  console.log(`\n## ${cfg.label}`);
  console.log(`   peak tide speed (design px/s): ${tidePeakSpeed.toFixed(1)}`);
  console.log(`   narrowest tide→player margin (design px): ${narrowestMargin.toFixed(1)} at t=${minMarginAtT.toFixed(1)} s`);
  console.log(`   tide entered visible view at t=${tideEnteredViewAtT === null ? '>30 s' : tideEnteredViewAtT.toFixed(1) + ' s'}`);
  console.log(`   tide overtook player (margin≤0): ${tideOvertook === null ? 'never (over 30 s)' : 't=' + tideOvertook.toFixed(2) + ' s'}`);
  console.log(`   final tide→player margin (design px): ${(tideY - playerY).toFixed(1)}`);
}

function rocketOpeningBurst(peakClimb, burstSeconds, thenClimb) {
  // Player on an opening staircase / bouncy springs: climbs HARD the first
  // 3 seconds, which in the legacy config pulled the tide behind the camera
  // bottom hard enough to chase up to 281 and overtake.
  return {
    climb(t, dt) {
      // quadratic falloff so it looks like a real burst, not a step
      if (t < burstSeconds) {
        const u = t / burstSeconds;
        const ease = 1 - u * u;
        const v = thenClimb + (peakClimb - thenClimb) * ease;
        return v * dt;
      }
      return thenClimb * dt;
    },
  };
}

console.log('# Tide bug reproduction: OLD (281 cap) vs NEW (118 cap)');
console.log('# Scenario = opening burst that reaches 150 design px/s, simulating a bouncy staircase start');
console.log('# Player avg climb ~ 92 px/s after the burst. Climb units: design pixels.');

const s = rocketOpeningBurst(150, 3.2, 92);

console.log('\n--- Scenario A: 30 s run ---');
run(LEGACY_OLD, s, 30);
run(NEW_CURRENT, s, 30);

console.log('\n--- Scenario B: 10 s run (focus on the opening burst + between-bounces overtaking) ---');
run(LEGACY_OLD, s, 10);
run(NEW_CURRENT, s, 10);
