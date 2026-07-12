/* =====================================================================
   Black Ink — cloud sync engine
   ---------------------------------------------------------------------
   The app keeps its entire state in one object `S`, serialized under the
   key STORAGE_KEY via the global `Store` (defined in index.html). This
   module wraps Store so that:
     • every local write still goes to localStorage  → instant offline cache
     • the same write is debounced-pushed to Supabase → one JSONB row/user
     • on load we pull the cloud row and reconcile it with the local cache
   Conflict policy: last-write-wins, but the losing copy is always kept as a
   timestamped local backup so nothing is silently destroyed.
   Cross-device: each device stamps its writes; a newer cloud revision that
   this device hasn't seen is adopted (local backup kept first).
   ===================================================================== */
(function () {
  'use strict';

  const TABLE = 'user_data';
  const META_KEY = 'blackink_sync_meta';        // { revision, dirty, deviceId }
  const BACKUP_PREFIX = 'blackink_backup_';      // timestamped safety copies
  const PUSH_DEBOUNCE = 800;

  const Sync = {
    client: null,
    user: null,
    online: (typeof navigator === 'undefined') ? true : navigator.onLine,
    _pushTimer: null,
    _origGet: null,
    _origSet: null,
    _lastPushedValue: null,
    onStatus: null,   // callback(statusString) set by auth.js for the badge
  };

  /* ---------- small local-storage helpers ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  function deviceId() {
    let id = lsGet('blackink_device_id');
    if (!id) { id = 'dev_' + Math.random().toString(36).slice(2, 10); lsSet('blackink_device_id', id); }
    return id;
  }
  function getMeta() {
    try { return JSON.parse(lsGet(META_KEY)) || {}; } catch (e) { return {}; }
  }
  function setMeta(patch) {
    const m = Object.assign(getMeta(), patch);
    lsSet(META_KEY, JSON.stringify(m));
    return m;
  }
  function backup(label, jsonString) {
    // Keep a safety copy of a state we're about to overwrite. Cap history.
    try {
      lsSet(BACKUP_PREFIX + label + '_' + Date.now(), jsonString);
      const keys = Object.keys(localStorage).filter((k) => k.indexOf(BACKUP_PREFIX) === 0).sort();
      while (keys.length > 8) { localStorage.removeItem(keys.shift()); }
    } catch (e) {}
  }

  function status(s) { if (typeof Sync.onStatus === 'function') Sync.onStatus(s); }

  /* ---------- Supabase row I/O ---------- */
  async function fetchRow() {
    const { data, error } = await Sync.client
      .from(TABLE)
      .select('state, revision, updated_at, device_id')
      .eq('user_id', Sync.user.id)
      .maybeSingle();
    if (error) throw error;
    return data; // null if no row yet
  }

  async function upsertRow(stateObj, revision) {
    const row = {
      user_id: Sync.user.id,
      state: stateObj,
      revision: revision,
      device_id: deviceId(),
    };
    const { error } = await Sync.client.from(TABLE).upsert(row, { onConflict: 'user_id' });
    if (error) throw error;
  }

  /* ---------- public: attach a user (or null on sign-out) ---------- */
  Sync.setUser = function (user) { Sync.user = user || null; };
  Sync.init = function (client) { Sync.client = client; };

  /* ---------- push (debounced) ---------- */
  Sync.schedulePush = function () {
    clearTimeout(Sync._pushTimer);
    Sync._pushTimer = setTimeout(() => { Sync.pushNow().catch(() => {}); }, PUSH_DEBOUNCE);
  };

  Sync.pushNow = async function () {
    if (!Sync.client || !Sync.user) return false;
    const localStr = lsGet(STORAGE_KEY);
    if (localStr == null) return false;
    if (!Sync.online) { setMeta({ dirty: true }); status('offline'); return false; }
    let obj;
    try { obj = JSON.parse(localStr); } catch (e) { return false; }
    const meta = getMeta();
    const nextRev = (Number(meta.revision) || 0) + 1;
    try {
      status('syncing');
      await upsertRow(obj, nextRev);
      setMeta({ revision: nextRev, dirty: false });
      Sync._lastPushedValue = localStr;
      status('synced');
      return true;
    } catch (e) {
      setMeta({ dirty: true });
      status('error');
      return false;
    }
  };

  /* ---------- pull + reconcile (called by the wrapped Store.get) ---------- */
  async function pullReconcile() {
    const localStr = lsGet(STORAGE_KEY);          // may be null (fresh device)
    const meta = getMeta();
    let row = null;
    try { row = await fetchRow(); }
    catch (e) { status('offline'); return localStr; }   // offline / error → use local cache

    // No cloud row yet: this is the first sync for the account.
    if (!row) {
      if (localStr) {
        // Seed the cloud from whatever is already on this device.
        try { await upsertRow(JSON.parse(localStr), (Number(meta.revision) || 0) + 1); setMeta({ revision: (Number(meta.revision) || 0) + 1, dirty: false }); status('synced'); }
        catch (e) { setMeta({ dirty: true }); status('error'); }
      }
      return localStr;
    }

    const cloudStr = JSON.stringify(row.state);
    const cloudRev = Number(row.revision) || 0;
    const knownRev = Number(meta.revision) || 0;

    // Case A: we have unsynced local edits (dirty) that the cloud hasn't seen.
    if (meta.dirty && localStr && localStr !== cloudStr) {
      // Keep local (last-write-wins for the active device); stash cloud first.
      backup('cloud', cloudStr);
      try { await upsertRow(JSON.parse(localStr), cloudRev + 1); setMeta({ revision: cloudRev + 1, dirty: false }); status('synced'); }
      catch (e) { setMeta({ dirty: true }); status('error'); }
      return localStr;
    }

    // Case B: cloud is ahead of what this device last saw → adopt cloud.
    if (cloudRev >= knownRev) {
      if (localStr && localStr !== cloudStr) backup('local', localStr); // never lose the local copy
      lsSet(STORAGE_KEY, cloudStr);
      setMeta({ revision: cloudRev, dirty: false });
      status('synced');
      return cloudStr;
    }

    // Case C: local cache matches / is current.
    status('synced');
    return localStr || cloudStr;
  }

  /* ---------- install the Store bridge ---------- */
  Sync.installStoreBridge = function () {
    if (Sync._origGet) return;                     // already installed
    Sync._origGet = Store.get.bind(Store);
    Sync._origSet = Store.set.bind(Store);

    Store.get = async function (key) {
      // Only the main state key is cloud-synced; everything else stays local.
      if (key !== STORAGE_KEY || !Sync.client || !Sync.user) {
        return Sync._origGet(key);
      }
      try {
        const resolved = await pullReconcile();
        if (resolved != null) { PERSIST = true; return resolved; }
      } catch (e) {}
      return Sync._origGet(key);
    };

    Store.set = async function (key, value) {
      // Always write the local cache first (offline-safe, instant).
      const ok = await Sync._origSet(key, value);
      if (key === STORAGE_KEY && Sync.client && Sync.user) {
        setMeta({ dirty: true });
        Sync.schedulePush();
      }
      return ok;
    };
  };

  /* ---------- online/offline flush ---------- */
  Sync.attachNetworkListeners = function () {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => {
      Sync.online = true;
      if (getMeta().dirty) Sync.pushNow().catch(() => {});
      else status('synced');
    });
    window.addEventListener('offline', () => { Sync.online = false; status('offline'); });
  };

  window.BlackInkSync = Sync;
})();
