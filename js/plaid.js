/* =====================================================================
   Black Ink — Plaid connect (frontend, Phase 1: sandbox)
   Drives Plaid Link, calls the `plaid` Edge Function, and maps the returned
   accounts + transactions into the app's existing model (S.accounts /
   S.transactions), reusing dedup + auto-categorization rules.
   Requires cloud mode + a signed-in user (the Edge Function is per-user).
   ===================================================================== */
(function () {
  'use strict';
  const LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  let _scriptP = null;

  function client() { return (window.BlackInkSync && BlackInkSync.client) || null; }
  function signedIn() { return !!(window.BlackInkSync && BlackInkSync.user); }
  function available() { return !!(window.BLACKINK_CLOUD_ENABLED && client() && signedIn()); }

  function loadScript() {
    if (window.Plaid) return Promise.resolve();
    if (_scriptP) return _scriptP;
    _scriptP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LINK_SRC; s.onload = res; s.onerror = () => rej(new Error('Could not load Plaid'));
      document.head.appendChild(s);
    });
    return _scriptP;
  }

  async function invoke(action, body) {
    const c = client(); if (!c) throw new Error('Not signed in');
    const { data, error } = await c.functions.invoke('plaid', { body: { action, ...(body || {}) } });
    if (error) {
      // surface the function's JSON error message when present
      let msg = error.message || 'Request failed';
      try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (e) {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  /* ---------- connect flow ---------- */
  async function connectBank() {
    if (!available()) { toast('Sign in to connect a bank', 'warn'); return; }
    toast('Preparing secure connection…');
    let linkToken;
    try { linkToken = (await invoke('link_token')).link_token; }
    catch (e) { toast('Connect failed: ' + e.message, 'err'); return; }
    try { await loadScript(); } catch (e) { toast(e.message, 'err'); return; }
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (public_token, metadata) => {
        try {
          toast('Linking account…');
          await invoke('exchange', { public_token, institutionName: metadata?.institution?.name || '' });
          await syncNow(true);
        } catch (e) { toast('Link failed: ' + e.message, 'err'); }
      },
      onExit: (err) => { if (err) toast('Link cancelled', ''); },
    });
    handler.open();
  }

  /* ---------- sync + mapping ---------- */
  async function syncNow(fromLink) {
    if (!available()) { toast('Sign in first', 'warn'); return; }
    const btn = document.getElementById('plaidSyncBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    try {
      const data = await invoke('sync');
      const res = mapPlaidData(data);
      save(); render();
      toast(`Synced — ${res.imported} new, ${res.updated} updated${res.removed ? ', ' + res.removed + ' removed' : ''}`, 'ok');
    } catch (e) {
      toast('Sync failed: ' + e.message, 'err');
    } finally {
      const b = document.getElementById('plaidSyncBtn'); if (b) { b.disabled = false; b.textContent = 'Sync now'; }
    }
  }

  function acctTypeFromPlaid(a) {
    if (a.type === 'credit') return 'credit';
    if (a.type === 'depository') return a.subtype === 'savings' ? 'savings' : (a.subtype === 'cash management' ? 'cash' : 'checking');
    if (a.type === 'loan') return 'credit';
    return 'checking';
  }

  // Ensure an app account exists for a Plaid account; returns app account id.
  function ensureAccount(pa) {
    S.plaidAccounts = S.plaidAccounts || {};
    let appId = S.plaidAccounts[pa.account_id];
    let acct = appId && S.accounts.find(x => x.id === appId);
    if (!acct) {
      acct = S.accounts.find(x => x.plaidAccountId === pa.account_id);
    }
    if (!acct) {
      acct = {
        id: uid('acct'), name: pa.name || pa.official_name || 'Linked account',
        type: acctTypeFromPlaid(pa), institution: '', startingBalance: 0,
        includeInNetWorth: true, active: true, lastUpdated: toISODate(new Date()),
        balanceHistory: [], plaidAccountId: pa.account_id, linked: true,
      };
      S.accounts.push(acct);
    }
    S.plaidAccounts[pa.account_id] = acct.id;
    return acct.id;
  }

  function mapPlaidData(data) {
    const res = { imported: 0, updated: 0, removed: 0 };
    // 1) accounts (create/link, remember for balance reconciliation)
    const accById = {};
    (data.accounts || []).forEach(pa => { accById[pa.account_id] = pa; ensureAccount(pa); });

    const byPlaidId = new Map(S.transactions.filter(t => t.plaidId).map(t => [t.plaidId, t]));
    const toAppTx = (t) => {
      const inc = Number(t.amount) < 0;               // Plaid: positive = money OUT of the account
      const amt = Math.abs(Number(t.amount) || 0);
      const acctId = S.plaidAccounts[t.account_id] || (accById[t.account_id] && ensureAccount(accById[t.account_id]));
      return {
        id: uid('tx'), plaidId: t.transaction_id, accountId: acctId,
        date: t.date, description: t.name || '', merchant: t.merchant_name || '',
        amount: amt, signed: (inc ? 1 : -1) * amt, kind: inc ? 'income' : 'expense', flow: inc ? 'income' : 'expense',
        pending: !!t.pending, source: 'plaid',
      };
    };

    // 2) removed
    (data.removed || []).forEach(r => {
      const ex = byPlaidId.get(r.transaction_id);
      if (ex) { S.transactions = S.transactions.filter(t => t !== ex); byPlaidId.delete(r.transaction_id); res.removed++; }
    });
    // 3) modified
    (data.modified || []).forEach(t => {
      const ex = byPlaidId.get(t.transaction_id);
      if (ex) { Object.assign(ex, toAppTx(t), { id: ex.id, category: ex.category, subcategory: ex.subcategory, manualCat: ex.manualCat }); res.updated++; }
    });
    // 4) added (skip if we already have this Plaid id, or a matching manual/CSV row)
    (data.added || []).forEach(t => {
      if (byPlaidId.has(t.transaction_id)) return;
      const tx = toAppTx(t);
      const fp = (typeof txFingerprint === 'function') ? txFingerprint(tx.accountId, tx.date, tx.description, tx.signed) : null;
      if (fp && S.transactions.some(x => !x.plaidId && typeof txFingerprint === 'function' && txFingerprint(x.accountId, x.date, x.description, x.signed) === fp)) return;
      if (typeof applyRules === 'function') applyRules(tx);
      S.transactions.push(tx); byPlaidId.set(t.transaction_id, tx); res.imported++;
    });

    // 5) reconcile each linked account's starting balance so the shown balance matches Plaid
    (data.accounts || []).forEach(pa => {
      const acctId = S.plaidAccounts[pa.account_id]; if (!acctId) return;
      const acct = S.accounts.find(x => x.id === acctId); if (!acct) return;
      const bal = pa.balances && (pa.balances.current != null ? pa.balances.current : pa.balances.available);
      if (bal == null) return;
      const target = acct.type === 'credit' ? -Math.abs(bal) : bal;   // credit shows as owed (negative)
      const sumSigned = S.transactions.filter(t => t.accountId === acctId).reduce((s, t) => s + (Number(t.signed) || 0), 0);
      acct.startingBalance = target - sumSigned;
      acct.lastUpdated = toISODate(new Date());
    });
    return res;
  }

  async function unlink(itemId) {
    try { await invoke('unlink', { item_id: itemId }); toast('Bank disconnected', 'ok'); render(); }
    catch (e) { toast('Could not disconnect: ' + e.message, 'err'); }
  }

  window.BlackInkPlaid = { connectBank, syncNow, unlink, available, _map: mapPlaidData };
})();
