import { describe, expect, it } from 'vitest';
import { CHARITY_DONATION_COST, EXTRA_LIFE_COST } from '../economy';
import { SKINS } from '../state';

describe('economy pricing', () => {
  it('prices skins in trash-scale amounts (bought with ♻️ trash, not pearls)', () => {
    const byId = Object.fromEntries(SKINS.map((skin) => [skin.id, skin.cost]));

    expect(byId.seal).toBe(0);
    expect(byId.surfer).toBe(40);
    expect(byId.cool).toBe(75);
    expect(byId.scuba).toBe(130);
    expect(byId.floatie).toBe(200);
    expect(byId.pirate).toBe(320);
    expect(byId.astronaut).toBe(500);
    expect(byId.neptune).toBe(800);

    // Trash prices must stay small enough to earn through play (a good run nets
    // ~15-30 pieces) — guard against accidentally reverting to pearl-scale costs.
    for (const skin of SKINS) expect(skin.cost).toBeLessThanOrEqual(1000);
  });

  it('keeps pearl-priced shop items unchanged', () => {
    expect(EXTRA_LIFE_COST).toBe(2000);
    expect(CHARITY_DONATION_COST).toBe(1000);
  });
});
