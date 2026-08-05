import { Howl, Howler } from 'howler';
import { getState } from './state';

let unlocked = false;
const sounds: Record<string, Howl> = {};
const resolveAudioPath = (relativePath: string) =>
  import.meta.env.PROD ? relativePath.split('/').pop() ?? relativePath : relativePath;

export function initAudio() {
  if (unlocked) return;
  // Relative paths (no leading '/') so SFX resolve whether the game is served
  // from the domain root (Vercel) or a subpath (GameMonetize CDN). Verify
  // currently 404s nested folders there, so use flat root file names.
  sounds.coin = new Howl({ src: [resolveAudioPath('sfx/coin.ogg')], volume: 0.5 });
  sounds.powerup = new Howl({ src: [resolveAudioPath('sfx/powerup.ogg')], volume: 0.6 });
  sounds.click = new Howl({ src: [resolveAudioPath('sfx/click.wav')], volume: 0.5 });
  sounds.jump = new Howl({ src: [resolveAudioPath('sfx/jump.ogg')], volume: 0.35 });
  sounds.gameover = new Howl({ src: [resolveAudioPath('sfx/gameover.wav')], volume: 0.5 });
  Howler.mute(getState().muted);
  unlocked = true;
}

export function playSfx(name: 'coin' | 'powerup' | 'click' | 'jump' | 'gameover') {
  if (!unlocked) return;
  const s = sounds[name];
  if (s) s.play();
}

export function setMuted(muted: boolean) {
  Howler.mute(muted);
}

export function gestureUnlock(scene: Phaser.Scene | any) {
  const unlock = () => {
    initAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}
