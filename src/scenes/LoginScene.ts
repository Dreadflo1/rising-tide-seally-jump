import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S, debugLog } from '../constants';
import { getSession, login, logout, listProfiles, guestName } from '../auth';
import { loadProfile } from '../state';
import { playSfx, gestureUnlock } from '../audio';

export default class LoginScene extends Phaser.Scene {
  private inputEl?: HTMLInputElement;

  constructor() {
    super('LoginScene');
  }

  create() {
    gestureUnlock(this);
    const w = this.scale.width;
    const h = this.scale.height;
    //#region debug-point verify-black-screen-login
    debugLog('[verify-black-screen] LoginScene.create start', { w, h });
    //#endregion debug-point verify-black-screen-login

    this.add.image(w / 2, h / 2, 'bg_lagoon').setDisplaySize(w, h).setTint(0xcdeeff);
    this.add.rectangle(w / 2, h / 2, w, h, 0x073b4c, 0.35);

    // Existing session -> auto continue after a short "welcome back" beat
    const existing = getSession();
    if (existing) {
      //#region debug-point verify-black-screen-login
      debugLog('[verify-black-screen] LoginScene existing session', existing.username);
      //#endregion debug-point verify-black-screen-login
      loadProfile(existing.profileId || existing.username, existing.username);
      this.showWelcomeBack(existing.username);
      return;
    }

    //#region debug-point verify-black-screen-login
    debugLog('[verify-black-screen] LoginScene buildLoginForm');
    //#endregion debug-point verify-black-screen-login
    this.buildLoginForm();
  }

  private showWelcomeBack(username: string) {
    const w = this.scale.width;
    const h = this.scale.height;
    this.add.image(w / 2, h * 0.34, 'player_seal').setScale(S(0.36));
    this.add
      .text(w / 2, h * 0.13, 'RISING TIDE', { fontFamily: FONT_TITLE, fontSize: `${S(38)}px`, color: '#ffffff', stroke: '#0b3d5c', strokeThickness: S(7) })
      .setOrigin(0.5);
    this.add
      .text(w / 2, h * 0.5, `Welcome back,\n${username}! 🦭`, {
        fontFamily: FONT_BODY,
        fontSize: `${S(20)}px`,
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);

    const cont = this.add
      .text(w / 2, h * 0.62, 'CONTINUE', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(20)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(26), y: S(12) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    cont.on('pointerdown', () => {
      playSfx('click');
      this.scene.start('TitleScene');
    });

    const switchBtn = this.add
      .text(w / 2, h * 0.62 + S(56), 'Not you? Switch account', {
        fontFamily: FONT_BODY,
        fontSize: `${S(13)}px`,
        color: '#9be7ff',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    switchBtn.on('pointerdown', () => {
      playSfx('click');
      logout();
      this.scene.restart();
    });
  }

  private buildLoginForm() {
    const w = this.scale.width;
    const h = this.scale.height;

    this.add
      .text(w / 2, h * 0.12, 'RISING TIDE', { fontFamily: FONT_TITLE, fontSize: `${S(38)}px`, color: '#ffffff', stroke: '#0b3d5c', strokeThickness: S(7) })
      .setOrigin(0.5);
    this.add
      .text(w / 2, h * 0.12 + S(38), 'SEAL JUMP', { fontFamily: FONT_TITLE, fontSize: `${S(24)}px`, color: '#ffd166', stroke: '#0b3d5c', strokeThickness: S(5) })
      .setOrigin(0.5);

    this.add.image(w / 2, h * 0.3, 'player_seal').setScale(S(0.3));

    this.add
      .text(w / 2, h * 0.42, 'Type a nickname to save your progress\n& join the leaderboard — or just play as a guest', {
        fontFamily: FONT_BODY,
        fontSize: `${S(13)}px`,
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);

    // DOM text input overlay positioned above the canvas (Phaser has no
    // native text input). This uses CSS pixels via getBoundingClientRect,
    // so it is independent of the internal canvas render resolution.
    const canvas = this.game.canvas;
    //#region debug-point verify-black-screen-login
    debugLog('[verify-black-screen] LoginScene canvas ready', Boolean(canvas));
    //#endregion debug-point verify-black-screen-login
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.placeholder = 'Type a nickname…';
    input.autocomplete = 'off';
    input.style.position = 'absolute';
    input.style.fontFamily = 'Nunito, sans-serif';
    input.style.textAlign = 'center';
    input.style.borderStyle = 'solid';
    input.style.borderColor = '#06d6a0';
    input.style.background = '#ffffff';
    input.style.outline = 'none';
    input.style.boxSizing = 'border-box';
    input.style.zIndex = '10';
    document.body.appendChild(input);
    //#region debug-point verify-black-screen-login
    debugLog('[verify-black-screen] LoginScene input appended');
    //#endregion debug-point verify-black-screen-login
    this.inputEl = input;

    // Everything (font, padding, size, position) scales with the on-screen
    // canvas so the field stays proportional and never overlaps the text above
    // it or the button below, at any screen size.
    const positionInput = () => {
      const r = canvas.getBoundingClientRect();
      const sr = r.width / w; // display px per render px
      const fieldW = 300; // render px
      const fieldH = 66; // render px
      input.style.fontSize = `${Math.round(30 * sr)}px`;
      input.style.padding = `0 ${Math.round(16 * sr)}px`;
      input.style.height = `${fieldH * sr}px`;
      input.style.width = `${fieldW * sr}px`;
      input.style.borderWidth = `${Math.max(1, 2 * sr)}px`;
      input.style.borderRadius = `${12 * sr}px`;
      // Centre the field horizontally, top edge at ~50% height (clear gap below
      // the instruction text at 42% and above the SAVE & PLAY button at 58%).
      input.style.left = `${r.left + (w / 2 - fieldW / 2) * sr}px`;
      input.style.top = `${r.top + h * 0.5 * sr}px`;
    };
    positionInput();
    const resizeHandler = () => positionInput();
    window.addEventListener('resize', resizeHandler);
    this.events.once('shutdown', () => {
      window.removeEventListener('resize', resizeHandler);
      input.remove();
    });

    const doLogin = () => {
      playSfx('click');
      const typed = input.value.trim();
      // Empty field falls back to a guest profile (flagged as such).
      const session = login(typed || guestName(), typed.length === 0);
      loadProfile(session.profileId, session.username);
      input.remove();
      this.scene.start('TitleScene');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });

    const loginBtn = this.add
      .text(w / 2, h * 0.58, 'SAVE & PLAY', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(18)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(20), y: S(12) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    loginBtn.on('pointerdown', doLogin);

    const guestBtn = this.add
      .text(w / 2, h * 0.58 + S(56), 'Continue as Guest', {
        fontFamily: FONT_BODY,
        fontSize: `${S(14)}px`,
        color: '#9be7ff',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    guestBtn.on('pointerdown', () => {
      playSfx('click');
      const session = login(guestName(), true);
      loadProfile(session.profileId, session.username);
      input.remove();
      this.scene.start('TitleScene');
    });

    const known = listProfiles();
    if (known.length > 0) {
      const recent = known.slice(-3).reverse();
      this.add
        .text(w / 2, h * 0.58 + S(96), `Recent: ${recent.join(', ')}`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(11)}px`,
          color: '#c9f7d9',
        })
        .setOrigin(0.5);
    }

    this.add
      .text(w / 2, h - S(20), 'No password needed — your seal name is your save file 🦭', {
        fontFamily: FONT_BODY,
        fontSize: `${S(10)}px`,
        color: '#c9f7d9',
      })
      .setOrigin(0.5);
  }
}
