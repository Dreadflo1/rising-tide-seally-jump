import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S, debugLog } from '../constants';
import { BadgeDef, MapDef, getState, registerShare, submitScoreGlobal, addCoins } from '../state';
import { playSfx } from '../audio';
import { showInterstitial, showRewardedAd, isRewardedReady } from '../ads';
import { shareTo, hasNativeShare, SharePlatform, SHARE_URL } from '../share';
import { buildShareButtons } from '../gameOverShareLayout';

interface GameOverData {
  meters: number;
  coins: number;
  bankedCoins: number;
  newBadges: BadgeDef[];
  newMaps: MapDef[];
  adRevived?: boolean; // an ad-revive was already used this run → don't offer another
  trashCleaned?: number; // run highlight: ocean trash collected this run
  boats?: number; // run highlight: cleanup boats triggered this run
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
    const cx = w / 2;

    this.add.rectangle(w / 2, h / 2, w, h, 0x052736);
    this.add.image(w / 2, h * 0.28, 'bg_storm').setDisplaySize(w, h * 0.62).setAlpha(0.5);

    const st = getState();
    const isNewBest = this.data0.meters >= st.highScoreMeters;

    // ---- One top-down flow with a consistent rhythm ---------------------------
    // Everything is laid out by a single running cursor (`cy`) that advances by
    // each element's real height plus a spacing token — tight WITHIN a group,
    // wider BETWEEN groups. Nothing is positioned by h*0.xx fractions anymore, so
    // elements can't overlap and the spacing reads deliberately. After building,
    // the whole stack is shifted to sit vertically centered.
    const G_TIGHT = S(8); // within a group
    const G = S(16); // between related blocks
    const G_GROUP = S(30); // between sections
    const items: Phaser.GameObjects.GameObject[] = [];
    let cy = 0;

    // Results card — a subtle rounded panel drawn BEHIND the score block (filled
    // once its bounds are known). Created here so it sits behind the later text.
    const resultsPanel = this.add.graphics();
    items.push(resultsPanel);

    // Place a text/image top-centered at the cursor, then advance. `dh` overrides
    // the advance height (needed for images, whose .height is unscaled).
    const flow = <T extends Phaser.GameObjects.Text | Phaser.GameObjects.Image>(
      obj: T,
      gapAfter: number,
      dh?: number
    ): T => {
      obj.setOrigin(0.5, 0).setPosition(cx, cy);
      items.push(obj);
      cy += (dh ?? obj.height) + gapAfter;
      return obj;
    };

    // Uniform pill button: a rounded background + centred label inside a container,
    // so every button shares a width/height and sits on the same centre axis (no
    // more ragged padding-based widths). Placed top-aligned at the cursor (offset
    // by dx); the caller advances cy. Returns the container for wiring handlers.
    const makeButton = (
      label: string,
      opts: { w: number; hgt: number; bg: number; color: string; fontPx: number; dx?: number; fontFamily?: string }
    ): Phaser.GameObjects.Container => {
      const { w: bw, hgt, bg, color, fontPx, dx = 0, fontFamily = FONT_TITLE } = opts;
      const g = this.add.graphics();
      g.fillStyle(bg, 1);
      g.fillRoundedRect(-bw / 2, -hgt / 2, bw, hgt, S(13));
      const lbl = this.add
        .text(0, 0, label, { fontFamily, fontSize: `${fontPx}px`, color, align: 'center' })
        .setOrigin(0.5);
      const c = this.add
        .container(cx + dx, cy + hgt / 2, [g, lbl])
        .setSize(bw, hgt)
        .setInteractive({ useHandCursor: true });
      c.on('pointerover', () => c.setScale(1.04));
      c.on('pointerout', () => c.setScale(1));
      items.push(c);
      return c;
    };

    // Title
    flow(
      this.add.text(cx, 0, 'THE TIDE GOT YOU!', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(26)}px`,
        color: '#ef476f',
        stroke: '#0b3d5c',
        strokeThickness: S(6),
      }),
      G
    );

    // Seal
    const seal = this.add.image(cx, cy, 'player_seal').setScale(S(0.2)).setAngle(16).setAlpha(0.92);
    seal.setOrigin(0.5, 0);
    items.push(seal);
    cy += seal.displayHeight + G;

    const panelTop = cy - S(10);

    // Stats — the run's highlights, biggest first: height, pearls, and (the
    // signature line) how much ocean you cleaned this run.
    const trash = this.data0.trashCleaned ?? 0;
    const boats = this.data0.boats ?? 0;
    const statsLines = [
      `Height: ${this.data0.meters} m${isNewBest ? '   🏆 NEW BEST!' : ''}`,
      `Pearls collected: ${this.data0.coins} 🦪`,
    ];
    if (trash > 0) {
      statsLines.push(`♻️ Trash collected: ${trash}${boats > 0 ? `   ·   🚢 ${boats}` : ''}`);
    }
    flow(
      this.add.text(cx, 0, statsLines.join('\n'), {
        fontFamily: FONT_BODY,
        fontSize: `${S(17)}px`,
        color: '#ffffff',
        align: 'center',
        lineSpacing: S(7),
      }),
      G_TIGHT
    );

    // Loss-aversion hook (only when it's not a record).
    const gapToBest = st.highScoreMeters - this.data0.meters;
    if (!isNewBest && gapToBest > 0) {
      flow(
        this.add.text(cx, 0, `🏆 Only ${gapToBest} m from your best!`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(14)}px`,
          color: '#ffd166',
        }),
        G_TIGHT
      );
    }

    // Global rank — reserve its slot now (fixed height) so the async fill never
    // reflows the layout or overlaps the next block.
    const globalRankText = this.add
      .text(cx, cy, '', { fontFamily: FONT_BODY, fontSize: `${S(13)}px`, color: '#9be7ff' })
      .setOrigin(0.5, 0);
    items.push(globalRankText);
    cy += S(22);
    // Now the score block's bottom edge is known — paint the card behind it.
    const panelW = S(340);
    const panelX = cx - panelW / 2;
    const panelH = cy - panelTop + S(10);
    resultsPanel.fillStyle(0x0a2f47, 0.5);
    resultsPanel.fillRoundedRect(panelX, panelTop, panelW, panelH, S(16));
    resultsPanel.lineStyle(S(1.5), 0x3a7f95, 0.5);
    resultsPanel.strokeRoundedRect(panelX, panelTop, panelW, panelH, S(16));
    // Spendable trash balance — the ♻️ currency for skins (subtle footnote).
    // Placed BELOW the card's bottom edge (was overlapping the border/rank line).
    if (st.trashCleaned > 0) {
      cy = panelTop + panelH + S(16);
      flow(
        this.add.text(cx, 0, `♻️ ${st.trashCleaned.toLocaleString()} trash to spend on skins 💙`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(12)}px`,
          color: '#7ff0e0',
        }),
        0
      );
    }
    cy += G_GROUP;
    let sceneClosed = false;
    this.events.once('shutdown', () => {
      sceneClosed = true;
    });
    submitScoreGlobal(st.username, this.data0.meters, st.selectedMap).then((result) => {
      if (sceneClosed || !result) return;
      const totalTxt = result.total ? ` of ${result.total}` : '';
      globalRankText.setText(`🌍 Global rank: #${result.rank}${totalTxt}`);
    });

    // Medals / new maps (conditional).
    let hadUnlock = false;
    if (this.data0.newBadges.length > 0) {
      hadUnlock = true;
      // 1–2 medals: name them. 3+ (a big NEW BEST run unlocking a batch): collapse
      // to a single clean summary line instead of a 3-line wrapped wall of text.
      const n = this.data0.newBadges.length;
      const totalReward = this.data0.newBadges.reduce((s, b) => s + b.reward, 0);
      const medalLabel =
        n <= 2
          ? `New medal${n > 1 ? 's' : ''}: ${this.data0.newBadges.map((b) => `${b.icon} ${b.name} +${b.reward}🦪`).join(', ')}`
          : `🏅 ${n} new medals earned  ·  +${totalReward} 🦪`;
      flow(
        this.add.text(cx, 0, medalLabel, {
          fontFamily: FONT_BODY,
          fontSize: `${S(13)}px`,
          color: '#ffd166',
          align: 'center',
          wordWrap: { width: w - S(120) },
        }),
        G_TIGHT
      );
    }
    if (this.data0.newMaps.length > 0) {
      hadUnlock = true;
      flow(
        this.add.text(cx, 0, `New map unlocked: ${this.data0.newMaps.map((m) => m.name).join(', ')}!`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(13)}px`,
          color: '#06d6a0',
          align: 'center',
          wordWrap: { width: w - S(80) },
        }),
        G_TIGHT
      );
    }
    if (hadUnlock) cy += G_GROUP - G_TIGHT; // promote the last tight gap to a section gap

    // ---- Rewarded row (only when an ad is actually ready) --------------------
    if (isRewardedReady()) {
      flow(
        this.add.text(cx, 0, '🎬 Watch an ad for a bonus', {
          fontFamily: TITLE_WITH_EMOJI,
          fontSize: `${S(14)}px`,
          color: '#ffd166',
        }),
        G
      );

      const rewardNote = this.add
        .text(cx, 0, '', {
          fontFamily: FONT_BODY,
          fontSize: `${S(12)}px`,
          color: '#c9f7d9',
          align: 'center',
          wordWrap: { width: w - S(80) },
        })
        .setOrigin(0.5, 0);

      const REWARD_W = S(152);
      const REWARD_H = S(52);
      const wireReward = (c: Phaser.GameObjects.Container, onReward: () => void) => {
        c.on('pointerdown', () => {
          playSfx('click');
          rewardNote.setText('Loading ad…');
          showRewardedAd(this, onReward, () => rewardNote.setText('No ad available right now — try again in a bit.'));
        });
      };
      // Continue + +10 as an equal-width, symmetric pair (or just +10 centred once
      // the revive is used) — same size, even gap, both on the centre axis.
      const twoUp = !this.data0.adRevived;
      if (twoUp) {
        const contBtn = makeButton('❤️ Continue', {
          w: REWARD_W, hgt: REWARD_H, bg: 0x06d6a0, color: '#0b3d5c', fontPx: S(15), dx: -(REWARD_W / 2 + S(8)), fontFamily: TITLE_WITH_EMOJI,
        });
        wireReward(contBtn, () => {
          this.scene.start('GameScene', {
            revive: { meters: this.data0.meters, coins: this.data0.coins, bankedCoins: this.data0.bankedCoins, adRevived: true },
          });
        });
      }
      let pearlGranted = false;
      const pearlsBtn = makeButton('+10 🦪', {
        w: REWARD_W, hgt: REWARD_H, bg: 0xffd166, color: '#0b3d5c', fontPx: S(15), dx: twoUp ? REWARD_W / 2 + S(8) : 0, fontFamily: TITLE_WITH_EMOJI,
      });
      wireReward(pearlsBtn, () => {
        if (pearlGranted) return;
        addCoins(10);
        pearlGranted = true;
        rewardNote.setText('+10 🦪 added to your pearls!');
        pearlsBtn.disableInteractive().setAlpha(0.5);
      });
      cy += REWARD_H + G_TIGHT;

      rewardNote.setPosition(cx, cy);
      items.push(rewardNote);
      cy += S(16) + G_GROUP;
    }

    // ---- Share ---------------------------------------------------------------
    flow(
      this.add.text(cx, 0, '📣 Share your score', {
        fontFamily: TITLE_WITH_EMOJI,
        fontSize: `${S(19)}px`,
        color: '#ffffff',
      }),
      G
    );

    const shareNote = this.add
      .text(cx, 0, '', {
        fontFamily: FONT_BODY,
        fontSize: `${S(12)}px`,
        color: '#c9f7d9',
        align: 'center',
        wordWrap: { width: w - S(80) },
      })
      .setOrigin(0.5, 0);

    let shareAwarded = false;
    const doShare = async (platform: SharePlatform) => {
      playSfx('click');
      const result = await shareTo(platform, this.data0.meters, st.username, SHARE_URL);
      if (result.ok && !shareAwarded) {
        registerShare(); // +25 pearls, once per game-over
        shareAwarded = true;
      }
      if (result.note) shareNote.setText(result.note);
    };

    const buttons = buildShareButtons(hasNativeShare());
    const CHIP_R = S(23);
    const ICON = S(28);
    const ICON_GAP = S(62); // centre-to-centre; > 2·CHIP_R so chips never touch
    const startX = cx - ((buttons.length - 1) * ICON_GAP) / 2;
    const iconCenterY = cy + CHIP_R;
    buttons.forEach((b, i) => {
      const chip = this.add.circle(0, 0, CHIP_R, 0xffffff);
      let glyph: Phaser.GameObjects.GameObject;
      if (b.icon && this.textures.exists(b.icon)) {
        glyph = this.add.image(0, 0, b.icon).setDisplaySize(ICON, ICON);
      } else {
        glyph = this.add.text(0, 0, b.emoji, { fontFamily: EMOJI_FONT, fontSize: `${S(24)}px` }).setOrigin(0.5);
      }
      const btn = this.add
        .container(startX + i * ICON_GAP, iconCenterY, [chip, glyph])
        .setSize(CHIP_R * 2, CHIP_R * 2)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setScale(1.12));
      btn.on('pointerout', () => btn.setScale(1));
      btn.on('pointerdown', () => doShare(b.p));
      items.push(btn);
    });
    cy += CHIP_R * 2 + G_TIGHT;

    shareNote.setPosition(cx, cy);
    items.push(shareNote);
    cy += S(16) + G_GROUP;

    // ---- Primary actions — same width, centred, clear separation -------------
    const BTN_W = S(232);
    const playAgain = makeButton('▶ PLAY AGAIN', { w: BTN_W, hgt: S(58), bg: 0x06d6a0, color: '#0b3d5c', fontPx: S(20) });
    playAgain.on('pointerdown', () => {
      playSfx('click');
      debugLog('[verify-no-ad] GameOver PLAY AGAIN pressed');
      showInterstitial(this, () => this.scene.start('GameScene'));
    });
    cy += S(58) + G;

    const menuBtn = makeButton('MAIN MENU', { w: BTN_W, hgt: S(46), bg: 0x124b6b, color: '#ffffff', fontPx: S(15) });
    menuBtn.on('pointerdown', () => {
      playSfx('click');
      this.scene.start('TitleScene');
    });
    cy += S(46);

    // Centre the whole stack vertically (with a safe top margin on short screens).
    const offset = Math.max(S(18), (h - cy) / 2);
    items.forEach((o) => {
      (o as unknown as { y: number }).y += offset;
    });
  }
}
