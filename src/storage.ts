// Storage abstraction used for all persistent game data.
//
// Inside the CrazyGames portal iframe, plain window.localStorage is NOT persisted
// across sessions — but CrazyGames' own **Data Module** is (it syncs to the
// player's CrazyGames account). It exposes the exact same synchronous
// getItem/setItem/removeItem shape as localStorage, so this shim just forwards to
// it when it's available (i.e. after their SDK has initialised on their portal),
// and falls back to window.localStorage everywhere else — our own site, GD, dev.
//
// Everything is defensive: if either backend throws (private mode, quota, SDK not
// ready yet) we fall through / no-op so the game never crashes on a storage call.

interface KV {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function crazyData(): KV | null {
  try {
    const d = window.CrazyGames?.SDK?.data;
    if (d && typeof d.getItem === 'function' && typeof d.setItem === 'function') {
      return d as KV;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const store: KV = {
  getItem(key) {
    const d = crazyData();
    if (d) {
      try {
        return d.getItem(key);
      } catch {
        /* fall back to localStorage */
      }
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    const d = crazyData();
    if (d) {
      try {
        d.setItem(key, value);
        return;
      } catch {
        /* fall back to localStorage */
      }
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  removeItem(key) {
    const d = crazyData();
    if (d) {
      try {
        d.removeItem(key);
        return;
      } catch {
        /* fall back to localStorage */
      }
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
