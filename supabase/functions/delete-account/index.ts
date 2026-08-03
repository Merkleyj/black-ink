// =====================================================================
// Black Ink — account deletion (Supabase Edge Function)
// Permanently deletes the SIGNED-IN user's account, honoring the privacy
// policy's "delete your whole account at any time" promise. Order matters:
// the external teardowns need the tokens/ids that the final cascade wipes.
//   1. Cancel the Stripe subscription immediately (no orphaned billing).
//   2. Plaid /item/remove for every linked item (stops per-item billing
//      and de-authorizes Black Ink at the bank).
//   3. Delete the auth user — user_data, plaid_items and subscriptions
//      rows all cascade (see supabase/*.sql).
// Steps 1–2 are best-effort: a Stripe/Plaid hiccup must not leave the
// user unable to delete their account. Step 3 is the one that must
// succeed for the request to report success.
//
// Requires the caller's JWT (default verify_jwt). Body must carry
// { confirm: "DELETE" } so a stray/forged request can't nuke an account.
// No new secrets — reuses STRIPE_SECRET_KEY and PLAID_*.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const PLAID_ENV = Deno.env.get("PLAID_ENV") ?? "sandbox";
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID") ?? "";
const PLAID_SECRET = Deno.env.get("PLAID_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const { confirm } = await req.json().catch(() => ({}));
    if (confirm !== "DELETE") return json({ error: "Missing confirmation" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE);

    // 1. Stripe: cancel any live subscription right now. Comp rows have no
    //    Stripe subscription; already-canceled ones just error harmlessly.
    try {
      const { data: sub } = await admin.from("subscriptions")
        .select("stripe_subscription_id,status").eq("user_id", user.id).maybeSingle();
      if (STRIPE_KEY && sub?.stripe_subscription_id && sub.status !== "comp") {
        await fetch(`https://api.stripe.com/v1/subscriptions/${sub.stripe_subscription_id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${STRIPE_KEY}` },
        });
      }
    } catch (_e) { /* best effort */ }

    // 2. Plaid: de-authorize every linked institution.
    try {
      const { data: items } = await admin.from("plaid_items").select("access_token").eq("user_id", user.id);
      for (const it of items ?? []) {
        try {
          await fetch(`https://${PLAID_ENV}.plaid.com/item/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: it.access_token }),
          });
        } catch (_e) { /* best effort per item */ }
      }
    } catch (_e) { /* best effort */ }

    // 3. The point of no return: delete the auth user; all rows cascade.
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) return json({ error: "Could not delete account: " + error.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
