import Phaser from 'phaser';
import { FONT_TITLE, FONT_BODY, S } from '../constants';
import {
  getState,
  BADGES,
  MAPS,
  SKINS,
  buySkin,
  selectSkin,
  selectMap,
  donateToCharity,
} from '../state';
import { playSfx } from '../audio';
import { CHARITY_DONATION_COST } from '../economy';

type Tab = 'skins' | 'maps' | 'badges' | 'store';

export default class ShopScene extends Phaser.Scene {
  private tab: Tab = 'skins';
  private content!: Phaser.GameObjects.Container;
  private coinLabel!: Phaser.GameObjects.Text;
  private tabButtons: { key: Tab; btn: Phaser.GameObjects.Text }[] = [];
  // Vertical scrolling for lists taller than the screen (e.g. 8 skins).
  private scrollY = 0;
  private maxScroll = 0;
  private contentTop = 0; // y where the scrollable content starts
  private contentBottomLimit = 0; // y below which content must not be needed (above BACK)
  private dragActive = false;
  private dragStartPointerY = 0;
  private dragStartScrollY = 0;
  private didDrag = false; // true once a drag moved enough to count as a scroll, not a tap

  constructor() {
    super('ShopScene');
  }

  create() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.add.rectangle(w / 2, h / 2, w, h, 0x07304a);
    this.add.image(w / 2, h * 0.18, 'bg_lagoon').setDisplaySize(w, h * 0.5).setAlpha(0.35);

    this.add
      .text(w / 2, S(34), 'SHOP & COLLECTION', { fontFamily: FONT_TITLE, fontSize: `${S(22)}px`, color: '#ffd166' })
      .setOrigin(0.5);

    this.coinLabel = this.add
      .text(w / 2, S(66), `🦪 ${getState().totalCoins}`, { fontFamily: FONT_BODY, fontSize: `${S(16)}px`, color: '#ffffff' })
      .setOrigin(0.5);

    // Store tab hidden for now (charity donate + info) — re-add { key: 'store',
    // label: 'Store' } here to bring it back.
    const tabs: { key: Tab; label: string }[] = [
      { key: 'skins', label: 'Skins' },
      { key: 'maps', label: 'Maps' },
      { key: 'badges', label: 'Badges' },
    ];
    const tabWidth = w / tabs.length;
    this.tabButtons = [];
    tabs.forEach((t, i) => {
      const btn = this.add
        .text(tabWidth * i + tabWidth / 2, S(100), t.label, {
          fontFamily: FONT_TITLE,
          fontSize: `${S(15)}px`,
          color: this.tab === t.key ? '#0b3d5c' : '#ffffff',
          backgroundColor: this.tab === t.key ? '#ffd166' : '#124b6b',
          padding: { x: S(12), y: S(8) },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        playSfx('click');
        this.tab = t.key;
        this.updateTabStyles();
        this.renderContent();
      });
      this.tabButtons.push({ key: t.key, btn });
    });

    this.content = this.add.container(0, 0);

    // Clip the scrollable list to the area between the tabs and the BACK button
    // so scrolled-up rows don't bleed over the header or footer.
    this.contentTop = S(120);
    this.contentBottomLimit = h - S(96);
    const maskShape = this.make.graphics({});
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(0, this.contentTop, w, this.contentBottomLimit - this.contentTop);
    this.content.setMask(maskShape.createGeometryMask());

    this.renderContent();

    const back = this.add
      .text(w / 2, h - S(70), '← BACK', {
        fontFamily: FONT_TITLE,
        fontSize: `${S(18)}px`,
        color: '#0b3d5c',
        backgroundColor: '#06d6a0',
        padding: { x: S(22), y: S(10) },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(10);
    back.on('pointerdown', () => {
      playSfx('click');
      this.scene.start('TitleScene');
    });

    // --- Scrolling (mouse wheel + touch/drag) ---------------------------------
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      this.applyScroll(this.scrollY - dy);
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragActive = true;
      this.didDrag = false;
      this.dragStartPointerY = p.y;
      this.dragStartScrollY = this.scrollY;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragActive) return;
      const delta = p.y - this.dragStartPointerY;
      if (!this.didDrag && Math.abs(delta) > S(6)) this.didDrag = true;
      if (this.didDrag) this.applyScroll(this.dragStartScrollY + delta);
    });
    const endDrag = () => {
      this.dragActive = false;
    };
    this.input.on('pointerup', endDrag);
    this.input.on('pointerupoutside', endDrag);
  }

  /** Clamp and apply a target scroll offset (0 = top, negative scrolls down). */
  private applyScroll(target: number) {
    if (this.maxScroll <= 0) {
      this.scrollY = 0;
      this.content.y = 0;
      return;
    }
    this.scrollY = Phaser.Math.Clamp(target, -this.maxScroll, 0);
    this.content.y = this.scrollY;
  }

  // Repaint the tab bar so the yellow "active" highlight follows the current
  // tab. The tabs are created once in create(); without this the highlight
  // stayed frozen on whatever tab was active at creation time.
  private updateTabStyles() {
    this.tabButtons.forEach(({ key, btn }) => {
      const active = this.tab === key;
      btn.setColor(active ? '#0b3d5c' : '#ffffff');
      btn.setBackgroundColor(active ? '#ffd166' : '#124b6b');
    });
  }

  private renderContent() {
    this.content.removeAll(true);
    const w = this.scale.width;
    // Skins are bought with trash collected (♻️); everything else uses pearls (🦪).
    // Show whichever balance is relevant to the active tab.
    const st0 = getState();
    this.coinLabel.setText(this.tab === 'skins' ? `♻️ ${st0.trashCleaned} trash` : `🦪 ${st0.totalCoins}`);

    if (this.tab === 'skins') this.renderSkins(w);
    else if (this.tab === 'maps') this.renderMaps(w);
    else if (this.tab === 'badges') this.renderBadges(w);
    else this.renderStore(w);

    // Recompute how far this tab's content can scroll, and reset to the top.
    this.scrollY = 0;
    this.content.y = 0;
    const b = this.content.getBounds();
    const contentBottom = b.y + b.height;
    this.maxScroll = Math.max(0, contentBottom - this.contentBottomLimit + S(16));
  }

  private cardRow(y: number, x: number, width: number, height: number) {
    return this.add.rectangle(x, y, width, height, 0x0b3d5c, 0.9).setStrokeStyle(S(2), 0x2a6f7f);
  }

  private renderSkins(w: number) {
    const st = getState();
    SKINS.forEach((skin, i) => {
      const y = S(180) + i * S(100);
      const card = this.cardRow(y, w / 2, w - S(40), S(84));
      const icon = this.add.image(S(70), y, skin.sprite).setScale(S(0.22));
      if (skin.tint !== undefined) icon.setTint(skin.tint);
      const owned = st.ownedSkins.includes(skin.id);
      const selected = st.selectedSkin === skin.id;
      const name = this.add.text(S(120), y - S(18), skin.name, { fontFamily: FONT_BODY, fontSize: `${S(15)}px`, color: '#fff' });
      const sub = this.add.text(
        S(120),
        y + S(6),
        owned ? (selected ? 'Equipped' : 'Owned') : `${skin.cost} ♻️`,
        { fontFamily: FONT_BODY, fontSize: `${S(13)}px`, color: owned ? '#06d6a0' : '#ffd166' }
      );
      const btn = this.add
        .text(w - S(90), y, owned ? (selected ? '✓' : 'EQUIP') : 'BUY', {
          fontFamily: FONT_TITLE,
          fontSize: `${S(13)}px`,
          color: '#0b3d5c',
          backgroundColor: selected ? '#06d6a0' : '#ffd166',
          padding: { x: S(14), y: S(8) },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerup', () => {
        if (this.didDrag) return; // was a scroll gesture, not a tap
        playSfx('click');
        if (owned) {
          selectSkin(skin.id);
        } else {
          if (buySkin(skin.id)) {
            playSfx('powerup');
            selectSkin(skin.id);
          }
        }
        this.renderContent();
      });
      this.content.add([card, icon, name, sub, btn]);
    });
  }

  private renderMaps(w: number) {
    const st = getState();
    MAPS.forEach((m, i) => {
      const y = S(180) + i * S(100);
      const unlocked = st.unlockedMaps.includes(m.id);
      const selected = st.selectedMap === m.id;

      // Card FIRST (bottom of the z-order) so text and the SELECT button sit on
      // top of it and stay tappable — previously the card was drawn over the
      // button, dimming it.
      const card = this.cardRow(y, w / 2, w - S(40), S(84));
      const icon = this.add.image(S(70), y, m.bg).setDisplaySize(S(50), S(74));
      const name = this.add.text(S(120), y - S(24), m.name, { fontFamily: FONT_BODY, fontSize: `${S(15)}px`, color: '#fff' });
      const status = this.add.text(
        S(120),
        y - S(4),
        unlocked ? (selected ? '✓ Selected' : 'Tap SELECT to play') : `🔒 Reach ${m.unlockThreshold}m`,
        { fontFamily: FONT_BODY, fontSize: `${S(12)}px`, color: unlocked ? '#06d6a0' : '#ef476f' }
      );
      const sub = this.add.text(S(120), y + S(16), m.blurb, {
        fontFamily: FONT_BODY,
        fontSize: `${S(10)}px`,
        color: '#9be7ff',
        wordWrap: { width: w - S(210) },
      });
      this.content.add([card, icon, name, status, sub]);

      if (unlocked) {
        const btn = this.add
          .text(w - S(88), y, selected ? '✓ PLAYING' : 'SELECT', {
            fontFamily: FONT_TITLE,
            fontSize: `${S(13)}px`,
            color: '#0b3d5c',
            backgroundColor: selected ? '#06d6a0' : '#ffd166',
            padding: { x: S(12), y: S(8) },
          })
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true });
        btn.on('pointerup', () => {
          if (this.didDrag) return; // was a scroll gesture, not a tap
          playSfx('click');
          selectMap(m.id);
          this.renderContent();
        });
        this.content.add(btn);
      } else {
        this.content.add(this.add.text(w - S(88), y, '🔒', { fontSize: `${S(20)}px` }).setOrigin(0.5));
      }
    });
  }

  private renderBadges(w: number) {
    const st = getState();
    // 2-column grid, tightened so all medal tiers fit above the back button.
    BADGES.forEach((b, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = w / 2 + (col === 0 ? -1 : 1) * (w / 4 - S(10));
      const y = S(172) + row * S(96);
      const earned = st.badges.includes(b.id);
      const card = this.cardRow(y, x, w / 2 - S(28), S(84));
      const icon = this.add
        .text(x, y - S(22), b.icon, { fontSize: `${S(24)}px` })
        .setOrigin(0.5)
        .setAlpha(earned ? 1 : 0.25);
      const name = this.add
        .text(x, y + S(4), b.name, {
          fontFamily: FONT_BODY,
          fontSize: `${S(11)}px`,
          color: earned ? '#ffffff' : '#7a97a6',
          align: 'center',
          wordWrap: { width: w / 2 - S(40) },
        })
        .setOrigin(0.5);
      const sub = this.add
        .text(x, y + S(26), `${b.threshold}m · +${b.reward} 🦪`, {
          fontFamily: FONT_BODY,
          fontSize: `${S(9)}px`,
          color: earned ? '#ffd166' : '#7a97a6',
        })
        .setOrigin(0.5);
      this.content.add([card, icon, name, sub]);
    });
  }

  private renderStore(w: number) {
    const st = getState();
    let y = S(190);

    // NOTE: the "Extra Life" purchase was removed. For fair, comparable
    // leaderboards every run now starts with 0 lives (see resetRunLives), so
    // buying lives in the menu would have no effect. Hearts collected DURING a
    // run still grant revives, and a revive keeps the run's score.

    // Charity donation
    {
      const card = this.cardRow(y, w / 2, w - S(40), S(94));
      const title = this.add.text(S(30), y - S(24), '💚 Donate Pearls to Charity', {
        fontFamily: FONT_BODY,
        fontSize: `${S(15)}px`,
        color: '#fff',
      });
      const sub = this.add.text(S(30), y, `Total donated: ${st.charityMeter} 🦪`, {
        fontFamily: FONT_BODY,
        fontSize: `${S(12)}px`,
        color: '#9be7ff',
      });
      const note = this.add.text(S(30), y + S(22), 'Supports The Ocean Cleanup — 20% of revenue, every 6 months', {
        fontFamily: FONT_BODY,
        fontSize: `${S(10)}px`,
        color: '#c9f7d9',
        wordWrap: { width: w - S(150) },
      });
      const btn = this.add
        .text(w - S(80), y, `${CHARITY_DONATION_COST} 🦪`, {
          fontFamily: FONT_TITLE,
          fontSize: `${S(13)}px`,
          color: '#0b3d5c',
          backgroundColor: '#06d6a0',
          padding: { x: S(10), y: S(8) },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        playSfx('click');
        if (donateToCharity(CHARITY_DONATION_COST)) {
          playSfx('powerup');
        }
        this.renderContent();
      });
      this.content.add([card, title, sub, note, btn]);
      y += S(118);
    }

    const footer = this.add
      .text(
        w / 2,
        y + S(10),
        'Rising Tide: Seal Jump is a free-to-play game.\nAds keep it free — we donate 20% of revenue to\nThe Ocean Cleanup every 6 months 💙',
        { fontFamily: FONT_BODY, fontSize: `${S(11)}px`, color: '#c9f7d9', align: 'center', lineSpacing: S(4) }
      )
      .setOrigin(0.5, 0);
    this.content.add(footer);
  }
}
