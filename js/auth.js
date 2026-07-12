/* =====================================================================
   Black Ink — auth + app bootstrap
   ---------------------------------------------------------------------
   Owns: service-worker registration, Supabase client + session, the
   sign-in screen, the account chip, and gating the app's boot() on auth.
   If cloud isn't configured (js/config.js still has placeholders) or the
   user chooses "local only", the app boots straight into localStorage mode.
   ===================================================================== */
(function () {
  'use strict';

  const CFG = window.BLACKINK_CONFIG || {};
  const CLOUD = !!window.BLACKINK_CLOUD_ENABLED;
  const LOCAL_ONLY_KEY = 'blackink_local_only';

  let sb = null;          // Supabase client
  let booted = false;     // has the app's boot() run yet?
  let currentUser = null;

  /* ---------------- service worker ---------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // Skip on file:// — SW requires http(s).
    if (location.protocol === 'file:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* ---------------- boot helpers ---------------- */
  async function runAppBoot() {
    if (booted) { return; }
    booted = true;
    await window.__blackInkBoot();          // the app's original boot()
  }
  async function reloadState() {
    // Re-pull cloud state into S and re-render (used after a fresh sign-in
    // when the app has already booted for a previous session/local mode).
    if (typeof loadState === 'function') {
      await loadState();
      if (typeof buildAcctFilter === 'function') buildAcctFilter();
      if (typeof render === 'function') render();
    }
  }

  /* ---------------- persist badge → cloud status ---------------- */
  function paintStatus(kind) {
    const dot = document.getElementById('persistDot');
    const txt = document.getElementById('persistText');
    if (!dot || !txt) return;
    dot.classList.remove('off');
    let label = 'Saved to this browser', off = false;
    if (CLOUD && currentUser) {
      switch (kind) {
        case 'syncing': label = 'Syncing…'; break;
        case 'offline': label = 'Offline — will sync'; off = true; break;
        case 'error':   label = 'Sync error — will retry'; off = true; break;
        case 'synced':
        default:        label = 'Synced to cloud'; break;
      }
    } else if (CLOUD) {
      label = 'Not signed in'; off = true;
    }
    if (off) dot.classList.add('off');
    txt.textContent = label;
  }

  /* ---------------- account chip in sidebar ---------------- */
  function renderAccountChip() {
    const foot = document.querySelector('.sidebar .foot');
    if (!foot) return;
    let chip = document.getElementById('acctChip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'acctChip';
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--line)';
      foot.insertBefore(chip, foot.firstChild);
    }
    if (currentUser) {
      const email = esc(currentUser.email || 'Account');
      const initial = (currentUser.email || '?').trim().charAt(0).toUpperCase();
      chip.innerHTML =
        `<div style="width:26px;height:26px;border-radius:50%;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:0 0 auto">${esc(initial)}</div>` +
        `<div style="min-width:0;flex:1"><div style="font-size:12px;color:var(--ink);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${email}</div></div>` +
        `<button class="icon-btn" title="Sign out" onclick="BlackInkApp.signOut()" style="margin:0;width:26px;height:26px">⎋</button>`;
      chip.style.display = 'flex';
    } else if (CLOUD) {
      chip.innerHTML =
        `<button class="btn sm primary" style="width:100%" onclick="BlackInkApp.showAuth()">Sign in to sync</button>`;
      chip.style.display = 'flex';
    } else {
      chip.style.display = 'none';
    }
  }

  /* ---------------- sign-in screen ---------------- */
  function ensureAuthStyles() {
    if (document.getElementById('authStyles')) return;
    const s = document.createElement('style');
    s.id = 'authStyles';
    s.textContent = `
      #authScreen{position:fixed;inset:0;z-index:9000;background:var(--paper);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
      #authScreen .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-lg);width:100%;max-width:400px;padding:30px 30px 26px}
      #authScreen .brand-row{display:flex;align-items:center;gap:11px;margin-bottom:6px}
      #authScreen .brand-row .mark{width:38px;height:38px;border-radius:11px;background:var(--blue);display:flex;align-items:center;justify-content:center;color:#fff}
      #authScreen .brand-row .mark svg{width:22px;height:22px}
      #authScreen h1{font-size:21px;margin:0}
      #authScreen .sub{color:var(--muted);font-size:13px;margin:2px 0 20px}
      #authScreen .seg{display:flex;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:3px;margin-bottom:18px}
      #authScreen .seg button{flex:1;border:0;background:none;color:var(--muted);font-size:13px;font-weight:600;padding:8px;border-radius:8px;cursor:pointer}
      #authScreen .seg button.on{background:var(--surface);color:var(--blue);box-shadow:var(--shadow)}
      #authScreen label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:12px 0 5px}
      #authScreen input{width:100%;font-size:14px;padding:10px 11px}
      #authScreen .btn.primary{width:100%;justify-content:center;padding:11px;font-size:14px;margin-top:18px}
      #authScreen .oauth{width:100%;justify-content:center;gap:9px;padding:10px;font-size:13.5px;margin-top:10px}
      #authScreen .divider{display:flex;align-items:center;gap:10px;color:var(--muted-2);font-size:11px;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.06em}
      #authScreen .divider::before,#authScreen .divider::after{content:"";flex:1;height:1px;background:var(--line)}
      #authScreen .msg{font-size:13px;margin-top:14px;padding:10px 12px;border-radius:9px;display:none}
      #authScreen .msg.err{display:block;background:var(--red-soft);color:var(--red)}
      #authScreen .msg.ok{display:block;background:var(--teal-soft);color:var(--teal)}
      #authScreen .foot-link{text-align:center;margin-top:18px;font-size:12.5px}
      #authScreen .foot-link a{color:var(--muted);cursor:pointer}
    `;
    document.head.appendChild(s);
  }

  const MARK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M7 14l4-4 3 3 5-6"></path></svg>';
  const GOOGLE_SVG = '<svg width="17" height="17" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6.1C12.2 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16z"/><path fill="#FBBC05" d="M10.3 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.8-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.3-4.5 2.1-7.9 2.1-6.4 0-11.8-3.7-13.7-9.4l-7.8 6.1C6.4 42.6 14.6 48 24 48z"/></svg>';

  let authMode = 'signin';

  function showAuth() {
    ensureAuthStyles();
    let el = document.getElementById('authScreen');
    if (!el) { el = document.createElement('div'); el.id = 'authScreen'; document.body.appendChild(el); }
    el.style.display = 'flex';
    paintAuth();
  }
  function hideAuth() { const el = document.getElementById('authScreen'); if (el) el.style.display = 'none'; }

  function paintAuth() {
    const el = document.getElementById('authScreen');
    if (!el) return;
    const isUp = authMode === 'signup';
    el.innerHTML = `
      <div class="card">
        <div class="brand-row"><div class="mark">${MARK_SVG}</div><h1>Black Ink</h1></div>
        <p class="sub">Your personal finances, synced securely across devices.</p>
        <div class="seg">
          <button class="${!isUp ? 'on' : ''}" onclick="BlackInkApp._mode('signin')">Sign in</button>
          <button class="${isUp ? 'on' : ''}" onclick="BlackInkApp._mode('signup')">Create account</button>
        </div>
        <label for="authEmail">Email</label>
        <input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com">
        <label for="authPass">Password</label>
        <input id="authPass" type="password" autocomplete="${isUp ? 'new-password' : 'current-password'}" placeholder="${isUp ? 'At least 6 characters' : 'Your password'}">
        <button class="btn primary" onclick="BlackInkApp._emailAuth()">${isUp ? 'Create account' : 'Sign in'}</button>
        <div class="divider">or</div>
        <button class="btn oauth" onclick="BlackInkApp._google()">${GOOGLE_SVG}Continue with Google</button>
        <button class="btn oauth" onclick="BlackInkApp._magic()">✉️ Email me a magic link</button>
        <div class="msg" id="authMsg"></div>
        <div class="foot-link"><a onclick="BlackInkApp._localOnly()">Use without an account (this device only)</a></div>
      </div>`;
    const email = document.getElementById('authEmail');
    if (email) { email.focus(); email.addEventListener('keydown', enterToSubmit); }
    const pass = document.getElementById('authPass');
    if (pass) pass.addEventListener('keydown', enterToSubmit);
  }
  function enterToSubmit(e) { if (e.key === 'Enter') BlackInkApp._emailAuth(); }

  function authMsg(text, kind) {
    const m = document.getElementById('authMsg');
    if (!m) return;
    m.className = 'msg ' + (kind || '');
    m.textContent = text || '';
  }
  function redirectUrl() {
    if (CFG.REDIRECT_URL) return CFG.REDIRECT_URL;
    return location.origin + location.pathname; // drop any hash/query
  }

  /* ---------------- auth actions ---------------- */
  async function emailAuth() {
    const email = (document.getElementById('authEmail') || {}).value || '';
    const pass = (document.getElementById('authPass') || {}).value || '';
    if (!email.trim()) { authMsg('Enter your email.', 'err'); return; }
    if (pass.length < 6) { authMsg('Password must be at least 6 characters.', 'err'); return; }
    authMsg('Working…');
    try {
      if (authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: email.trim(), password: pass, options: { emailRedirectTo: redirectUrl() } });
        if (error) throw error;
        if (data.session) { authMsg('Account created.', 'ok'); }
        else { authMsg('Check your email to confirm your account, then sign in.', 'ok'); }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pass });
        if (error) throw error;
      }
    } catch (e) { authMsg(e.message || 'Something went wrong.', 'err'); }
  }
  async function google() {
    authMsg('Redirecting to Google…');
    try {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
      if (error) throw error;
    } catch (e) { authMsg(e.message || 'Google sign-in failed.', 'err'); }
  }
  async function magic() {
    const email = (document.getElementById('authEmail') || {}).value || '';
    if (!email.trim()) { authMsg('Enter your email first, then request a link.', 'err'); return; }
    authMsg('Sending…');
    try {
      const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirectUrl() } });
      if (error) throw error;
      authMsg('Magic link sent — check your email.', 'ok');
    } catch (e) { authMsg(e.message || 'Could not send link.', 'err'); }
  }
  function localOnly() {
    try { localStorage.setItem(LOCAL_ONLY_KEY, '1'); } catch (e) {}
    hideAuth();
    renderAccountChip();
    runAppBoot();
  }
  async function signOut() {
    try { if (sb) await sb.auth.signOut(); } catch (e) {}
    // Leave the local cache in place so the user keeps working offline/local.
  }

  /* ---------------- session wiring ---------------- */
  async function onSignedIn(session) {
    currentUser = session.user;
    try { localStorage.removeItem(LOCAL_ONLY_KEY); } catch (e) {}
    BlackInkSync.setUser(currentUser);
    hideAuth();
    // Clean the OAuth/magic-link tokens out of the URL bar.
    if (location.hash && /access_token|refresh_token|type=/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (!booted) { await runAppBoot(); }
    else { await reloadState(); }
    renderAccountChip();
    paintStatus('synced');
  }
  function onSignedOut() {
    currentUser = null;
    BlackInkSync.setUser(null);
    renderAccountChip();
    const content = document.getElementById('content');
    if (content) content.innerHTML = '';
    showAuth();
  }

  /* ---------------- entry point ---------------- */
  async function start() {
    registerSW();

    // Neutralize the app's local-only badge updater; we drive the badge.
    try { updatePersistBadge = function () { paintStatus(); }; } catch (e) {}

    if (!CLOUD) {
      // Cloud not configured → pure local mode (still fully persistent via localStorage).
      await runAppBoot();
      paintStatus();
      return;
    }

    // Build the client and wire sync.
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    BlackInkSync.init(sb);
    BlackInkSync.installStoreBridge();
    BlackInkSync.attachNetworkListeners();
    BlackInkSync.onStatus = paintStatus;

    // React to future auth changes (magic link, OAuth return, sign-out).
    sb.auth.onAuthStateChange((event, session) => {
      if (session && session.user) { onSignedIn(session); }
      else if (event === 'SIGNED_OUT') { onSignedOut(); }
    });

    const { data } = await sb.auth.getSession();
    if (data && data.session) {
      await onSignedIn(data.session);
    } else if (localStorage.getItem(LOCAL_ONLY_KEY)) {
      // User previously chose local-only; respect it but let them sign in later.
      await runAppBoot();
      renderAccountChip();
      paintStatus();
    } else {
      showAuth();
    }
  }

  window.BlackInkApp = {
    start,
    showAuth,
    signOut,
    _mode(m) { authMode = m; paintAuth(); },
    _emailAuth: emailAuth,
    _google: google,
    _magic: magic,
    _localOnly: localOnly,
  };
})();
