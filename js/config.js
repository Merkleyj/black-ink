/* =====================================================================
   Black Ink — configuration
   ---------------------------------------------------------------------
   Fill in the two values from your Supabase project:
     Supabase Dashboard → Project Settings → Data API (or API)
       • Project URL   → SUPABASE_URL
       • anon / public → SUPABASE_ANON_KEY

   The anon key is SAFE to commit and expose publicly — Row-Level Security
   (see supabase/schema.sql) is what actually protects each user's data.
   Never put the `service_role` key here.

   Local override: if you prefer not to commit these, copy this file to
   js/config.local.js (git-ignored) and load that instead in index.html.
   ===================================================================== */
window.BLACKINK_CONFIG = {
  SUPABASE_URL: 'YOUR_SUPABASE_URL',        // e.g. https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',

  // Where Supabase should send users back after OAuth / magic-link sign-in.
  // Leave null to use the current page's URL automatically (recommended —
  // works for both http://localhost and your GitHub Pages URL).
  REDIRECT_URL: null,
};

// True once real credentials have been filled in. When false, the app runs
// in local-only mode (no accounts, no cloud sync) so it still works offline.
window.BLACKINK_CLOUD_ENABLED = (function () {
  const c = window.BLACKINK_CONFIG;
  return !!(c && c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
    c.SUPABASE_URL.indexOf('YOUR_') !== 0 &&
    c.SUPABASE_ANON_KEY.indexOf('YOUR_') !== 0);
})();
