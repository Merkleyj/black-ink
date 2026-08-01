/* =====================================================================
   Black Ink — billing (Black Ink Plus via Stripe)
   Reads the user's subscription row (RLS: own row only) so the UI can
   show plan state, and opens Stripe-hosted Checkout / Billing Portal via
   the `stripe` Edge Function. No card data ever touches this app — the
   server enforces entitlements; everything here is presentation.
   Requires cloud mode + a signed-in user.
   ===================================================================== */
(function () {
  'use strict';

  function client() { return (window.BlackInkSync && BlackInkSync.client) || null; }
  function signedIn() { return !!(window.BlackInkSync && BlackInkSync.user); }
  function available() { return !!(window.BLACKINK_CLOUD_ENABLED && client() && signedIn()); }

  const ENTITLED = ['comp', 'active', 'trialing', 'past_due'];

  // Cache the last known status so transient fetch failures don't flip the UI.
  let _status = null;
  try { _status = JSON.parse(localStorage.getItem('bi_billing') || 'null'); } catch (e) {}

  async function load() {
    if (!available()) return null;
    try {
      const { data, error } = await client().from('subscriptions')
        .select('status,price_interval,cancel_at_period_end,current_period_end')
        .eq('user_id', BlackInkSync.user.id).maybeSingle();
      if (!error) {
        _status = data || { status: 'none' };
        try { localStorage.setItem('bi_billing', JSON.stringify(_status)); } catch (e) {}
      }
    } catch (e) { /* keep cached value */ }
    return _status;
  }

  function entitled() { return !!(_status && ENTITLED.includes(_status.status)); }
  function info() { return _status; }

  async function invoke(action, body) {
    const c = client(); if (!c) throw new Error('Not signed in');
    const { data, error } = await c.functions.invoke('stripe', { body: { action, ...(body || {}) } });
    if (error) {
      let msg = error.message || 'Request failed';
      try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (e) {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  async function checkout(interval) {
    if (!available()) { toast('Sign in first', 'warn'); return; }
    toast('Opening secure checkout…');
    try {
      const d = await invoke('checkout', { interval: interval === 'year' ? 'year' : 'month' });
      if (d && d.url) location.href = d.url;
      else throw new Error('No checkout link returned');
    } catch (e) { toast('Checkout failed: ' + e.message, 'err'); }
  }

  async function portal() {
    if (!available()) { toast('Sign in first', 'warn'); return; }
    toast('Opening billing…');
    try {
      const d = await invoke('portal');
      if (d && d.url) location.href = d.url;
      else throw new Error('No billing link returned');
    } catch (e) { toast('Billing portal failed: ' + e.message, 'err'); }
  }

  // Returning from Stripe Checkout: the webhook may land a few seconds after
  // the redirect, so poll status briefly until the entitlement shows up.
  async function afterCheckoutReturn() {
    toast('Payment received — activating Black Ink Plus…', 'ok');
    for (let i = 0; i < 8; i++) {
      await load();
      if (entitled()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (typeof render === 'function') render();
    if (entitled()) toast('Black Ink Plus is active — connect your accounts from the Accounts tab', 'ok');
  }

  window.BlackInkBilling = { load, entitled, info, checkout, portal, afterCheckoutReturn, available };
})();
