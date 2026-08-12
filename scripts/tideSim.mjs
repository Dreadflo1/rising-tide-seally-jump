// Numerical proof: OLD vs NEW tide model for Seally Jump.
// All values are in DESIGN PIXELS (original 480x854 authoring grid) to match
// how the constants are actually tuned. The game uses SCALE=2.25 internally
// for rendering, but the gameplay math runs in design units.
//
// Scenarios:
//   1. Steady climb (88 design px/s for 30 s) — survival margin over time.
//   2. Fast opening burst (springs / staircase, higher climb for the first
//      5 s, then steady) — reproduces the "rocket tide cap on stage 1".
//   3. Stall at 5 s then 15 s — make sure chase is still pressure, not a
//      rocket.

const BASE_HEIGHT = 854;
const DT = 1 / 60;

const OLD = {
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

const NEW = {
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

const TIDE_START_Y_FROM_TOP = BASE_HEIGHT + 230; // before padding

function run(name, cfg, scenario) {
  let tideY = TIDE_START_Y_FROM_TOP + cfg.startExtraPadding;
  let playerY = BASE_HEIGHT - 40; // spawning on the first platform (design px)
  let camY = 0; // camera top Y (scrolled up = more negative)
  let tideSpeed = cfg.baseSpeed;
  const timeCapTimeRamp = 80 / cfg.timeAccel; // when time saturates
  let tidePeakSpeed = 0;
  let narrowestMargin = Infinity;
  let minMarginAtT = 0;
  let tideEnteredViewAtT = null;

  for (let step = 0, t = 0; t <= 30; step++, t = +(step * DT).toFixed(4)) {
    const elapsed = t;
    const viewBottom = camY + BASE_HEIGHT;
    const gapBelowScreen = tideY - viewBottom; // design px below visible bottom
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

    const climb = scenario.climb(t, DT); // design px climbed this frame (player goes up = y decreases)
    playerY -= climb;

    // Camera follows: keep the player near the top. Approximation.
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
  }

  console.log(`\n## ${name}`);
  console.log(`   tide peak speed (design px/s): ${tidePeakSpeed.toFixed(1)}`);
  console.log(`   narrowest tide→player margin (design px): ${narrowestMargin.toFixed(1)} at t=${minMarginAtT.toFixed(1)} s`);
  console.log(`   tide entered visible view at t=${tideEnteredViewAtT === null ? '>30 s' : tideEnteredViewAtT.toFixed(1) + ' s'}`);
  console.log(`   final tide→player margin (design px): ${(tideY - playerY).toFixed(1)}`);
  console.log(`   final player altitude (design px climbed): ${(BASE_HEIGHT - 40 - playerY).toFixed(0)}`);
}

// --- Scenario generators ----------------------------------------------------

function steadyClimb(vDesignPxPerSec) {
  return { climb: (t, dt) => vDesignPxPerSec * dt };
}

function fastOpeningBurstThenSteady(burstV, burstSeconds, steadyV) {
  return {
    climb(t, dt) {
      return (t < burstSeconds ? burstV : steadyV) * dt;
    },
  };
}

function stallThenRecover(steadyV, stallAtSeconds, stallDurationSeconds, recoverV) {
  return {
    climb(t, dt) {
      if (t >= stallAtSeconds && t < stallAtSeconds + stallDurationSeconds) return 0;
      return (t < stallAtSeconds + stallDurationSeconds + 0.001 ? recoverV : steadyV) * dt;
    },
  };
}

console.log('# Tide model: OLD (cap 281, chase 0.38) vs NEW (cap 118, chase 0.24, grace, start padding)');
console.log('# Units: design pixels (480 x 854 authoring grid).');

console.log('\n### Scenario 1 — Steady climb (88 design px/s, 30 s)');
run('OLD · steady 88', OLD, steadyClimb(88));
run('NEW · steady 88', NEW, steadyClimb(88));

console.log('\n### Scenario 2 — Fast opening burst (140 design px/s first 5 s, then 90)');
run('OLD · opening burst 140→90', OLD, fastOpeningBurstThenSteady(140, 5, 90));
run('NEW · opening burst 140→90', NEW, fastOpeningBurstThenSteady(140, 5, 90));

console.log('\n### Scenario 3 — Steady 90 + STALL 1.2 s at t=5 s and t=15 s');
const stallBase = steadyClimb(90);
const stall1 = stallThenRecover(90, 5, 1.2, 90);
const stall2 = stallThenRecover(90, 15, 1.2, 90);
const combine = {
  climb(t, dt) {
    return stall2.climb(t, dt) || stall1.climb(t, dt) || stallBase.climb(t, dt);
  },
};
run('OLD · steady 90 + stalls', OLD, combine);
run('NEW · steady 90 + stalls', NEW, combine);
