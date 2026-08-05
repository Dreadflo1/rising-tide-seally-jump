import { describe, expect, it } from 'vitest';
import { buildShareButtons, getGameOverShareLayout } from '../gameOverShareLayout';

describe('getGameOverShareLayout', () => {
  it('makes the share heading twice as large as before', () => {
    const layout = getGameOverShareLayout({
      width: 1080,
      height: 1922,
      contentBottomY: 760,
    });

    expect(layout.titleFontSize).toBe(26);
  });

  it('pushes the share section below medal text so they do not overlap', () => {
    const layout = getGameOverShareLayout({
      width: 1080,
      height: 1922,
      contentBottomY: 920,
      buttonCount: 6,
    });

    expect(layout.titleY).toBeGreaterThan(920);
    expect(layout.buttonPositions[0].y).toBeGreaterThan(layout.titleY);
    expect(layout.noteY).toBeGreaterThan(layout.buttonPositions[layout.buttonPositions.length - 1].y);
  });

  it('keeps all share buttons in one centered row directly under the heading', () => {
    const layout = getGameOverShareLayout({
      width: 1080,
      height: 1922,
      contentBottomY: 760,
      buttonCount: 6,
    });

    const firstRowY = layout.buttonPositions[0].y;

    expect(layout.buttonPositions).toHaveLength(6);
    expect(layout.rowCount).toBe(1);
    expect(layout.buttonPositions.every((p) => p.y === firstRowY)).toBe(true);
    expect((layout.buttonPositions[2].x + layout.buttonPositions[3].x) / 2).toBeCloseTo(1080 / 2, 5);
  });

  it('leaves a much larger gap under the enlarged share heading', () => {
    const layout = getGameOverShareLayout({
      width: 1080,
      height: 1922,
      contentBottomY: 760,
      buttonCount: 6,
    });

    expect(layout.buttonPositions[0].y - layout.titleY).toBeGreaterThanOrEqual(136);
  });

  it('nudges the first yellow share emoji down so it sits on the same visual line', () => {
    const layout = getGameOverShareLayout({
      width: 1080,
      height: 1922,
      contentBottomY: 760,
      buttonCount: 6,
    });

    expect(layout.buttonPositions[0].offsetY).toBeGreaterThan(0);
    expect(layout.buttonPositions.slice(1).every((p) => p.offsetY === 0)).toBe(true);
  });
});

describe('buildShareButtons', () => {
  it('uses real unicode emoji instead of fake brand-look icons', () => {
    const buttons = buildShareButtons(true);

    expect(buttons.map((button) => button.emoji)).toEqual(['📤', '🐦', '👥', '💬', '📸', '🎶']);
  });
});
