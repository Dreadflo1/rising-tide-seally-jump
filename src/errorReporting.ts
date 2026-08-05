// Lightweight client-side error capture for a static, backend-less deploy.
// There's no server to ship errors to, so this does the next best thing:
// logs to the console (visible via remote debugging) and keeps a rolling
// log in localStorage so a player can be asked "can you send me what's in
// seal-jump-error-log-v1" or you can wire it to a real service later.
//
// To upgrade to a real error tracker (recommended once the game has real
// traffic), add a call inside record() — e.g. Sentry's
// Sentry.captureException. Everything else here stays the same.

const KEY = 'seal-jump-error-log-v1';
const MAX_ENTRIES = 20;

interface ErrorEntry {
  type: string;
  message: string;
  source?: string;
  line?: number;
  at: string;
}

function record(entry: Omit<ErrorEntry, 'at'>) {
  try {
    const raw = localStorage.getItem(KEY);
    const list: ErrorEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ ...entry, at: new Date().toISOString() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    /* localStorage unavailable (private browsing, quota, etc.) — skip */
  }
}

let initialized = false;

/** Call once, as early as possible (before the Phaser game boots). */
export function initErrorReporting() {
  if (initialized) return;
  initialized = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    record({ type: 'error', message: e.message, source: e.filename, line: e.lineno });
    console.error('[seal-jump] uncaught error:', e.error || e.message);
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    record({ type: 'unhandledrejection', message: String(e.reason) });
    console.error('[seal-jump] unhandled rejection:', e.reason);
  });
}

/** Read back the rolling error log — handy for a future "send debug info" button. */
export function getErrorLog(): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
