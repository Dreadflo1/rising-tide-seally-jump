// Cross-device cloud accounts (Phase 2b). Talks to api/account.ts. A nickname +
// password creates/opens a cloud profile; the player's progress (coins, skins,
// maps, best score…) syncs so they can log in on another device and keep it.
// Soft-fails everywhere: if the backend is offline or unconfigured, the game
// keeps working with the local profile.

import { getState, applyCloudState, setStateSaveHook } from './state';
import { loginAccount, logout as localLogout } from './auth';

const TOKEN_KEY = 'seal-jump-cloud-token-v1';

export function getCloudToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setCloudToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
export function isCloudLoggedIn(): boolean {
  return !!getCloudToken();
}

// The account API only exists on our own deployment (Vercel), not on the GD CDN.
function backendAvailable(): boolean {
  try {
    return !/gamedistribution\.com$/i.test(location.hostname);
  } catch {
    return true;
  }
}

async function post(action: string, extra: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const res = await fetch('/api/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, data };
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

interface AccountResponse {
  ok?: boolean;
  token?: string;
  state?: Record<string, unknown>;
  username?: string;
  profileId?: string;
  authProvider?: 'local' | 'email' | 'google';
  email?: string;
  error?: string;
}

function applyAccountResponse(data: AccountResponse, fallbackUsername: string, fallbackProfileId: string, fallbackProvider: 'local' | 'email' | 'google', fallbackEmail?: string) {
  setCloudToken(data.token || null);
  const session = loginAccount({
    username: data.username || fallbackUsername,
    profileId: data.profileId || fallbackProfileId,
    authProvider: data.authProvider || fallbackProvider,
    email: data.email || fallbackEmail,
  });
  if (data.state) applyCloudState(session.username, data.state, session.profileId);
}

export async function cloudSignup(username: string, password: string): Promise<AuthResult> {
  if (!backendAvailable()) return { ok: false, error: 'Accounts are available on the game website.' };
  try {
    const { status, data } = await post('signup', { username, password, state: getState() });
    if (status === 200 && data.ok) {
      applyAccountResponse(data, username, username.toLowerCase(), 'local');
      return { ok: true };
    }
    return { ok: false, error: data.error || (status === 409 ? 'That nickname is taken' : 'Sign up failed') };
  } catch {
    return { ok: false, error: 'Network error — try again' };
  }
}

export async function cloudLogin(username: string, password: string): Promise<AuthResult> {
  if (!backendAvailable()) return { ok: false, error: 'Accounts are available on the game website.' };
  try {
    const { status, data } = await post('login', { username, password });
    if (status === 200 && data.ok) {
      applyAccountResponse(data, username, username.toLowerCase(), 'local');
      return { ok: true };
    }
    return { ok: false, error: status === 401 ? 'Wrong nickname or password' : data.error || 'Login failed' };
  } catch {
    return { ok: false, error: 'Network error — try again' };
  }
}

export async function cloudEmailSignup(email: string, password: string, displayName: string): Promise<AuthResult> {
  if (!backendAvailable()) return { ok: false, error: 'Accounts are available on the game website.' };
  try {
    const { status, data } = await post('email-signup', { email, password, displayName, state: getState() });
    if (status === 200 && data.ok) {
      applyAccountResponse(data, displayName || email, `email:${email.trim().toLowerCase()}`, 'email', email);
      return { ok: true };
    }
    return { ok: false, error: data.error || (status === 409 ? 'That email is already registered' : 'Sign up failed') };
  } catch {
    return { ok: false, error: 'Network error — try again' };
  }
}

export async function cloudEmailLogin(email: string, password: string): Promise<AuthResult> {
  if (!backendAvailable()) return { ok: false, error: 'Accounts are available on the game website.' };
  try {
    const { status, data } = await post('email-login', { email, password });
    if (status === 200 && data.ok) {
      applyAccountResponse(data, email, `email:${email.trim().toLowerCase()}`, 'email', email);
      return { ok: true };
    }
    return { ok: false, error: status === 401 ? 'Wrong email or password' : data.error || 'Login failed' };
  } catch {
    return { ok: false, error: 'Network error — try again' };
  }
}

let googleClientIdPromise: Promise<string> | null = null;

export function getGoogleClientId(): Promise<string> {
  if (!backendAvailable()) return Promise.resolve('');
  if (!googleClientIdPromise) {
    googleClientIdPromise = fetch('/api/config')
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: { googleClientId?: string }) => String(data.googleClientId || ''))
      .catch(() => '');
  }
  return googleClientIdPromise;
}

export async function cloudGoogleLogin(idToken: string): Promise<AuthResult> {
  if (!backendAvailable()) return { ok: false, error: 'Accounts are available on the game website.' };
  try {
    const { status, data } = await post('google', { idToken, state: getState() });
    if (status === 200 && data.ok) {
      applyAccountResponse(data, data.username || 'Player', data.profileId || 'google', 'google', data.email);
      return { ok: true };
    }
    return { ok: false, error: data.error || 'Google sign-in failed' };
  } catch {
    return { ok: false, error: 'Network error — try again' };
  }
}

export function cloudLogout() {
  setCloudToken(null);
  localLogout();
}

// Debounced push of the current state to the cloud save (only when logged in).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCloudSave() {
  const token = getCloudToken();
  if (!token || !backendAvailable()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    post('save', { token, state: getState() }).catch(() => {
      /* offline — the local save still holds; it'll re-sync on the next change */
    });
  }, 1500);
}

/** Register the cloud-sync hook so every local state change pushes to the cloud
 *  when logged in. Call once at startup. */
export function initCloudSync() {
  setStateSaveHook(scheduleCloudSave);
}
