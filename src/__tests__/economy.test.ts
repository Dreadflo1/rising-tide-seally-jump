import { describe, expect, it } from 'vitest';
import { CHARITY_DONATION_COST, EXTRA_LIFE_COST } from '../economy';
import { SKINS } from '../state';

describe('economy pricing', () => {
  it('prices skins in trash-scale amounts (bought with ♻️ trash, not pearls)', () => {
    const byId = Object.fromEntries(SKINS.map((skin) => [skin.id, skin.cost]));

    expect(byId.seal).toBe(0);
    expect(byId.surfer).toBe(400);
    expect(byId.cool).toBe(750);
    expect(byId.scuba).toBe(1300);
    expect(byId.floatie).toBe(2000);
    expect(byId.pirate).toBe(3200);
    expect(byId.astronaut).toBe(5000);
    expect(byId.neptune).toBe(8000);

    // Aspirational but bounded — guard against runaway pricing.
    for (const skin of SKINS) expect(skin.cost).toBeLessThanOrEqual(8000);
  });

  it('keeps pearl-priced shop items unchanged', () => {
    expect(EXTRA_LIFE_COST).toBe(2000);
    expect(CHARITY_DONATION_COST).toBe(1000);
  });
});
