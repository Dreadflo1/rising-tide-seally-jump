// The game is authored at a "design" resolution of 480x854 (the original
// portrait phone size). To render crisply on Full HD / Retina monitors we
// render the actual Phaser canvas at a much higher internal pixel
// resolution (SCALE x bigger) — this is the classic "supersample" trick:
// draw more real pixels, then let FIT scaling downscale for a sharp look
// instead of upscaling a tiny blurry buffer.
//
// Every gameplay constant (velocities, gaps, offsets, font sizes, sprite
// scales) must be multiplied by SCALE so the game *feels* identical to the
// original design — only sharper. Use the `S()` helper below everywhere a
// "design pixel" constant is used.

export const BASE_WIDTH = 480;
export const BASE_HEIGHT = 854;

export const SCALE = 2.25; // supersampling factor
export const WIDTH = Math.round(BASE_WIDTH * SCALE); // 1080
export const HEIGHT = Math.round(BASE_HEIGHT * SCALE); // 1922

/** Convert a "design pixel" (tuned against the 480x854 baseline) to a real render pixel. */
export function S(designPixels: number): number {
  return designPixels * SCALE;
}

export const COLORS = {
  bgDark: 0x073b4c,
  panel: 0x0b3d5c,
  accent: 0xffd166,
  accent2: 0x06d6a0,
  danger: 0xef476f,
  text: '#ffffff',
  gold: '#ffd166',
};

export const FONT_TITLE = '"Baloo 2", sans-serif';
export const FONT_BODY = '"Nunito", sans-serif';

// Opt-in diagnostic logger. Silent by default so the production / GameDistribution
// Verify console stays clean. Enable at runtime with `window.__SEAL_DEBUG__ = true`
// then reproduce. (Replaces the old always-on console.error('[debug ...]') calls,
// which rendered as a wall of red "errors" even though nothing was wrong.)
export function debugLog(...args: unknown[]): void {
  if ((globalThis as unknown as { __SEAL_DEBUG__?: boolean }).__SEAL_DEBUG__) {
    console.log(...args);
  }
}
