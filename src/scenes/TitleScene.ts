import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S, debugLog } from '../constants';
import { getState, toggleMute, getLeaderboard, fetchGlobalLeaderboard, claimDailyReward, DailyRewardResult, MAPS } from '../state';
import { gestureUnlock, playSfx, setMuted } from '../audio';
import { logout, getSession } from '../auth';
import { showInterstitial } from '../ads';
import { shouldShowInterstitialOnTitlePlay } from '../adPolicy';

export default class TitleScene extends Phaser.Scene {
  constructor() {
    super('TitleScene');
  }

  create() {
    gestureUnlock(this);
    const w = this.scale.width;
    const h = this.scale.height;

    const bg = this.add.image(w / 2, h / 2, 'bg_lagoon').setDisplaySize(w, h);
    bg.setTint(0xdff5ff);

    // Floating decorative seal
    const seal = this.add.image(w / 2, h * 0.32, 'player_seal').setScale(S(0.42));
    this.tweens.add({
      targets: seal,
      y: h * 0.32 - S(22),
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });

    this.add
      .text(w / 2, h * 0.13, 'RISING TIDE', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(46)}px`,
        color: '#ffffff',
        stroke: '#0b3d5c',
        strokeThickness: S(8),
      })
      .setOrigin(0.5);
    this.add
      .text(w / 2, h * 0.13 + S(42), 'SEALLY JUMP', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(30)}px`,
        color: '#ffd166',
        stroke: '#0b3d5c',
        strokeThickness: S(6),
      })
      .setOrigin(0.5);

    const st = getState();

    // Logged-in profile badge (top-left)
    const profileTag = this.add
      .text(S(14), S(20), `🦭 ${st.username}`, {
        fontFamily: FONT_BODY,
        fontSize: `${S(13)}px`,
        color: '#ffffff',
        backgroundColor: '#0b3d5c',
        padding: { x: S(10), y: S(6) },
      })
      .setInteractive({ useHandCursor: true });
    profileTag.on('pointerdown', () => {
      playSfx('click');
      this.confirmLogout();
    });

    // Top achievements — best height, pearls and trash collected — as tappable
    // pills. Height jumps to the leaderboard; pearls and trash open the shop
    // (trash is the ♻️ currency spent on skins).
    const pills = [
      this.makeStatPill(`🏔️ ${st.highScoreMeters} m`, 0x118ab2, () => this.showLeaderboard()),
      this.makeStatPill(`🦪 ${st.totalCoins}`, 0x1a5b7a, () => this.scene.start('ShopScene')),
      this.makeStatPill(`♻️ ${st.trashCleaned}`, 0x0b7a5c, () => this.scene.start('ShopScene')),
    ];
    const pillGap = S(10);
    const pillsTotalW = pills.reduce((sum, p) => sum + p.width, 0) + pillGap * (pills.length - 1);
    let pillX = w / 2 - pillsTotalW / 2;
    pills.forEach((p) => {
      p.setPosition(pillX + p.width / 2, h * 0.5);
      pillX += p.width + pillGap;
    });

    const startGame = () => {
      this.cameras.main.fadeOut(250, 8, 30, 50);
      this.cameras.main.once('camerafadeoutcomplete', () => this.scene.start('GameScene'));
    };
    const playBtn = this.makeButton(w / 2, h * 0.62, 'PLAY', '#06d6a0', () => {
      playSfx('click');
      const shouldShowAd = shouldShowInterstitialOnTitlePlay({
        hasRealAdSdk: Boolean(window.GD_OPTIONS?.gameId && window.GD_OPTIONS.gameId !== 'YOUR_GAMEDISTRIBUTION_ID'),
        playedThisSession: Boolean(this.registry.get('playedThisSession')),
      });
      debugLog('[verify-no-ad] Title PLAY pressed', {
        playedThisSession: Boolean(this.registry.get('playedThisSession')),
        hasGameId: Boolean(window.GD_OPTIONS?.gameId && window.GD_OPTIONS.gameId !== 'YOUR_GAMEDISTRIBUTION_ID'),
        shouldShowAd,
      });
      // First ever play in a session stays free. Any trip back to the menu and
      // then PLAY again must show the interstitial.
      if (shouldShowAd) {
        showInterstitial(this, startGame);
      } else {
        debugLog('[verify-no-ad] Title PLAY starting game without ad');
        startGame();
      }
    });
    this.tweens.add({ targets: playBtn, scale: playBtn.scale * 1.06, duration: 500, yoyo: true, repeat: -1, ease: 'sine.inOut' });

    this.makeButton(w / 2, h * 0.62 + S(66), 'SHOP & COLLECTION', '#ffd166', () => {
      playSfx('click');
      this.scene.start('ShopScene');
    }, 16, '#0b3d5c');

    this.makeButton(w / 2, h * 0.62 + S(122), 'HOW TO PLAY', '#118ab2', () => {
      playSfx('click');
      this.showHelp();
    }, 15);

    this.makeButton(w / 2, h * 0.62 + S(178), '🏆 LEADERBOARD', '#9be7ff', () => {
      playSfx('click');
      this.showLeaderboard();
    }, 14, '#0b3d5c');

    // Mute toggle
    const muteBtn = this.add
      .text(w - S(24), S(24), st.muted ? '🔇' : '🔊', { fontSize: `${S(22)}px` })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    muteBtn.on('pointerdown', () => {
      const muted = toggleMute();
      setMuted(muted);
      muteBtn.setText(muted ? '🔇' : '🔊');
    });

    this.add
      .text(w / 2, h - S(20), '20% of revenue supports The Ocean Cleanup 💙', {
        fontFamily: FONT_BODY,
        fontSize: `${S(10)}px`,
        color: '#c9f7d9',
      })
      .setOrigin(0.5, 1);
    this.add
      .text(w / 2, h - S(5), '"Seally the Seal Jump Jumper" © Greenback LLC', {
        fontFamily: FONT_BODY,
        fontSize: `${S(9)}px`,
        color: '#7fa8bd',
      })
      .setOrigin(0.5, 1);

    // Daily-return bonus: only for signed-in (named) players — the streak is
    // a returning-player reward, and guests get a fresh random identity each
    // session, so granting it to them just spams the bonus every visit. Named
    // accounts: idempotent per calendar day (safe to call on every load).
    if (!getSession()?.isGuest) {
      const daily = claimDailyReward();
      if (daily.granted) {
        this.time.delayedCall(500, () => this.showDailyReward(daily));
      }
    }

    this.setupInstallButton(w, h);
  }

  // PWA install affordance. Only shown when the game is NOT already installed and
  // is actually installable: Android/Chrome once the beforeinstallprompt fired
  // (captured in main.ts), or iOS Safari (which has no prompt → show a manual
  // "Add to Home Screen" hint).
  private setupInstallButton(w: number, h: number) {
    const nav = navigator as Navigator & { standalone?: boolean };
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
    if (isStandalone) return; // already installed — nothing to offer
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!window.__sealInstallPrompt && !isIOS) return; // not installable here

    const btn = this.add
      .text(w / 2, h - S(54), '📲 INSTALL APP', {
        fontFamily: `"Baloo 2","Segoe UI Emoji","Apple Color Emoji",sans-serif`,
        fontSize: `${S(12)}px`,
        color: '#0b3d5c',
        backgroundColor: '#9be7ff',
        padding: { x: S(14), y: S(7) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerdown', async () => {
      playSfx('click');
      const prompt = window.__sealInstallPrompt;
      if (prompt) {
        window.__sealInstallPrompt = undefined;
        try {
          await prompt.prompt();
          await prompt.userChoice;
        } catch {
          /* user dismissed */
        }
        btn.destroy();
      } else if (isIOS) {
        this.showIOSInstallHint();
      }
    });
  }

  private showIOSInstallHint() {
    const w = this.scale.width;
    const h = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(3000);
    const scrim = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.55).setInteractive();
    const panel = this.add.rectangle(w / 2, h / 2, w * 0.82, h * 0.26, 0x0b3d5c, 0.99).setStrokeStyle(S(3), 0x9be7ff);
    const txt = this.add
      .text(w / 2, h / 2 - S(14), 'Install on iPhone/iPad:\nTap the Share button ⬆️,\nthen “Add to Home Screen”.', {
        fontFamily: FONT_BODY,
        fontSize: `${S(14)}px`,
        color: '#ffffff',
        align: 'center',
        lineSpacing: S(6),
      })
      .setOrigin(0.5);
    const tip = this.add
      .text(w / 2, h / 2 + S(66), 'Tap anywhere to close', {
        fontFamily: FONT_BODY,
        fontSize: `${S(11)}px`,
        color: '#9be7ff',
      })
      .setOrigin(0.5);
    overlay.add([scrim, panel, txt, tip]);
    scrim.on('pointerdown', () => overlay.destroy());
  }

  private showDailyReward(result: DailyRewardResult) {
    const w = this.scale.width;
    const h = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(2500);
    const bg = this.add.rectangle(w / 2, h / 2, w * 0.78, h * 0.36, 0x0b3d5c, 0.98).setStrokeStyle(S(3), 0x06d6a0);
    const title = this.add
      .text(w / 2, h * 0.42, `🎁 Day ${result.streak} streak!`, {
        fontFamily: FONT_TITLE,
        fontSize: `${S(20)}px`,
        color: '#ffd166',
      })
      .setOrigin(0.5);
    const body = this.add
      .text(w / 2, h * 0.5, `Welcome back! +${result.reward} 🦪 for returning today.\nCome back tomorrow to keep the streak going!`, {
        fontFamily: FONT_BODY,
        fontSize: `${S(13)}px`,
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: w * 0.66 },
      })
      .setOrigin(0.5);
    const claim = this.add
      .text(w / 2, h * 0.6, 'CLAIM', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(17)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(22), y: S(9) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    claim.on('pointerdown', () => {
      playSfx('click');
      overlay.destroy();
      // Refresh the pearls total shown on-screen now that the bonus landed.
      this.scene.restart();
    });
    overlay.add([bg, title, body, claim]);
  }

  private makeButton(
    x: number,
    y: number,
    label: string,
    color: string,
    onClick: () => void,
    fontSize = 20,
    textColor = '#ffffff'
  ) {
    const btn = this.add
      .text(x, y, label, {
        fontFamily: FONT_TITLE,
        fontSize: `${S(fontSize)}px`,
        color: textColor,
        backgroundColor: color,
        padding: { x: S(26), y: S(12) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const baseScale = 1;
    btn.on('pointerover', () => btn.setScale(baseScale * 1.04));
    btn.on('pointerout', () => btn.setScale(baseScale));
    btn.on('pointerdown', onClick);
    return btn;
  }

  /** A rounded "achievement" pill: icon + value on a coloured, tappable badge.
   *  Created at the origin — the caller positions it once widths are known. */
  private makeStatPill(text: string, bg: number, onTap: () => void): Phaser.GameObjects.Container {
    const emojiFont = '"Nunito","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    const label = this.add
      .text(0, 0, text, { fontFamily: emojiFont, fontSize: `${S(15)}px`, color: '#ffffff' })
      .setOrigin(0.5);
    const pw = label.width + S(30);
    const ph = label.height + S(16);
    const g = this.add.graphics();
    g.fillStyle(bg, 0.94);
    g.fillRoundedRect(-pw / 2, -ph / 2, pw, ph, S(13));
    g.lineStyle(S(1.5), 0xffffff, 0.3);
    g.strokeRoundedRect(-pw / 2, -ph / 2, pw, ph, S(13));
    const pill = this.add.container(0, 0, [g, label]);
    pill.setSize(pw, ph);
    pill.setInteractive({ useHandCursor: true });
    pill.on('pointerover', () => pill.setScale(1.05));
    pill.on('pointerout', () => pill.setScale(1));
    pill.on('pointerdown', () => {
      playSfx('click');
      onTap();
    });
    return pill;
  }

  private showHelp() {
    const w = this.scale.width;
    const h = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(2000);
    const bg = this.add.rectangle(w / 2, h / 2, w * 0.88, h * 0.68, 0x0b3d5c, 0.97).setStrokeStyle(S(3), 0xffd166);
    const title = this.add
      .text(w / 2, h * 0.21, '🦭 How To Play', { fontFamily: FONT_TITLE, fontSize: `${S(22)}px`, color: '#ffd166' })
      .setOrigin(0.5);
    const emojiFont = '"Nunito","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    const body = this.add
      .text(
        w / 2,
        h * 0.5,
        '• Tilt / arrow keys / drag to move left-right\n' +
          '• Bounce on platforms to climb — every 100m is a new Level\n' +
          '• The tide below is RISING — never stop!\n' +
          '• Collect pearls 🦪 & earn medals as you climb\n' +
          '• ♻️ Scoop floating trash — spend it on skins & launch a 🚢 cleanup boat\n' +
          '• 🐬 Dolphin push = speed boost + invulnerable\n' +
          '• 🐢 Turtle Shield = survive one hit\n' +
          '• 🛢️ Oil slicks make you slip for a few seconds\n' +
          '• 🪨 Poachers hurl rocks from off-screen — dodge sideways!',
        {
          fontFamily: emojiFont,
          fontSize: `${S(13)}px`,
          color: '#ffffff',
          align: 'left',
          lineSpacing: S(9),
          wordWrap: { width: w * 0.88 - S(40) },
        }
      )
      .setOrigin(0.5);
    const close = this.add
      .text(w / 2, h * 0.76, 'GOT IT', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(18)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(20), y: S(8) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    close.on('pointerdown', () => overlay.destroy());
    overlay.add([bg, title, body, close]);
  }

  private showLeaderboard() {
    const w = this.scale.width;
    const h = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(2000);
    const bg = this.add.rectangle(w / 2, h / 2, w * 0.86, h * 0.66, 0x0b3d5c, 0.97).setStrokeStyle(S(3), 0xffd166);
    const title = this.add
      .text(w / 2, h * 0.2, '🏆 Top Climbers', { fontFamily: FONT_TITLE, fontSize: `${S(22)}px`, color: '#ffd166' })
      .setOrigin(0.5);

    const formatLines = (entries: { username: string; meters: number }[]) =>
      entries.length > 0
        ? entries
            .slice(0, 8)
            .map((e, i) => `${i + 1}. ${e.username} — ${e.meters}m`)
            .join('\n')
        : 'No runs yet — be the first!';

    // Show the local cache immediately (instant, never blank), then swap in
    // the real global board once it resolves. Falls back to staying on the
    // local list if the durable leaderboard isn't reachable.
    const body = this.add
      .text(w / 2, h * 0.44, formatLines(getLeaderboard()), {
        fontFamily: FONT_BODY,
        fontSize: `${S(14)}px`,
        color: '#ffffff',
        align: 'left',
        lineSpacing: S(10),
      })
      .setOrigin(0.5);

    const sourceTag = this.add
      .text(w / 2, h * 0.66, 'Loading global ranking...', {
        fontFamily: FONT_BODY,
        fontSize: `${S(10)}px`,
        color: '#7fdfff',
      })
      .setOrigin(0.5);

    let closed = false;
    const st = getState();
    const mapName = (MAPS.find((m) => m.id === st.selectedMap) ?? MAPS[0]).name;
    fetchGlobalLeaderboard(st.username, 50, st.selectedMap).then((result) => {
      if (closed) return;
      body.setText(formatLines(result.top));
      if (result.source === 'global') {
        const meTxt = result.me ? ` · You: #${result.me.rank}${result.me.total ? ` of ${result.me.total}` : ''}` : '';
        sourceTag.setText(`🌍 ${mapName} leaderboard${meTxt}`);
      } else {
        sourceTag.setText('📴 Showing local scores — global board unavailable right now');
      }
    });

    const close = this.add
      .text(w / 2, h * 0.78, 'CLOSE', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(18)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(20), y: S(8) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    close.on('pointerdown', () => {
      closed = true;
      overlay.destroy();
    });
    overlay.add([bg, title, body, sourceTag, close]);
  }

  private confirmLogout() {
    const w = this.scale.width;
    const h = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(2000);
    const bg = this.add.rectangle(w / 2, h / 2, w * 0.8, h * 0.3, 0x0b3d5c, 0.97).setStrokeStyle(S(3), 0xef476f);
    const st = getState();
    const msg = this.add
      .text(w / 2, h * 0.42, `Signed in as ${st.username}\nSwitch account?`, {
        fontFamily: FONT_BODY,
        fontSize: `${S(15)}px`,
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);
    const switchBtn = this.add
      .text(w / 2 - S(60), h * 0.5, 'Switch', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(15)}px`,
        color: '#0b3d5c',
        backgroundColor: '#ef476f',
        padding: { x: S(14), y: S(8) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    switchBtn.on('pointerdown', () => {
      playSfx('click');
      logout();
      this.scene.start('LoginScene');
    });
    const cancelBtn = this.add
      .text(w / 2 + S(60), h * 0.5, 'Cancel', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(15)}px`,
        color: '#0b3d5c',
        backgroundColor: '#ffd166',
        padding: { x: S(14), y: S(8) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerdown', () => overlay.destroy());
    overlay.add([bg, msg, switchBtn, cancelBtn]);
  }
}
