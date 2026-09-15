import { SharePlatform, hasNativeShare } from './share';

export interface ShareButtonDef {
  emoji: string; // fallback glyph (used for 'native', which has no brand icon)
  p: SharePlatform;
  icon?: string; // texture key for a real brand icon, when one exists
}

export interface GameOverShareLayoutInput {
  width: number;
  height: number;
  contentBottomY: number;
  buttonCount?: number;
}

export interface ShareButtonPosition {
  x: number;
  y: number;
  offsetY: number;
}

export interface GameOverShareLayout {
  titleY: number;
  noteY: number;
  playAgainY: number;
  menuY: number;
  titleFontSize: number;
  iconFontSize: number;
  rowCount: number;
  buttonPositions: ShareButtonPosition[];
}

export function buildShareButtons(includeNative = hasNativeShare()): ShareButtonDef[] {
  const buttons: ShareButtonDef[] = [];
  if (includeNative) buttons.push({ emoji: '📤', p: 'native' });
  buttons.push(
    { emoji: '🐦', p: 'twitter', icon: 'soc_x' },
    { emoji: '👥', p: 'facebook', icon: 'soc_facebook' },
    { emoji: '💬', p: 'whatsapp', icon: 'soc_whatsapp' },
    { emoji: '📸', p: 'instagram', icon: 'soc_instagram' },
    { emoji: '🎶', p: 'tiktok', icon: 'soc_tiktok' }
  );
  return buttons;
}

export function getGameOverShareLayout({ width, height, contentBottomY, buttonCount = 0 }: GameOverShareLayoutInput): GameOverShareLayout {
  const titleY = contentBottomY + 54;
  const rowCount = buttonCount > 0 ? 1 : 0;
  const perRow = buttonCount;
  const gap = 86;
  const rowGap = 0;
  const firstRowY = titleY + 136;
  const buttonPositions: ShareButtonPosition[] = [];

  for (let i = 0; i < buttonCount; i += 1) {
    const row = rowCount === 1 ? 0 : i < perRow ? 0 : 1;
    const indexInRow = row === 0 ? i : i - perRow;
    const buttonsInRow = rowCount === 1 ? buttonCount : row === 0 ? perRow : buttonCount - perRow;
    const startX = width / 2 - ((buttonsInRow - 1) * gap) / 2;
    buttonPositions.push({
      x: startX + indexInRow * gap,
      y: firstRowY + row * rowGap,
      offsetY: i === 0 ? 12 : 0,
    });
  }

  const lastButtonY = buttonPositions.length > 0 ? buttonPositions[buttonPositions.length - 1].y : firstRowY;
  const noteY = lastButtonY + 42;
  const playAgainY = Math.max(height * 0.68, noteY + 64);
  const menuY = Math.max(height * 0.78, playAgainY + 62);

  return {
    titleY,
    noteY,
    playAgainY,
    menuY,
    titleFontSize: 26,
    iconFontSize: 32,
    rowCount,
    buttonPositions,
  };
}
