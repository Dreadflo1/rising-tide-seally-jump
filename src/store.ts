// Pearl-pack store (premium site only). Renders the buyable packs on the landing
// page and starts a Stripe Checkout for the logged-in player. Pearls are granted
// server-side by the webhook (api/stripe-webhook.ts) after payment — never here.
//
// Soft-fails everywhere: if the store isn't configured (no Stripe keys) or the
// player isn't on our own domain, the section stays hidden and the game is
// unaffected.

import { getCloudToken, isCloudLoggedIn, cloudRefresh } from './cloud';
import { getState } from './state';
import { isOwnHost } from './hosts';

interface StorePack {
  id: string;
  pearls: number;
  label: string;
  priceLabel: string;
  best: boolean;
  available: boolean;
}

function backendAvailable(): boolean {
  try {
    return isOwnHost();
  } catch {
    return true;
  }
}

function setNote(msg: string) {
  const note = document.getElementById('pearl-packs-note');
  if (note) note.textContent = msg;
}

async function startCheckout(packId: string, btn: HTMLButtonElement) {
  if (!isCloudLoggedIn()) {
    setNote('Log in (Google or email) first so your pearls are saved to your account.');
    window.dispatchEvent(new CustomEvent('seal-open-auth'));
    return;
  }
  const token = getCloudToken();
  if (!token) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Opening checkout…';
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, packId, origin: location.origin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data.url) {
      window.location.href = data.url; // Stripe-hosted checkout
      return;
    }
    setNote(data.error || 'Could not start checkout — try again.');
  } catch {
    setNote('Network error — try again.');
  }
  btn.disabled = false;
  btn.textContent = original;
}

function renderPacks(packs: StorePack[]) {
  const host = document.getElementById('pearl-packs');
  const section = document.getElementById('pearl-packs-section');
  if (!host || !section) return;
  const sellable = packs.filter((p) => p.available);
  if (sellable.length === 0) return; // nothing to sell yet — keep it hidden
  host.innerHTML = '';
  for (const p of sellable) {
    const card = document.createElement('div');
    card.style.cssText =
      'background:#fff;border-radius:16px;padding:18px 16px;text-align:center;border:2px solid ' +
      (p.best ? '#0077B6' : '#e3edf4') +
      ';box-shadow:0 8px 24px rgba(2,62,138,.08);position:relative;';
    card.innerHTML =
      (p.best ? '<div style="position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:#0077B6;color:#fff;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:3px 12px;border-radius:999px;">Best value</div>' : '') +
      '<div style="font-size:30px;font-weight:800;color:#023E8A;font-family:\'Baloo 2\',sans-serif;">' + p.pearls.toLocaleString() + ' 🦪</div>' +
      '<div style="font-size:13px;color:#5b7a95;margin:2px 0 12px;">' + p.label + '</div>';
    const btn = document.createElement('button');
    btn.textContent = 'Buy · ' + p.priceLabel;
    btn.style.cssText =
      'width:100%;padding:12px;border:none;border-radius:12px;background:#FFD166;color:#023E8A;' +
      "font-family:'Baloo 2',sans-serif;font-weight:800;font-size:16px;cursor:pointer;box-shadow:0 5px 0 #e0a92e;";
    btn.addEventListener('click', () => startCheckout(p.id, btn));
    card.appendChild(btn);
    host.appendChild(card);
  }
  section.style.display = '';
  setNote(isCloudLoggedIn() ? '' : 'Log in to buy — pearls are saved to your account and sync across devices.');
}

/** After returning from Stripe Checkout: refresh pearls from the cloud (the
 *  webhook credits them a moment after payment) and clean the URL. */
async function handlePurchaseReturn() {
  const params = new URLSearchParams(location.search);
  const purchase = params.get('purchase');
  if (!purchase) return;
  // Strip the query so a refresh doesn't re-trigger.
  params.delete('purchase');
  params.delete('pack');
  const clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
  history.replaceState(null, '', clean);

  if (purchase !== 'success') {
    setNote('Checkout canceled — no charge was made.');
    return;
  }
  setNote('Payment received — adding your pearls…');
  const before = getState().totalCoins;
  // The webhook may land a second after redirect; poll a few times.
  for (let i = 0; i < 6; i++) {
    const ok = await cloudRefresh();
    if (ok && getState().totalCoins > before) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const gained = getState().totalCoins - before;
  setNote(gained > 0 ? `+${gained.toLocaleString()} 🦪 added! Spend them on skins.` : 'Pearls will appear shortly — reload if needed.');
  window.dispatchEvent(new CustomEvent('seal-pearls-updated'));
}

/** Fetch store config and wire up the pearl packs. Call once on landing load. */
export async function initStore() {
  if (!backendAvailable()) return;
  try {
    const res = await fetch('/api/config');
    const data = await res.json().catch(() => ({}));
    if (data?.store?.enabled && Array.isArray(data.store.packs)) {
      renderPacks(data.store.packs as StorePack[]);
    }
  } catch {
    /* offline — leave the section hidden */
  }
  handlePurchaseReturn();
}
