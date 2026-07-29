/* =====================================================================
   Black Ink — Plaid connect (frontend)
   Drives Plaid Link, calls the `plaid` Edge Function, and maps the returned
   data into the app's model: depository/credit accounts → S.accounts +
   S.transactions (dedup + auto-categorization), loans + liabilities data →
   S.debts (balance, APR, min payment, due day), investment accounts +
   holdings → S.investments. Also: silent auto-sync on app open (6h throttle)
   and Link update-mode reconnect for expired bank logins.
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
      onExit: linkExit('Link'),
      onEvent: linkEvent,
    });
    handler.open();
  }

  // Surface the real Plaid Link error instead of a silent close, and keep a
  // console trail of Link events for debugging production institutions.
  function linkExit(label) {
    return (err, metadata) => {
      if (!err) return;
      console.warn('[plaid] ' + label + ' exit', err, metadata);
      toast(label + ' error: ' + (err.display_message || err.error_message || err.error_code || 'closed unexpectedly'), 'err');
    };
  }
  function linkEvent(name, metadata) {
    console.debug('[plaid] event', name, metadata && (metadata.error_code || metadata.view_name || ''));
  }

  /* ---------- sync + mapping ---------- */
  async function syncNow(fromLink) {
    if (!available()) { toast('Sign in first', 'warn'); return; }
    const btn = document.getElementById('plaidSyncBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    try {
      const data = await invoke('sync');
      const res = mapPlaidData(data);
      S.plaidLastSync = Date.now();
      save(); render();
      if ((S.plaidReauth || []).length) toast('A bank connection needs to be reconnected — see the Accounts tab', 'warn');
      else toast(`Synced — ${res.imported} new, ${res.updated} updated${res.removed ? ', ' + res.removed + ' removed' : ''}`, 'ok');
    } catch (e) {
      toast('Sync failed: ' + e.message, 'err');
    } finally {
      const b = document.getElementById('plaidSyncBtn'); if (b) { b.disabled = false; b.textContent = 'Sync now'; }
    }
  }

  function hasLinks() {
    return (S.accounts || []).some(a => a.plaidAccountId) ||
           (S.debts || []).some(d => d.plaidAccountId) ||
           (S.investments || []).some(i => i.plaidAccountId);
  }

  // Silent background sync on app open (at most once per 6 hours).
  async function maybeAutoSync() {
    if (typeof S === 'undefined' || !S) return;
    if (!available() || !hasLinks()) return;
    if (Date.now() - (Number(S.plaidLastSync) || 0) < 6 * 3600e3) return;
    try {
      const data = await invoke('sync');
      const res = mapPlaidData(data);
      S.plaidLastSync = Date.now();
      save();
      if (res.imported || res.updated || res.removed || (S.plaidReauth || []).length) {
        render();
        if ((S.plaidReauth || []).length) toast('A bank connection needs to be reconnected — see the Accounts tab', 'warn');
        else toast(`Bank sync — ${res.imported} new transaction${res.imported === 1 ? '' : 's'}`, 'ok');
      }
    } catch (e) { /* silent: manual Sync now still surfaces errors */ }
  }

  // Re-auth an expired bank login via Plaid Link update mode.
  async function reconnect(itemId) {
    if (!available()) { toast('Sign in first', 'warn'); return; }
    toast('Preparing reconnection…');
    let linkToken;
    try { linkToken = (await invoke('link_token', { item_id: itemId })).link_token; }
    catch (e) { toast('Reconnect failed: ' + e.message, 'err'); return; }
    try { await loadScript(); } catch (e) { toast(e.message, 'err'); return; }
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async () => {
        S.plaidReauth = (S.plaidReauth || []).filter(r => r.item_id !== itemId);
        save();
        await syncNow();
      },
      onExit: linkExit('Reconnect'),
      onEvent: linkEvent,
    });
    handler.open();
  }

  function acctTypeFromPlaid(a) {
    if (a.type === 'credit') return 'credit';
    if (a.type === 'depository') return a.subtype === 'savings' ? 'savings' : (a.subtype === 'cash management' ? 'cash' : 'checking');
    return 'checking';
  }
  function debtTypeFromPlaid(a) {
    const s = a.subtype || '';
    if (s === 'student') return 'student';
    if (s === 'mortgage' || s === 'home equity') return 'mortgage';
    if (s === 'auto') return 'auto';
    return 'personal';
  }
  function invTypeFromPlaid(a) {
    const s = a.subtype || '';
    if (s.includes('roth')) return 'roth';
    if (s.includes('401k') || s.includes('401a') || s.includes('403')) return '401k';
    if (s.includes('ira')) return 'ira';
    if (s === 'hsa') return 'hsa';
    if (s === 'brokerage' || s === 'mutual fund' || s === 'stock plan') return 'brokerage';
    return 'other';
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

  // Loan accounts become Debt entries (never S.accounts — totalDebt() would
  // double count a loan that existed in both places).
  function ensureDebt(pa) {
    let d = S.debts.find(x => x.plaidAccountId === pa.account_id);
    if (!d) {
      const bal = pa.balances ? Math.abs(pa.balances.current != null ? pa.balances.current : (pa.balances.available || 0)) : 0;
      d = {
        id: uid('debt'), name: pa.name || pa.official_name || 'Linked loan', lender: '',
        type: debtTypeFromPlaid(pa), originalPrincipal: bal, currentBalance: bal,
        apr: 0, rateType: 'fixed', minPayment: 0, dueDay: 1, creditLimit: '', promoRate: '',
        promoExpiration: '', capitalization: '', startDate: '', termMonths: '', notes: '',
        payments: [], plaidAccountId: pa.account_id, linked: true,
      };
      S.debts.push(d);
    }
    if (pa.balances && pa.balances.current != null) d.currentBalance = Math.abs(pa.balances.current);
    return d;
  }

  function ensureInvestment(pa) {
    let inv = S.investments.find(x => x.plaidAccountId === pa.account_id);
    if (!inv) {
      inv = { id: uid('inv'), name: pa.name || pa.official_name || 'Linked investment', type: invTypeFromPlaid(pa), holdings: [], plaidAccountId: pa.account_id, linked: true };
      S.investments.push(inv);
    }
    return inv;
  }

  function dayFromISO(d) { const n = parseInt(String(d || '').slice(8, 10), 10); return (n >= 1 && n <= 31) ? n : null; }

  function applyLiability(row) {
    const d = S.debts.find(x => x.plaidAccountId === row.account_id);
    if (!d) return; // credit cards live in S.accounts, not S.debts — skip their liability rows
    if (row.kind === 'student') {
      if (row.interest_rate_percentage != null) d.apr = row.interest_rate_percentage;
      if (row.minimum_payment_amount != null) d.minPayment = row.minimum_payment_amount;
      if (row.origination_principal_amount != null) d.originalPrincipal = row.origination_principal_amount;
      const day = dayFromISO(row.next_payment_due_date); if (day) d.dueDay = day;
    } else if (row.kind === 'mortgage') {
      if (row.interest_rate && row.interest_rate.percentage != null) d.apr = row.interest_rate.percentage;
      if (row.next_monthly_payment != null) d.minPayment = row.next_monthly_payment;
      if (row.origination_principal_amount != null) d.originalPrincipal = row.origination_principal_amount;
      const day = dayFromISO(row.next_payment_due_date); if (day) d.dueDay = day;
    }
  }

  function applyHoldings(holdings, securities) {
    if (!holdings || !holdings.length) return;
    const secById = {}; (securities || []).forEach(s => { secById[s.security_id] = s; });
    const byInv = {};
    holdings.forEach(h => { (byInv[h.account_id] = byInv[h.account_id] || []).push(h); });
    Object.keys(byInv).forEach(accountId => {
      const inv = S.investments.find(x => x.plaidAccountId === accountId);
      if (!inv) return;
      inv.holdings = inv.holdings || [];
      const seen = new Set();
      byInv[accountId].forEach(h => {
        const sec = secById[h.security_id] || {};
        seen.add(h.security_id);
        let hold = inv.holdings.find(x => x.plaidSecurityId === h.security_id);
        if (!hold) { hold = { id: uid('h'), plaidSecurityId: h.security_id, activity: [] }; inv.holdings.push(hold); }
        hold.ticker = sec.ticker_symbol || hold.ticker || '';
        hold.name = sec.name || hold.name || '';
        hold.quantity = h.quantity;
        if (h.cost_basis != null) hold.costBasis = h.cost_basis;
        if (h.institution_price != null) hold.currentPrice = h.institution_price;
        if (h.institution_value != null) hold.currentValue = h.institution_value;
        hold.lastValuation = h.institution_price_as_of || toISODate(new Date());
      });
      // drop linked holdings the institution no longer reports (sold); manual rows stay
      inv.holdings = inv.holdings.filter(x => !x.plaidSecurityId || seen.has(x.plaidSecurityId));
    });
  }

  function mapPlaidData(data) {
    const res = { imported: 0, updated: 0, removed: 0 };
    S.debts = S.debts || []; S.investments = S.investments || [];
    S.plaidAccounts = S.plaidAccounts || {};
    // 1) accounts: depository/credit → app accounts; loans → debts; investments → holdings accounts
    const accById = {};
    S.plaidAcctItem = S.plaidAcctItem || {};
    (data.accounts || []).forEach(pa => {
      accById[pa.account_id] = pa;
      if (pa.item_id) S.plaidAcctItem[pa.account_id] = pa.item_id;
      if (pa.type === 'loan') ensureDebt(pa);
      else if (pa.type === 'investment') ensureInvestment(pa);
      else ensureAccount(pa);
    });
    (data.liabilities || []).forEach(applyLiability);
    applyHoldings(data.holdings, data.securities);
    if (data.items) S.plaidItems = data.items;
    S.plaidReauth = data.reauth || [];

    const byPlaidId = new Map(S.transactions.filter(t => t.plaidId).map(t => [t.plaidId, t]));
    const toAppTx = (t) => {
      const inc = Number(t.amount) < 0;               // Plaid: positive = money OUT of the account
      const amt = Math.abs(Number(t.amount) || 0);
      const pa = accById[t.account_id];
      const acctId = S.plaidAccounts[t.account_id] ||
        (pa && pa.type !== 'loan' && pa.type !== 'investment' ? ensureAccount(pa) : null);
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
      if (!tx.accountId) return; // loan/investment account activity isn't imported as transactions
      const fp = (typeof txFingerprint === 'function') ? txFingerprint(tx.accountId, tx.date, tx.description, tx.signed) : null;
      if (fp && S.transactions.some(x => !x.plaidId && typeof txFingerprint === 'function' && txFingerprint(x.accountId, x.date, x.description, x.signed) === fp)) return;
      if (typeof applyRules === 'function') {
        applyRules(tx);
        // Same per-match import behaviors as the CSV path: rules can flag for
        // review or mark recurring, applied at import time only.
        if (tx.ruleApplied) {
          const fr = (S.rules || []).find(r => r.id === tx.ruleApplied);
          if (fr && fr.flagReview) tx.needsReview = true;
          if (fr && fr.markRecurring) tx.recurring = true;
        }
      }
      S.transactions.push(tx); byPlaidId.set(t.transaction_id, tx); res.imported++;
    });

    // 5) reconcile each linked account's starting balance so the shown balance matches Plaid
    (data.accounts || []).forEach(pa => {
      const acctId = S.plaidAccounts[pa.account_id]; if (!acctId) return;
      const acct = S.accounts.find(x => x.id === acctId); if (!acct) return;
      // Depository accounts: prefer `available` (posted minus pending holds) so the
      // shown balance matches the bank app's headline number. Credit accounts must
      // use `current` — their `available` is remaining credit limit, not amount owed.
      const b = pa.balances || {};
      const bal = acct.type === 'credit'
        ? (b.current != null ? b.current : b.available)
        : (b.available != null ? b.available : b.current);
      if (bal == null) return;
      const target = acct.type === 'credit' ? -Math.abs(bal) : bal;   // credit shows as owed (negative)
      const sumSigned = S.transactions.filter(t => t.accountId === acctId).reduce((s, t) => s + (Number(t.signed) || 0), 0);
      acct.startingBalance = target - sumSigned;
      acct.lastUpdated = toISODate(new Date());
    });
    return res;
  }

  async function unlink(itemId) {
    try {
      await invoke('unlink', { item_id: itemId });
      // keep the data, but detach it so it becomes manually managed
      const m = S.plaidAcctItem || {};
      const ofItem = id => m[id] === itemId;
      (S.accounts || []).forEach(a => { if (a.plaidAccountId && ofItem(a.plaidAccountId)) { delete a.plaidAccountId; a.linked = false; } });
      (S.debts || []).forEach(d => { if (d.plaidAccountId && ofItem(d.plaidAccountId)) { delete d.plaidAccountId; d.linked = false; } });
      (S.investments || []).forEach(i => { if (i.plaidAccountId && ofItem(i.plaidAccountId)) { delete i.plaidAccountId; i.linked = false; } });
      S.plaidItems = (S.plaidItems || []).filter(i => i.item_id !== itemId);
      S.plaidReauth = (S.plaidReauth || []).filter(r => r.item_id !== itemId);
      save();
      toast('Bank disconnected — its accounts are now manual', 'ok'); render();
    }
    catch (e) { toast('Could not disconnect: ' + e.message, 'err'); }
  }

  window.BlackInkPlaid = { connectBank, syncNow, unlink, reconnect, maybeAutoSync, hasLinks, available, _map: mapPlaidData };
})();
