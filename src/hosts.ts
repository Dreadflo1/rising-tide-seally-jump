// True only on OUR OWN hosted origins — seally.best, the Vercel deployment, and
// local dev — which is exactly where our /api backend exists. Everywhere else
// (ANY game portal or third-party embed: CrazyGames, Poki, GameDistribution,
// itch.io, GameJolt, and their randomised CDN domains) there is no backend, so
// the leaderboard / accounts / pearl-store calls are skipped instead of firing
// doomed /api requests. Using an allow-list (not a portal block-list) means new
// portals are handled correctly without having to enumerate their domains.
export function isOwnHost(): boolean {
  try {
    const h = location.hostname;
    return (
      /(^|\.)seally\.best$/i.test(h) ||
      /\.vercel\.app$/i.test(h) ||
      h === 'localhost' ||
      h === '127.0.0.1'
    );
  } catch {
    return false;
  }
}
