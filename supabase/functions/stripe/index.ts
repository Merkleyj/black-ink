// =====================================================================
// Black Ink — Stripe Edge Function (Supabase, Deno runtime)
// Two actions for the signed-in user:
//   checkout — create a Stripe Checkout Session for Black Ink Plus
//   portal   — create a Billing Portal session (manage / cancel)
// Talks to the Stripe REST API directly (no SDK). The secret key NEVER
// reaches the browser; card details never touch Black Ink at all —
// checkout and billing management happen on Stripe-hosted pages.
//
// Required secrets (Project Settings → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL
//   APP_URL (optional, default https://blackinkhq.com)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const PRICE_MONTHLY = Deno.env.get("STRIPE_PRICE_MONTHLY") ?? "";
const PRICE_ANNUAL = Deno.env.get("STRIPE_PRICE_ANNUAL") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://blackinkhq.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function stripe(path: string, params: Record<string, string>) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "Stripe error");
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE);
    const { action, ...body } = await req.json();

    // Existing row (may hold a customer id from an earlier checkout attempt).
    const { data: sub } = await admin.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();

    if (action === "checkout") {
      if (sub && ["comp", "active", "trialing", "past_due"].includes(sub.status)) {
        return json({ error: "You already have Black Ink Plus. Manage your plan from Settings." }, 400);
      }
      const price = body.interval === "year" ? PRICE_ANNUAL : PRICE_MONTHLY;
      if (!price) return json({ error: "Billing is not configured yet" }, 500);

      // Reuse the Stripe customer if we made one before; otherwise create it
      // so future sessions and the portal all attach to the same customer.
      let customerId = sub?.stripe_customer_id as string | undefined;
      if (!customerId) {
        const c = await stripe("/customers", {
          email: user.email ?? "",
          "metadata[supabase_user_id]": user.id,
        });
        customerId = c.id;
        await admin.from("subscriptions").upsert(
          { user_id: user.id, stripe_customer_id: customerId, status: sub?.status ?? "none" },
          { onConflict: "user_id" },
        );
      }

      const session = await stripe("/checkout/sessions", {
        mode: "subscription",
        customer: customerId!,
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        allow_promotion_codes: "true",
        success_url: `${APP_URL}/?billing=success`,
        cancel_url: `${APP_URL}/?billing=cancelled`,
        "metadata[supabase_user_id]": user.id,
        // Stamped onto the subscription itself so webhook events can be
        // mapped back to the user without extra lookups.
        "subscription_data[metadata][supabase_user_id]": user.id,
      });
      return json({ url: session.url });
    }

    if (action === "portal") {
      if (!sub?.stripe_customer_id) return json({ error: "No billing account yet" }, 400);
      const session = await stripe("/billing_portal/sessions", {
        customer: sub.stripe_customer_id,
        return_url: `${APP_URL}/`,
      });
      return json({ url: session.url });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
