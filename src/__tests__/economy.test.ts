import { describe, expect, it } from 'vitest';
import { CHARITY_DONATION_COST, EXTRA_LIFE_COST } from '../economy';
import { SKINS } from '../state';

describe('economy pricing', () => {
  it('adds one zero to skin prices', () => {
    const byId = Object.fromEntries(SKINS.map((skin) => [skin.id, skin.cost]));

    expect(byId.seal).toBe(0);
    expect(byId.gold).toBe(7000);
    expect(byId.violet).toBe(12000);
    expect(byId.kelp).toBe(15000);
    expect(byId.hawaii).toBe(17000);
  });

  it('adds one zero to other shop prices', () => {
    expect(EXTRA_LIFE_COST).toBe(2000);
    expect(CHARITY_DONATION_COST).toBe(1000);
  });
});
