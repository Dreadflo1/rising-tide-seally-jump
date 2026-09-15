// Dev-only live tuning panel. Mounts a floating ⚙ button + slider panel over the
// game so you can dial the game-feel by hand; values persist and apply live.
// Only mounts when tuningEnabled() (i.e. ?tune=1 or localhost) — players never see it.
// To remove for good: delete this file and the initTuningPanel() call in main.ts.

import { tuning, saveTuning, resetTuning, tuningEnabled, Tuning } from './tuning';

interface Knob {
  key: keyof Tuning;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}

const KNOBS: Knob[] = [
  { key: 'tideSpeed', label: 'Tide speed', min: 40, max: 160, step: 1, suffix: ' px/s' },
  { key: 'maxMetersBelow', label: 'Tide leash', min: 6, max: 25, step: 1, suffix: ' m' },
  { key: 'pearlSpacingM', label: 'Pearl every', min: 4, max: 40, step: 1, suffix: ' m' },
  { key: 'powerupSpacingM', label: 'Power-up every', min: 18, max: 120, step: 2, suffix: ' m' },
  { key: 'lifeSpacingM', label: 'Life every', min: 100, max: 800, step: 20, suffix: ' m' },
  { key: 'firstTrapM', label: 'First trap at', min: 0, max: 200, step: 5, suffix: ' m' },
  { key: 'trapRarity', label: 'Trap rarity', min: 0.5, max: 3, step: 0.1, suffix: '×' },
  { key: 'variety', label: 'Platform variety', min: 0.5, max: 2.5, step: 0.1, suffix: '×' },
];

export function initTuningPanel() {
  if (!tuningEnabled() || document.getElementById('tune-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'tune-fab';
  fab.textContent = '⚙';
  fab.title = 'Tuning panel';
  fab.style.cssText =
    'position:fixed;right:14px;bottom:14px;z-index:9999;width:44px;height:44px;border-radius:50%;border:none;' +
    'background:#0077b6;color:#fff;font-size:22px;line-height:44px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);';

  const panel = document.createElement('div');
  panel.id = 'tune-panel';
  panel.style.cssText =
    'position:fixed;right:14px;bottom:66px;z-index:9999;width:260px;max-height:78vh;overflow:auto;display:none;' +
    "background:#0e2233;color:#e8f2f8;border:1px solid #1d384c;border-radius:14px;padding:14px 14px 12px;" +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.45);";

  const rowsHtml = KNOBS.map(
    (k) => `
    <label style="display:block;margin:0 0 11px;">
      <span style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:3px;">
        <span>${k.label}</span><span id="tv-${k.key}" style="color:#4db2ea;font-variant-numeric:tabular-nums;"></span>
      </span>
      <input type="range" id="tk-${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" style="width:100%;accent-color:#0077b6;">
    </label>`
  ).join('');

  panel.innerHTML =
    '<div style="font-size:13px;font-weight:800;letter-spacing:.04em;margin-bottom:4px;">GAME-FEEL TUNING</div>' +
    '<div style="font-size:11px;color:#7f9cb0;margin-bottom:12px;line-height:1.4;">Changes apply live as you climb. Tide effects show up high — play a real run to feel them.</div>' +
    rowsHtml +
    '<div style="display:flex;gap:8px;margin-top:6px;">' +
    '<button id="tune-copy" style="flex:1;padding:8px;border:none;border-radius:9px;background:#0f9d8c;color:#fff;font-weight:700;font-size:12.5px;cursor:pointer;">Copy values</button>' +
    '<button id="tune-reset" style="flex:none;padding:8px 12px;border:1px solid #1d384c;border-radius:9px;background:transparent;color:#a9c4d6;font-weight:700;font-size:12.5px;cursor:pointer;">Reset</button>' +
    '</div>' +
    '<div id="tune-msg" style="font-size:11px;color:#7f9cb0;min-height:15px;margin-top:8px;text-align:center;"></div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const fmt = (k: Knob) => {
    const v = tuning[k.key];
    const shown = k.step < 1 ? v.toFixed(1) : String(Math.round(v));
    const el = document.getElementById('tv-' + k.key);
    if (el) el.textContent = shown + (k.suffix || '');
  };
  const syncInputs = () => {
    for (const k of KNOBS) {
      const input = document.getElementById('tk-' + k.key) as HTMLInputElement | null;
      if (input) input.value = String(tuning[k.key]);
      fmt(k);
    }
  };

  for (const k of KNOBS) {
    const input = document.getElementById('tk-' + k.key) as HTMLInputElement | null;
    input?.addEventListener('input', () => {
      (tuning[k.key] as number) = parseFloat(input.value);
      fmt(k);
      saveTuning();
    });
  }
  syncInputs();

  fab.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('tune-reset')?.addEventListener('click', () => {
    resetTuning();
    syncInputs();
    msg('Reset to defaults');
  });

  document.getElementById('tune-copy')?.addEventListener('click', () => {
    const summary = KNOBS.map((k) => `${k.label}: ${tuning[k.key]}${k.suffix || ''}`).join('\n');
    const text = 'Seally tuning:\n' + summary;
    navigator.clipboard?.writeText(text).then(
      () => msg('Copied — paste it to me'),
      () => msg(text)
    );
  });

  function msg(t: string) {
    const el = document.getElementById('tune-msg');
    if (el) el.textContent = t;
  }
}
