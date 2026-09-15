// Social sharing. On mobile the native share sheet (navigator.share) already
// lists every installed app — TikTok, Instagram, Facebook, X, WhatsApp, etc. —
// so that's the best "share anywhere". For explicit per-platform buttons we use
// each site's web-share intent where one exists (X, Facebook, WhatsApp, Telegram)
// and, for Instagram/TikTok (which have NO web post-composer), copy the caption
// to the clipboard and open the app so the player just pastes.

export type SharePlatform =
  | 'native'
  | 'twitter'
  | 'facebook'
  | 'whatsapp'
  | 'instagram'
  | 'tiktok'
  | 'copy';

export interface ShareResult {
  platform: SharePlatform;
  note: string;
  ok: boolean;
}

// Always funnel shares to our own canonical site — never the current host. A run
// shared from a portal iframe (itch's CDN domain, GameDistribution, …) should
// still send friends to seally.best: the page we own, that's SEO'd, and that
// links out everywhere. GameOverScene passes this instead of location.href.
export const SHARE_URL = 'https://seally.best';

// First-person challenge (the sharer IS the player, so "beat me" reads right),
// with the correct game name and the charity hook. `username` is accepted for
// call-site compatibility but the copy stays personal, not third-person.
export function buildShareText(meters: number, _username?: string): string {
  return `🦭 I just climbed ${meters}m in Rising Tide: Seally Jump! Can you beat me and outrun the rising tide? 🌊 Free to play — and 20% supports The Ocean Cleanup 💙`;
}

export function hasNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

function openWindow(u: string) {
  try {
    window.open(u, '_blank', 'noopener,noreferrer');
  } catch {
    /* popup blocked — ignore */
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Share a score to a specific platform. Returns a short status note for the UI. */
export async function shareTo(
  platform: SharePlatform,
  meters: number,
  username: string,
  url: string
): Promise<ShareResult> {
  const text = buildShareText(meters, username);
  const full = `${text} ${url}`;

  switch (platform) {
    case 'native': {
      if (hasNativeShare()) {
        try {
          await navigator.share({ title: 'Rising Tide: Seally Jump', text, url });
          return { platform, note: 'Shared! Thanks 💚', ok: true };
        } catch {
          return { platform, note: '', ok: false }; // user cancelled
        }
      }
      const copied = await copyToClipboard(full);
      return { platform, note: copied ? 'Copied — paste anywhere!' : 'Could not share', ok: copied };
    }
    case 'twitter':
      openWindow(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`);
      return { platform, note: 'Opened X — post it! +25 🦪', ok: true };
    case 'facebook':
      openWindow(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(text)}`);
      return { platform, note: 'Opened Facebook! +25 🦪', ok: true };
    case 'whatsapp':
      openWindow(`https://wa.me/?text=${encodeURIComponent(full)}`);
      return { platform, note: 'Opened WhatsApp! +25 🦪', ok: true };
    case 'instagram': {
      const copied = await copyToClipboard(full);
      openWindow('https://www.instagram.com/');
      return { platform, note: copied ? 'Caption copied — paste in your IG post! +25 🦪' : 'Opened Instagram', ok: true };
    }
    case 'tiktok': {
      const copied = await copyToClipboard(full);
      openWindow('https://www.tiktok.com/upload');
      return { platform, note: copied ? 'Caption copied — paste in your TikTok! +25 🦪' : 'Opened TikTok', ok: true };
    }
    case 'copy':
    default: {
      const copied = await copyToClipboard(full);
      return { platform: 'copy', note: copied ? 'Link copied! +25 🦪' : 'Could not copy', ok: copied };
    }
  }
}
