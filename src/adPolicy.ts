export interface TitlePlayAdPolicyInput {
  hasRealAdSdk: boolean;
  playedThisSession: boolean;
}

export const AD_SKIP_COST = 300;

export function shouldShowInterstitialOnTitlePlay({
  playedThisSession,
}: TitlePlayAdPolicyInput): boolean {
  return playedThisSession;
}

export function canSkipInterstitialWithPearls(totalPearls: number): boolean {
  return totalPearls >= AD_SKIP_COST;
}
