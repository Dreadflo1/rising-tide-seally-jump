import { describe, expect, it } from 'vitest';
import { AD_SKIP_COST, canSkipInterstitialWithPearls, shouldShowInterstitialOnTitlePlay } from '../adPolicy';

describe('shouldShowInterstitialOnTitlePlay', () => {
  it('keeps the very first title-screen play free even when a real SDK is configured', () => {
    expect(
      shouldShowInterstitialOnTitlePlay({
        hasRealAdSdk: true,
        playedThisSession: false,
      })
    ).toBe(false);
  });

  it('keeps the first local placeholder play ad-free when no real SDK is available', () => {
    expect(
      shouldShowInterstitialOnTitlePlay({
        hasRealAdSdk: false,
        playedThisSession: false,
      })
    ).toBe(false);
  });

  it('still shows an ad after the first run in the same session', () => {
    expect(
      shouldShowInterstitialOnTitlePlay({
        hasRealAdSdk: true,
        playedThisSession: true,
      })
    ).toBe(true);
  });
});

describe('interstitial skip pricing', () => {
  it('sets ad skip to 300 pearls', () => {
    expect(AD_SKIP_COST).toBe(300);
  });

  it('allows skipping only when the player can afford 300 pearls', () => {
    expect(canSkipInterstitialWithPearls(299)).toBe(false);
    expect(canSkipInterstitialWithPearls(300)).toBe(true);
  });
});
