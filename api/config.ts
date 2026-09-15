// Public client config: the Google OAuth Client ID (public — exposed in the
// Google button anyway) and the buyable pearl packs. A pack is advertised as
// `available` only when its Stripe Price env var AND the secret key are set, so
// the client shows buy buttons only for packs that can actually be sold.
//
// Self-contained (no cross-file imports) because Vercel runs /api as ESM, where
// relative imports would need file extensions. The pack list is intentionally
// duplicated in api/checkout.ts — keep them in sync.

const PEARL_PACKS = [
  { id: 'p500', pearls: 500, label: 'Handful of pearls', priceLabel: '€0.99', priceEnv: 'STRIPE_PRICE_P500', best: false },
  { id: 'p1500', pearls: 1500, label: 'Pouch of pearls', priceLabel: '€2.49', priceEnv: 'STRIPE_PRICE_P1500', best: true },
  { id: 'p4000', pearls: 4000, label: 'Treasure of pearls', priceLabel: '€4.99', priceEnv: 'STRIPE_PRICE_P4000', best: false },
];

export default function handler(_req: any, res: any) {
  const storeReady = !!process.env.STRIPE_SECRET_KEY;
  const packs = PEARL_PACKS.map((p) => ({
    id: p.id,
    pearls: p.pearls,
    label: p.label,
    priceLabel: p.priceLabel,
    best: p.best,
    available: storeReady && !!process.env[p.priceEnv],
  }));
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    store: { enabled: storeReady, packs },
    // AdSense "H5 Games Ads" — public client id + display slot ids. All empty
    // until you set the env vars, which keeps the whole ad system inert.
    ads: {
      client: process.env.ADSENSE_CLIENT || '',
      slotGameOver: process.env.ADSENSE_SLOT_GAMEOVER || '',
      slotFooter: process.env.ADSENSE_SLOT_FOOTER || '',
    },
  });
}
