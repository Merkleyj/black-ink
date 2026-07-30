// =====================================================================
// Black Ink — Plaid webhook receiver (Supabase Edge Function)
// Plaid POSTs here when an item has fresh data (new transactions, updated
// holdings/liabilities, or item errors). We flag the row in plaid_items;
// the app polls the cheap `status` action and syncs when flagged, so data
// stays fresh without waiting for the 6-hour auto-sync timer.
//
// Deploy with --no-verify-jwt (Plaid sends no Supabase JWT). Safe because
// the handler only flips a boolean on item_ids we already track: an
// unauthenticated caller can at worst cause one redundant sync.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const w = await req.json();
    const itemId = w?.item_id;
    if (itemId && typeof itemId === "string") {
      const admin = createClient(SUPABASE_URL, SERVICE);
      await admin.from("plaid_items")
        .update({ updates_available: true, last_webhook: new Date().toISOString() })
        .eq("item_id", itemId);
    }
  } catch (_e) { /* fall through — always return 2xx so Plaid doesn't retry-storm */ }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
