// Lightweight "account" system backed by the `store` shim (localStorage, or the
// CrazyGames Data Module inside their portal iframe — see storage.ts).
// No real backend (static deploy) — but this behaves like a genuine login:
// a username creates/resumes a persistent profile, and the session survives
// page reloads until the player explicitly switches/logs out.

import { store } from './storage';

export interface Session {
  username: string;
  profileId: string;
  loggedInAt: number;
  // Guests are ephemeral, auto-named profiles — they don't accrue the daily
  // streak reward (which is meant for returning, named players).
  isGuest?: boolean;
  authProvider?: 'guest' | 'local' | 'email' | 'google';
  email?: string;
}

const SESSION_KEY = 'seal-jump-session-v1';
const PROFILES_KEY = 'seal-jump-known-usernames-v1';

export function sanitizeUsername(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/[^a-zA-Z0-9_ ]/g, '')
    .slice(0, 16);
  return trimmed.length > 0 ? trimmed : guestName();
}

export function guestName(): string {
  return `Guest${Math.floor(1000 + Math.random() * 9000)}`;
}

export function listProfiles(): string[] {
  try {
    const raw = store.getItem(PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function registerProfile(name: string) {
  const list = listProfiles();
  if (!list.includes(name)) {
    list.push(name);
    try {
      store.setItem(PROFILES_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }
}

export function getSession(): Session | null {
  try {
    const raw = store.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> | null;
    if (!parsed?.username) return null;
    return {
      username: parsed.username,
      profileId: parsed.profileId || parsed.username.toLowerCase(),
      loggedInAt: parsed.loggedInAt || Date.now(),
      isGuest: parsed.isGuest,
      authProvider: parsed.authProvider || (parsed.isGuest ? 'guest' : 'local'),
      email: parsed.email,
    };
  } catch {
    return null;
  }
}

export interface LoginAccountOptions {
  username: string;
  profileId: string;
  isGuest?: boolean;
  authProvider?: Session['authProvider'];
  email?: string;
}

export function loginAccount(options: LoginAccountOptions): Session {
  const username = sanitizeUsername(options.username);
  registerProfile(username);
  const session: Session = {
    username,
    profileId: options.profileId,
    loggedInAt: Date.now(),
    isGuest: options.isGuest,
    authProvider: options.authProvider,
    email: options.email,
  };
  try {
    store.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
  return session;
}

export function login(rawUsername: string, isGuest = false): Session {
  const username = sanitizeUsername(rawUsername);
  return loginAccount({
    username,
    profileId: username.toLowerCase(),
    isGuest,
    authProvider: isGuest ? 'guest' : 'local',
  });
}

export function logout() {
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
