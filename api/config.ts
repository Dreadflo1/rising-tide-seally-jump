// Tiny public config endpoint so the client can pick up the Google OAuth Client
// ID from a single server env var (GOOGLE_CLIENT_ID) — no rebuild, no hardcoding.
// The Client ID is public (it's exposed in the Google button anyway); the
// client SECRET is never used (ID-token flow), so nothing sensitive here.
export default function handler(_req: any, res: any) {
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
}
