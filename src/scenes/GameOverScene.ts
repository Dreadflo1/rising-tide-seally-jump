import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S, debugLog } from '../constants';
import { BadgeDef, MapDef, getState, registerShare, submitScoreGlobal, addCoins } from '../state';
import { playSfx } from '../audio';
import { showInterstitial, showRewardedAd, isRewardedReady } from '../ads';
import { shareTo, hasNativeShare, SharePlatform } from '../share';
import { buildShareButtons, getGameOverShareLayout } from '../gameOverShareLayout';

interface GameOverData {
  meters: number;
  coins: number;
  bankedCoins: number;
  newBadges: BadgeDef[];
  newMaps: MapDef[];
}

export default class GameOverScene extends Phaser.Scene {
  private data0!: GameOverData;

  constructor() {
    super('GameOverScene');
  }

  init(data: GameOverData) {
    this.data0 = data;
  }

  create() {
    const w = this.scale.width;
    const h = this.scale.height;
    const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif';
    const TITLE_WITH_EMOJI = `"Baloo 2","Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    this.add.rectangle(w / 2, h / 2, w, h, 0x052736);
    this.add.image(w / 2, h * 0.26, 'bg_storm').setDisplaySize(w, h * 0.6).setAlpha(0.5);

    this.add
      .text(w / 2, h * 0.09, 'THE TIDE GOT YOU!', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(24)}px`,
        color: '#ef476f',
        stroke: '#0b3d5c',
        strokeThickness: S(6),
      })
      .setOrigin(0.5);

    this.add.image(w / 2, h * 0.2, 'player_seal').setScale(S(0.22)).setAngle(20).setAlpha(0.9);

    const st = getState();
    const isNewBest = this.data0.meters >= st.highScoreMeters;

    this.add
      .text(
        w / 2,
        h * 0.31,
        `Height: ${this.data0.meters} m${isNewBest ? '  🏆 NEW BEST!' : ''}\nPearls collected: ${this.data0.coins} 🦪`,
        { fontFamily: FONT_BODY, fontSize: `${S(16)}px`, color: '#ffffff', align: 'center', lineSpacing: S(6) }
      )
      .setOrigin(0.5);

    // Global rank: submitted async so it never blocks this screen from
    // showing immediately. Silently stays blank if the durable leaderboard
    // isn't configured yet or the player is offline (see submitScoreGlobal).
    const globalRankText = this.add
      .text(w / 2, h * 0.36, '', {
        fontFamily: FONT_BODY,
        fontSize: `${S(12)}px`,
        color: '#9be7ff',
      })
      .setOrigin(0.5);
    let sceneClosed = false;
    this.events.once('shutdown', () => {
      sceneClosed = true;
    });
    submitScoreGlobal(st.username, this.data0.meters, st.selectedMap).then((result) => {
      if (sceneClosed || !result) return;
      const totalTxt = result.total ? ` of ${result.total}` : '';
      globalRankText.setText(`🌍 Global rank: #${result.rank}${totalTxt}`);
    });

    let y = h * 0.4;
    if (this.data0.newBadges.length > 0) {
      const badgeText = this.add
        .text(w / 2, y, `New medal${this.data0.newBadges.length > 1 ? 's' : ''}: ${this.data0.newBadges.map((b) => `${b.icon} ${b.name} +${b.reward}🦪`).join(', ')}`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(12)}px`,
          color: '#ffd166',
          align: 'center',
          wordWrap: { width: w - S(60) },
        })
        .setOrigin(0.5);
      y += badgeText.height + S(12);
    }
    if (this.data0.newMaps.length > 0) {
      const mapText = this.add
        .text(w / 2, y, `New map unlocked: ${this.data0.newMaps.map((m) => m.name).join(', ')}!`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(12)}px`,
          color: '#06d6a0',
          align: 'center',
          wordWrap: { width: w - S(60) },
        })
        .setOrigin(0.5);
      y += mapText.height + S(10);
    }

    // ---- Rewarded-ad offers: opt-in "watch an ad for a bonus" row. Only shown
    // when a rewarded ad is actually preloaded and ready — no point offering a
    // button that just says "no ad available". Placed before the share section
    // so everything below flows via the `y` cursor. ----
    if (isRewardedReady()) {
    this.add
      .text(w / 2, y + S(6), '🎬 WATCH AN AD FOR A BONUS', {
        fontFamily: TITLE_WITH_EMOJI,
        fontSize: `${S(13)}px`,
        color: '#ffd166',
      })
      .setOrigin(0.5);
    const rewardY = y + S(40);
    const rewardNote = this.add
      .text(w / 2, rewardY + S(34), '', {
        fontFamily: FONT_BODY,
        fontSize: `${S(11)}px`,
        color: '#c9f7d9',
        align: 'center',
        wordWrap: { width: w - S(60) },
      })
      .setOrigin(0.5);

    const makeRewardButton = (
      x: number,
      label: string,
      bg: string,
      onReward: () => void
    ) => {
      const btn = this.add
        .text(x, rewardY, label, {
          fontFamily: TITLE_WITH_EMOJI,
          fontSize: `${S(15)}px`,
          color: '#0b3d5c',
          backgroundColor: bg,
          padding: { x: S(14), y: S(9) },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        playSfx('click');
        rewardNote.setText('Loading ad…');
        showRewardedAd(
          this,
          onReward,
          () => rewardNote.setText('No ad available right now — try again in a bit.')
        );
      });
      return btn;
    };

    // Continue: revive the run at the same height (score/coins carried), using
    // GameScene's existing revive path.
    makeRewardButton(w / 2 - S(96), '❤️ Continue', '#06d6a0', () => {
      this.scene.start('GameScene', {
        revive: {
          meters: this.data0.meters,
          coins: this.data0.coins,
          bankedCoins: this.data0.bankedCoins,
        },
      });
    });

    // +10 pearls (once per game-over — disable after a successful grant).
    let pearlsBtn: Phaser.GameObjects.Text;
    pearlsBtn = makeRewardButton(w / 2 + S(96), '+10 🦪', '#ffd166', () => {
      addCoins(10);
      rewardNote.setText('+10 🦪 added to your pearls!');
      pearlsBtn.disableInteractive().setAlpha(0.5);
    });

      y = rewardY + S(70);
    }

    const shareLayout = getGameOverShareLayout({
      width: w,
      height: h,
      contentBottomY: y,
      buttonCount: buildShareButtons(hasNativeShare()).length,
    });

    // Share row: native "share anywhere" (mobile OS sheet lists TikTok/IG/FB/X
    // etc.) plus explicit per-platform buttons.
    this.add
      .text(w / 2, shareLayout.titleY, '📣 SHARE YOUR SCORE', {
        fontFamily: TITLE_WITH_EMOJI,
        fontSize: `${S(shareLayout.titleFontSize)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    const shareNote = this.add
      .text(w / 2, shareLayout.noteY, '', {
        fontFamily: FONT_BODY,
        fontSize: `${S(11)}px`,
        color: '#c9f7d9',
        align: 'center',
        wordWrap: { width: w - S(60) },
      })
      .setOrigin(0.5);

    let shareAwarded = false;
    const doShare = async (platform: SharePlatform) => {
      playSfx('click');
      const result = await shareTo(platform, this.data0.meters, st.username, window.location.href);
      if (result.ok && !shareAwarded) {
        registerShare(); // +25 pearls, once per game-over
        shareAwarded = true;
      }
      if (result.note) shareNote.setText(result.note);
    };

    const buttons: { emoji: string; p: SharePlatform }[] = buildShareButtons(hasNativeShare());
    buttons.forEach((b, i) => {
      const pos = shareLayout.buttonPositions[i];
      const btn = this.add
        .text(pos.x, pos.y + pos.offsetY, b.emoji, { fontFamily: EMOJI_FONT, fontSize: `${S(shareLayout.iconFontSize)}px` })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setScale(1.2));
      btn.on('pointerout', () => btn.setScale(1));
      btn.on('pointerdown', () => doShare(b.p));
    });

    // Single Play Again — always shows the interstitial ad, then restarts.
    const playAgain = this.add
      .text(w / 2, shareLayout.playAgainY, '▶ PLAY AGAIN', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(20)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(24), y: S(12) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    playAgain.on('pointerdown', () => {
      playSfx('click');
      debugLog('[verify-no-ad] GameOver PLAY AGAIN pressed');
      showInterstitial(this, () => this.scene.start('GameScene'));
    });

    const menuBtn = this.add
      .text(w / 2, shareLayout.menuY, 'MAIN MENU', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(14)}px`,
        color: '#ffffff',
        backgroundColor: '#124b6b',
        padding: { x: S(16), y: S(8) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    menuBtn.on('pointerdown', () => {
      playSfx('click');
      this.scene.start('TitleScene');
    });
  }
}
