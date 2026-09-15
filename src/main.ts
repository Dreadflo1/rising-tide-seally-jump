import Phaser from 'phaser';
import BootScene from './scenes/BootScene';
import LoginScene from './scenes/LoginScene';
import TitleScene from './scenes/TitleScene';
import ShopScene from './scenes/ShopScene';
import GameScene from './scenes/GameScene';
import GameOverScene from './scenes/GameOverScene';
import { WIDTH, HEIGHT, S, debugLog } from './constants';
import { initErrorReporting } from './errorReporting';
import { login, getSession, logout as localLogout } from './auth';
import { fetchGlobalLeaderboard, loadProfile, getState, BADGES, MAPS, SKINS } from './state';
import { initCloudSync, cloudEmailLogin, cloudEmailSignup, cloudGoogleLogin, cloudLogout, getGoogleClientId, isCloudLoggedIn } from './cloud';
import { initStore } from './store';
import { initTuningPanel } from './tuningPanel';
import { initWebAds } from './webAds';
import { initCrazyAds, onCrazyGames } from './crazyAds';

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize(config: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: GoogleIdApi;
      };
    };
    __sealGoogleScriptPromise?: Promise<void>;
  }
}

// Register the cloud-sync hook up-front so in-game progress pushes to the cloud
// whenever the player is logged into a cross-device account.
initCloudSync();
initTuningPanel(); // dev-only live tuning panel (?tune=1); no-op for players
initWebAds(); // AdSense H5 ads on our own domain; no-op until ADSENSE_CLIENT is set
// CrazyGames SDK — only loads on the *.crazygames.com portal. We keep the promise
// so the boot path can wait for it there: the SDK's Data Module (persistent save)
// must be ready BEFORE the first profile load, or that read hits an empty
// localStorage and the player's saved progress wouldn't appear until a reload.
const crazyReady = initCrazyAds();

const BUILD_ID = 'gm-ad-debug-2026-07-30-c';

// Capture uncaught errors / rejections as early as possible, before
// anything else has a chance to throw.
initErrorReporting();

//#region debug-point verify-black-screen-startup
window.addEventListener('error', (e) => {
  try {
    debugLog('[verify-black-screen] window.error', {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  } catch {
    debugLog('[verify-black-screen] window.error');
  }
});
window.addEventListener('unhandledrejection', (e) => {
  debugLog('[verify-black-screen] unhandledrejection', String(e.reason));
});
debugLog('[build-id]', BUILD_ID);
debugLog('[verify-black-screen] main.ts loaded');
//#endregion debug-point verify-black-screen-startup

// Service worker = offline play + installable PWA, but ONLY on our OWN hosted
// build (seally.best / the Vercel deployment). Inside ANY game portal iframe —
// GameDistribution, CrazyGames, Poki … — and in local dev we keep it OFF and
// actively unregister any stale worker: a SW there just risks stale-cache
// ambiguity during their review and adds nothing (the game can't be "installed"
// from inside their iframe anyway).
if ('serviceWorker' in navigator) {
  const h = location.hostname;
  const isOwnHost =
    /(^|\.)seally\.best$/i.test(h) || /\.vercel\.app$/i.test(h) || h === 'localhost' || h === '127.0.0.1';
  const enableSW = import.meta.env.PROD && isOwnHost;
  if (enableSW) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => debugLog('[pwa] SW register failed', err));
    });
  } else {
    // Portal or dev: ensure no SW/caches linger.
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      .catch(() => {});
    if ('caches' in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith('seal-jump-')).map((key) => caches.delete(key))))
        .catch(() => {});
    }
  }
}

// PWA install prompt: Chrome/Android fires `beforeinstallprompt`; stash it so
// the TitleScene can offer an in-game "Install" button. (iOS has no such event —
// there the TitleScene shows a manual "Add to Home Screen" hint instead.)
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
declare global {
  interface Window {
    __sealInstallPrompt?: BeforeInstallPromptEvent;
  }
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__sealInstallPrompt = e as BeforeInstallPromptEvent;
});
window.addEventListener('appinstalled', () => {
  window.__sealInstallPrompt = undefined;
});

// The game is authored at a 480x854 "design" resolution (see constants.ts),
// but the actual Phaser canvas is created at WIDTH x HEIGHT — a supersampled
// buffer several times larger. FIT scaling then only ever *downscales* this
// large buffer to fit the browser window, so on Full HD / Retina monitors
// text, sprites and edges stay crisp instead of being blurrily stretched up
// from a tiny 480px-wide canvas.
let phaserBooted = false;
function bootGame() {
  if (phaserBooted) return;
  phaserBooted = true;
  try {
    //#region debug-point verify-black-screen-phaser
    debugLog('[verify-black-screen] creating Phaser.Game');
    //#endregion debug-point verify-black-screen-phaser
    new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      backgroundColor: '#073b4c',
      width: WIDTH,
      height: HEIGHT,
      render: {
        // antialias ON: this is a smooth-art (non-pixel-art) 2D game, so texture
        // filtering matters a lot. With antialias:false Phaser sets the texture
        // filter to NEAREST — every sprite/text drawn at a non-integer scale (which
        // is almost all of them, after FIT + retina compositing) gets jagged,
        // "pixelated" edges. antialias:true switches to LINEAR filtering so scaled
        // sprites and text stay smooth. The GPU cost is negligible on modern phones.
        antialias: true,
        // roundPixels stays OFF so the constant vertical scroll and moving platforms
        // interpolate smoothly instead of snapping/shimmering pixel-to-pixel.
        roundPixels: false,
        powerPreference: 'high-performance',
      },
      physics: {
        default: 'arcade',
        arcade: { gravity: { x: 0, y: S(1400) }, debug: false },
      },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: WIDTH,
        height: HEIGHT,
      },
      scene: [BootScene, LoginScene, TitleScene, ShopScene, GameScene, GameOverScene],
    });
    //#region debug-point verify-black-screen-phaser
    debugLog('[verify-black-screen] Phaser.Game created');
    //#endregion debug-point verify-black-screen-phaser
  } catch (err) {
    // Extremely defensive: covers catastrophic init failures (e.g. no WebGL/
    // canvas support on very old devices) so the player sees a message
    // instead of a blank white page.
    console.error('[seal-jump] failed to start Phaser', err);
    const el = document.getElementById('game');
    if (el) {
      el.innerHTML =
        '<div style="color:#fff;font-family:sans-serif;text-align:center;padding:60px 24px;max-width:420px;margin:0 auto;">' +
        'Something went wrong loading the game. Try refreshing the page, or switching browsers if the problem continues.' +
        '</div>';
    }
  }
}

// Landing page vs. game. The same build serves three contexts:
//  - Embedded in a portal iframe (GameDistribution) → play immediately.
//  - Launched as an installed PWA (standalone) → play immediately.
//  - A normal top-level visit to our own website → show the landing page, and
//    the "Play" button starts the game.
// If there is no #landing element at all (e.g. the game-only build), just boot.
function setupEntry() {
  const landing = document.getElementById('landing');
  const gameEl = document.getElementById('game');
  const showGame = async () => {
    // On the CrazyGames portal, wait for their SDK (Data Module) before booting so
    // the first profile load reads the persisted cloud save, not empty localStorage.
    if (onCrazyGames()) {
      try {
        await crazyReady;
      } catch {
        /* SDK failed — fall through to localStorage-backed play */
      }
    }
    if (landing) landing.style.display = 'none';
    if (gameEl) gameEl.style.display = 'block';
    bootGame();
  };

  let inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch {
    inIframe = true; // cross-origin framing throws → we are embedded
  }
  const nav = navigator as Navigator & { standalone?: boolean };
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;

  // Boot straight to the game (skip the marketing landing) when embedded in a
  // portal iframe, launched as an installed PWA, OR served from the CrazyGames
  // portal. The last case matters for CrazyGames' "no external login options"
  // rule: the landing hosts the Google/email sign-in modal, so on their domain we
  // never render it — the in-game flow only offers a local nickname / guest.
  if (!landing || inIframe || isStandalone || onCrazyGames()) {
    showGame();
    return;
  }

  // Top-level visit to the website: show the landing, wire its buttons.
  // NB: must be an explicit 'block' — setting '' would fall back to the CSS
  // rule `#landing { display: none }` and leave the landing hidden (black page).
  if (gameEl) gameEl.style.display = 'none';
  landing.style.display = 'block';
  document.getElementById('play-btn')?.addEventListener('click', showGame);
  document.getElementById('play-btn-2')?.addEventListener('click', showGame);

  // Media showcase: click a thumbnail (or the prev/next arrows) to swap the main
  // image. Missing/hidden thumbnails are skipped.
  const mgMain = document.getElementById('mg-main') as HTMLImageElement | null;
  const mgThumbs = Array.from(document.querySelectorAll<HTMLImageElement>('#mg-thumbs img'));
  if (mgMain && mgThumbs.length) {
    let mgIdx = 0;
    const mgShow = (i: number) => {
      const n = mgThumbs.length;
      mgIdx = ((i % n) + n) % n;
      const t = mgThumbs[mgIdx];
      mgMain.src = t.dataset.src || t.src;
      mgThumbs.forEach((el, j) => el.classList.toggle('active', j === mgIdx));
    };
    mgThumbs.forEach((t, i) => t.addEventListener('click', () => mgShow(i)));
    document.getElementById('mg-prev')?.addEventListener('click', () => mgShow(mgIdx - 1));
    document.getElementById('mg-next')?.addEventListener('click', () => mgShow(mgIdx + 1));
  }

  // Pre-fill the nickname box with the current profile, and reflect login on the
  // Account button.
  const nickInput = document.getElementById('nickname-input') as HTMLInputElement | null;
  const accountBtn = document.getElementById('account-btn');
  const refreshAccountUI = () => {
    const s = getSession();
    const logged = isCloudLoggedIn() && s && !s.isGuest;
    if (accountBtn) {
      accountBtn.textContent = logged ? s!.username : 'Log In';
      accountBtn.classList.toggle('primary', true);
    }
    if (nickInput && s && !s.isGuest && !nickInput.value) nickInput.value = s.username;
  };
  refreshAccountUI();

  // ---- Cloud account modal (Phase 2b): sign up / log in for cross-device sync,
  // or Account summary view when already logged in with cloud sync.
  const authModal = document.getElementById('auth-modal');
  const authGuestView = document.getElementById('auth-guest-view') as HTMLElement | null;
  const authAccountView = document.getElementById('auth-account-view') as HTMLElement | null;
  const authName = document.getElementById('auth-name') as HTMLInputElement | null;
  const authEmail = document.getElementById('auth-email') as HTMLInputElement | null;
  const authPass = document.getElementById('auth-pass') as HTMLInputElement | null;
  const authGoogle = document.getElementById('auth-google') as HTMLDivElement | null;
  const authGoogleNote = document.getElementById('auth-google-note');
  const authErr = document.getElementById('auth-err');
  const authTitle = document.getElementById('auth-title');
  const authSubmit = document.getElementById('auth-submit') as HTMLButtonElement | null;
  const authSwitchText = document.getElementById('auth-switch-text');
  const authSwitchLink = document.getElementById('auth-switch-link');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const setAuthView = (which: 'guest' | 'account') => {
    if (authGuestView) authGuestView.style.display = which === 'guest' ? '' : 'none';
    if (authAccountView) authAccountView.style.display = which === 'account' ? '' : 'none';
  };
  const providerLabel = (p: string | undefined) => {
    switch (p) {
      case 'google': return 'Google';
      case 'email': return 'Email + password';
      case 'local': return 'Local nickname';
      case 'guest': return 'Guest';
      default: return p || '—';
    }
  };
  const renderAccountSummary = () => {
    const s = getSession();
    if (s) {
      // Ensure state.ts loads the current profile so getState() reflects its
      // save (perls, high score, unlocks…) rather than whatever profile was
      // last active. Cloud-synced accounts may have restored a different
      // profileId than the default "Guest" state fallback.
      loadProfile(s.profileId, s.username);
    }
    const st = getState();
    const id = (id: string) => document.getElementById(id);
    const $name = id('acct-name'); if ($name) $name.textContent = s?.username || '—';
    const $email = id('acct-email'); if ($email) $email.textContent = s?.email || '—';
    const $provider = id('acct-provider'); if ($provider) $provider.textContent = providerLabel(s?.authProvider);
    const $best = id('acct-best'); if ($best) $best.textContent = `${st.highScoreMeters.toLocaleString()} m`;
    const $coins = id('acct-coins'); if ($coins) $coins.textContent = `${st.totalCoins.toLocaleString()} 🦪`;
    const $runs = id('acct-runs'); if ($runs) $runs.textContent = `${st.runsPlayed.toLocaleString()}`;
    const $maps = id('acct-maps'); if ($maps) $maps.textContent = `${st.unlockedMaps?.length || 0} / ${MAPS.length}`;
    const $skins = id('acct-skins'); if ($skins) $skins.textContent = `${st.ownedSkins?.length || 0} / ${SKINS.length}`;
    const ownedBadgeIds = new Set<string>(st.badges || []);
    const badgeTitles = (st.badges || []).map((id) => BADGES.find((b) => b.id === id)?.icon || '').filter(Boolean);
    const $badges = id('acct-badges');
    if ($badges) $badges.textContent = badgeTitles.length ? badgeTitles.join('  ') : 'No badges yet — finish a run over 50 m to earn your first!';

    // --- Badge chips: show all 12 badges, highlight the NEXT one to earn.
    //   • Owned badges: normal chip, bright.
    //   • The first non-owned badge by threshold: "next" styling (gold tint)
    //     + a note that explains "do +X m to earn it".
    //   • Everything else locked further down: greyed, dashed border.
    const $badgeList = id('acct-badgelist') as HTMLDivElement | null;
    if ($badgeList) {
      $badgeList.innerHTML = '';
      let nextPicked = false;
      const sorted = [...BADGES].sort((a, b) => a.threshold - b.threshold);
      for (const b of sorted) {
        const chip = document.createElement('span');
        const owned = ownedBadgeIds.has(b.id);
        chip.className = 'badge-chip' + (owned ? '' : nextPicked ? ' locked' : ' next locked');
        chip.textContent = `${b.icon}  ${b.name} · ${b.threshold} m`;
        chip.title = owned ? `${b.name} earned — +${b.reward} 🦪 reward` : `${b.name} — reach ${b.threshold} m to unlock (+${b.reward} 🦪 reward)`;
        $badgeList.appendChild(chip);
        if (!owned && !nextPicked) nextPicked = true;
      }
    }
    const $nextBadge = id('acct-nextbadge') as HTMLParagraphElement | null;
    if ($nextBadge) {
      const next = [...BADGES].sort((a, b) => a.threshold - b.threshold).find((b) => !ownedBadgeIds.has(b.id));
      if (!next) {
        $nextBadge.textContent = `All ${BADGES.length} badges collected! Legendary climb, ${s?.username || 'champion'} 🏆`;
      } else {
        const remaining = Math.max(0, next.threshold - st.highScoreMeters);
        $nextBadge.textContent =
          remaining <= 0
            ? `Your next badge ${next.icon} ${next.name} (${next.threshold} m) is due — finish a run to claim +${next.reward} 🦪!`
            : `Next up: ${next.icon} ${next.name} in ${remaining.toLocaleString()} m (+${next.reward} 🦪 when you hit ${next.threshold} m).`;
      }
    }

    // --- Next skin progression: show the cheapest unlocked skin you don't
    // own yet, with a progress bar and a clear "need X more 🦪". If every
    // skin is owned, show a celebratory note instead.
    const $nextSkinName = id('acct-nextskin-name') as HTMLParagraphElement | null;
    const $nextSkinBar = id('acct-nextskin-bar') as HTMLElement | null;
    const $nextSkinNote = id('acct-nextskin-note') as HTMLParagraphElement | null;
    const ownedSkins = new Set<string>(st.ownedSkins || ['seal']);
    const nextSkin = [...SKINS].filter((k) => !ownedSkins.has(k.id)).sort((a, b) => a.cost - b.cost)[0];
    if ($nextSkinName) {
      if (!nextSkin) {
        $nextSkinName.textContent = `All ${SKINS.length} skins unlocked! ✨`;
      } else {
        $nextSkinName.textContent = nextSkin.cost === 0 ? nextSkin.name : `${nextSkin.name} · ${nextSkin.cost.toLocaleString()} 🦪`;
      }
    }
    if ($nextSkinBar) {
      if (!nextSkin || nextSkin.cost === 0) {
        $nextSkinBar.style.width = nextSkin ? '100%' : '100%';
      } else {
        const pct = Phaser.Math.Clamp((st.totalCoins / nextSkin.cost) * 100, 0, 100);
        $nextSkinBar.style.width = `${pct.toFixed(0)}%`;
      }
    }
    if ($nextSkinNote) {
      if (!nextSkin) {
        $nextSkinNote.textContent = 'You own every outfit Seally sells. Time to show off on the leaderboard 🦭!';
      } else if (nextSkin.cost === 0) {
        $nextSkinNote.textContent = `${nextSkin.name} is free — open the in-game Skins panel to equip it.`;
      } else if (st.totalCoins >= nextSkin.cost) {
        $nextSkinNote.textContent = `You already have enough! You can buy ${nextSkin.name} right now in the Skins shop.`;
      } else {
        const need = nextSkin.cost - st.totalCoins;
        const estRuns = Math.max(1, Math.ceil(need / 280)); // ~280 pearls per steady medium run (rough estimate)
        $nextSkinNote.textContent = `Need ${need.toLocaleString()} more 🦪 (roughly ${estRuns} good runs) to unlock ${nextSkin.name}. Keep climbing!`;
      }
    }
  };
  const openAccount = () => {
    renderAccountSummary();
    setAuthView('account');
    if (authModal) authModal.style.display = 'flex';
  };
  const loadGoogleScript = async () => {
    if (window.google?.accounts?.id) return;
    if (!window.__sealGoogleScriptPromise) {
      window.__sealGoogleScriptPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-seal-google]');
        if (existing) {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error('google script failed')), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.sealGoogle = 'true';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('google script failed'));
        document.head.appendChild(script);
      });
    }
    await window.__sealGoogleScriptPromise;
  };
  let authMode: 'login' | 'signup' = 'login';
  const setAuthMode = (m: 'login' | 'signup') => {
    authMode = m;
    if (authTitle) authTitle.textContent = m === 'login' ? 'Log in' : 'Create account';
    if (authSubmit) authSubmit.textContent = m === 'login' ? 'Log in' : 'Sign up';
    if (authSwitchText) authSwitchText.textContent = m === 'login' ? 'No account yet?' : 'Already have one?';
    if (authSwitchLink) authSwitchLink.textContent = m === 'login' ? 'Create account' : 'Log in';
    if (authErr) authErr.textContent = '';
    if (authName) {
      authName.classList.toggle('hidden', m !== 'signup');
      authName.setAttribute('autocomplete', m === 'signup' ? 'nickname' : 'off');
    }
    if (authPass) authPass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  const renderGoogleButton = async () => {
    if (!authGoogle) return;
    authGoogle.innerHTML = '';
    if (authGoogleNote) authGoogleNote.textContent = 'Loading Google sign-in…';
    const clientId = await getGoogleClientId();
    if (!clientId) {
      if (authGoogleNote) authGoogleNote.textContent = 'Google sign-in will appear once GOOGLE_CLIENT_ID is configured.';
      return;
    }
    try {
      await loadGoogleScript();
      const googleId = window.google?.accounts?.id;
      if (!googleId) throw new Error('google sdk unavailable');
      googleId.initialize({
        client_id: clientId,
        callback: async (response: GoogleCredentialResponse) => {
          if (!response.credential) {
            if (authErr) authErr.textContent = 'Google did not return a valid sign-in token.';
            return;
          }
          if (authErr) authErr.textContent = '';
          if (authGoogleNote) authGoogleNote.textContent = 'Signing you in with Google…';
          const result = await cloudGoogleLogin(response.credential);
          if (result.ok) {
            closeAuth();
            refreshAccountUI();
          } else if (authErr) {
            authErr.textContent = result.error || 'Google sign-in failed';
          }
          if (authGoogleNote) authGoogleNote.textContent = '';
        },
      });
      googleId.renderButton(authGoogle, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        width: 320,
      });
      if (authGoogleNote) authGoogleNote.textContent = '';
    } catch {
      if (authGoogleNote) authGoogleNote.textContent = 'Google sign-in could not be loaded right now.';
    }
  };
  const openAuth = (m: 'login' | 'signup') => {
    setAuthMode(m);
    setAuthView('guest');
    const s = getSession();
    if (authName && s && !s.isGuest) authName.value = s.username;
    if (authEmail && s?.email) authEmail.value = s.email;
    if (authModal) authModal.style.display = 'flex';
    renderGoogleButton();
    if (authMode === 'signup') authName?.focus();
    else authEmail?.focus();
  };
  const closeAuth = () => {
    if (authModal) authModal.style.display = 'none';
    if (authGoogleNote) authGoogleNote.textContent = '';
  };
  // The pearl-pack store asks for the login modal when a guest clicks Buy.
  window.addEventListener('seal-open-auth', () => openAuth('login'));
  // Render pearl packs + handle Stripe return (no-ops if the store isn't configured).
  initStore();
  document.getElementById('auth-close')?.addEventListener('click', closeAuth);
  authModal?.addEventListener('click', (e) => {
    if (e.target === authModal) closeAuth();
  });
  authSwitchLink?.addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });
  const doAuth = async () => {
    const name = authName?.value.trim() || '';
    const email = authEmail?.value.trim() || '';
    const p = authPass?.value || '';
    if (authErr) authErr.textContent = '';
    if (!emailPattern.test(email)) {
      if (authErr) authErr.textContent = 'Enter a valid email address.';
      return;
    }
    if (authMode === 'signup' && !name) {
      if (authErr) authErr.textContent = 'Enter the display name you want to show in game.';
      return;
    }
    if (p.length < 4) {
      if (authErr) authErr.textContent = 'Use a password with at least 4 characters.';
      return;
    }
    if (authSubmit) {
      authSubmit.disabled = true;
      authSubmit.textContent = '…';
    }
    const r = authMode === 'login' ? await cloudEmailLogin(email, p) : await cloudEmailSignup(email, p, name);
    if (authSubmit) authSubmit.disabled = false;
    setAuthMode(authMode); // restore button label
    if (r.ok) {
      closeAuth();
      refreshAccountUI();
    } else if (authErr) {
      authErr.textContent = r.error || 'Something went wrong';
    }
  };
  authSubmit?.addEventListener('click', doAuth);
  authPass?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') doAuth();
  });

  document.getElementById('login-btn')?.addEventListener('click', () => openAuth('login'));
  document.getElementById('acct-play')?.addEventListener('click', () => { closeAuth(); showGame(); });
  document.getElementById('acct-logout')?.addEventListener('click', () => {
    try { cloudLogout(); } catch { /* ignore */ }
    try { localLogout(); } catch { /* ignore */ }
    refreshAccountUI();
    openAuth('login');
  });
  accountBtn?.addEventListener('click', () => {
    const s = getSession();
    if (isCloudLoggedIn() && s && !s.isGuest) {
      openAccount();
    } else {
      openAuth('login');
    }
  });

  // Nickname "Save & Play": creates a real session (see startWithNickname) and
  // launches the game.
  const startWithNickname = () => {
    const inp = document.getElementById('nickname-input') as HTMLInputElement | null;
    const name = inp?.value.trim();
    // A typed nickname becomes a real session so the game auto-logs in with it
    // and submits scores to the global leaderboard under that name.
    if (name) login(name);
    showGame();
  };
  document.getElementById('save-play-btn')?.addEventListener('click', startWithNickname);
  document.getElementById('nickname-input')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') startWithNickname();
  });

  // Social links are placeholders until real handles are provided.
  document.querySelectorAll('#landing .socials a').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const which = (el as HTMLElement).dataset.soc || 'Social';
      window.alert(which + ' link coming soon — send me your handle and I’ll add it!');
    });
  });

  // Landing leaderboard: per-map top 10 with a map switcher (soft-fails to a
  // friendly empty state / local board if the store isn't connected yet).
  const lbList = document.getElementById('lb-list');
  if (lbList) {
    const escapeHtml = (s: string) =>
      s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const loadLb = (map: string) => {
      lbList.innerHTML = '<div class="lb-empty">Loading…</div>';
      fetchGlobalLeaderboard(getSession()?.username, 10, map)
        .then((r) => {
          if (!r.top.length) {
            lbList.innerHTML = '<div class="lb-empty">No scores yet on this map — be the first!</div>';
            return;
          }
          const me = getSession()?.username;
          lbList.innerHTML = r.top
            .map((e, i) => {
              const mine = me && e.username === me ? ' me' : '';
              return `<div class="lb-row${mine}"><span class="lb-rank">#${i + 1}</span><span class="lb-name">${escapeHtml(e.username)}</span><span class="lb-m">${e.meters} m</span></div>`;
            })
            .join('');
        })
        .catch(() => {
          lbList.innerHTML = '<div class="lb-empty">Leaderboard coming online soon.</div>';
        });
    };
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#lb-tabs .lb-tab'));
    tabs.forEach((tab) =>
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        loadLb(tab.dataset.map || 'lagoon');
      })
    );
    loadLb('lagoon');
  }

  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    installBtn.addEventListener('click', async () => {
      const p = window.__sealInstallPrompt;
      if (p) {
        window.__sealInstallPrompt = undefined;
        try {
          await p.prompt();
          await p.userChoice;
        } catch {
          /* dismissed */
        }
        (installBtn as HTMLElement).style.display = 'none';
      } else if (isIOS) {
        window.alert('To install: tap the Share button, then “Add to Home Screen”.');
      } else {
        window.alert('Use your browser menu → “Install app” to add Seal Jump to your device.');
      }
    });
  }
}

setupEntry();
