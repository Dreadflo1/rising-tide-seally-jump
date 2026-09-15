import Phaser from 'phaser';
import { S, debugLog } from '../constants';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    const w = this.scale.width;
    const h = this.scale.height;
    const useFlatRuntimeAssets = import.meta.env.PROD;
    const resolveAssetPath = (relativePath: string) =>
      useFlatRuntimeAssets ? relativePath.split('/').pop() ?? relativePath : relativePath;
    //#region debug-point verify-black-screen-boot
    debugLog('[verify-black-screen] BootScene.preload start', { w, h });
    //#endregion debug-point verify-black-screen-boot
    const barBg = this.add.rectangle(w / 2, h / 2, S(220), S(18), 0x0a2436).setStrokeStyle(S(2), 0x2a6f7f);
    const bar = this.add.rectangle(w / 2 - S(105), h / 2, 0, S(12), 0x06d6a0).setOrigin(0, 0.5);
    const label = this.add
      .text(w / 2, h / 2 - S(30), 'Loading the lagoon...', {
        fontFamily: 'sans-serif',
        fontSize: `${S(14)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.load.on('progress', (v: number) => {
      bar.width = S(210) * v;
    });
    this.load.on('complete', () => {
      //#region debug-point verify-black-screen-boot
      debugLog('[verify-black-screen] BootScene.preload complete');
      //#endregion debug-point verify-black-screen-boot
      barBg.destroy();
      bar.destroy();
      label.destroy();
    });
    // Individual asset 404s/timeouts don't stop the loader (Phaser just
    // skips the failed file and keeps going), so without this the failure
    // is silent and shows up later as an invisible sprite. Logging it here
    // makes broken asset paths easy to spot in production.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      console.error('[seal-jump] asset failed to load:', file.key, file.src);
    });

    // Sprites. Paths are RELATIVE (no leading '/') so they resolve against the
    // document base — works both at the domain root (Vercel) and when the game
    // is served from a subpath on GameMonetize's CDN. Verify currently serves
    // root files correctly but 404s nested folders, so flatten there.
    this.load.image('player_seal', resolveAssetPath('sprites/player_seal.png'));
    this.load.image('seal_skin_gold', resolveAssetPath('sprites/seal_skin_gold.png'));
    this.load.image('seal_skin_violet', resolveAssetPath('sprites/seal_skin_violet.png'));
    this.load.image('seal_skin_kelp', resolveAssetPath('sprites/seal_skin_kelp.png'));
    this.load.image('seal_skin_hawaii', resolveAssetPath('sprites/seal_skin_hawaii.png'));
    this.load.image('platform_normal', resolveAssetPath('sprites/platform_normal.png'));
    this.load.image('platform_move', resolveAssetPath('sprites/platform_move.png'));
    this.load.image('platform_break', resolveAssetPath('sprites/platform_break.png'));
    this.load.image('platform_spring', resolveAssetPath('sprites/platform_spring.png'));
    this.load.image('coin_pearl', resolveAssetPath('sprites/coin_pearl.png'));
    this.load.image('powerup_dolphin', resolveAssetPath('sprites/powerup_dolphin.png'));
    this.load.image('powerup_law', resolveAssetPath('sprites/powerup_law.png'));
    this.load.image('powerup_shield', resolveAssetPath('sprites/powerup_shield.png'));
    this.load.image('bubble_particle', resolveAssetPath('sprites/bubble_particle.png'));
    this.load.image('trash_hazard', resolveAssetPath('sprites/trash_hazard.png'));

    // Social share icons (used on the Game Over "Share your score" row).
    this.load.image('soc_x', resolveAssetPath('social/x.png'));
    this.load.image('soc_facebook', resolveAssetPath('social/facebook.png'));
    this.load.image('soc_whatsapp', resolveAssetPath('social/whatsapp.png'));
    this.load.image('soc_instagram', resolveAssetPath('social/instagram.png'));
    this.load.image('soc_tiktok', resolveAssetPath('social/tiktok.png'));

    // Backgrounds
    this.load.image('bg_lagoon', resolveAssetPath('backgrounds/bg_lagoon.png'));
    this.load.image('bg_reef', resolveAssetPath('backgrounds/bg_reef.png'));
    this.load.image('bg_storm', resolveAssetPath('backgrounds/bg_storm.png'));
  }

  create() {
    //#region debug-point verify-black-screen-boot
    debugLog('[verify-black-screen] BootScene.create start');
    //#endregion debug-point verify-black-screen-boot
    // Self-hosted fonts (see @font-face in style.css) — no external CDN call.
    // Preload the exact weights the game renders, then continue once they're
    // ready, with a safety timeout so a slow/failed font never blocks the game
    // (Phaser simply falls back to sans-serif if a face isn't ready).
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      //#region debug-point verify-black-screen-boot
      debugLog('[verify-black-screen] BootScene -> LoginScene');
      //#endregion debug-point verify-black-screen-boot
      this.scene.start('LoginScene');
    };
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.load) {
      Promise.all([
        fonts.load('700 24px "Baloo 2"'),
        fonts.load('400 24px "Nunito"'),
        fonts.load('700 24px "Nunito"'),
        fonts.load('800 24px "Nunito"'),
      ])
        .then(() => {
          //#region debug-point verify-black-screen-boot
          debugLog('[verify-black-screen] font load resolved');
          //#endregion debug-point verify-black-screen-boot
          go();
        })
        .catch(() => {
          //#region debug-point verify-black-screen-boot
          debugLog('[verify-black-screen] font load rejected');
          //#endregion debug-point verify-black-screen-boot
          go();
        });
    } else {
      //#region debug-point verify-black-screen-boot
      debugLog('[verify-black-screen] FontFaceSet.load unavailable');
      //#endregion debug-point verify-black-screen-boot
      go();
    }
    // Safety net in case the Font Loading API stalls or is unavailable.
    this.time.delayedCall(2500, go);
  }
}
