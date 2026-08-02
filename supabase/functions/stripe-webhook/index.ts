// =====================================================================
// Black Ink — Stripe webhook receiver (Supabase Edge Function)
// Keeps the subscriptions table in sync with Stripe, which makes it the
// source of truth for Plus entitlements (the plaid function checks it).
//
// Security: deployed with --no-verify-jwt (Stripe sends no Supabase JWT),
// so EVERY request must carry a valid Stripe-Signature header — HMAC
// SHA-256 over `${timestamp}.${payload}` with STRIPE_WEBHOOK_SECRET,
// rejected outside a 5-minute tolerance window.
//
// When a subscription truly ends (canceled / unpaid — not the past_due
// retry window), the user's Plaid items are removed: bank connections
// bill per month while they exist, and imported data stays in the app
// either way (same semantics as a manual disconnect).
//
// Required secrets: STRIPE_WEBHOOK_SECRET (+ PLAID_* already set)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") ?? "sandbox";
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID") ?? "";
const PLAID_SECRET = Deno.env.get("PLAID_SECRET") ?? "";

const ENTITLED = ["active", "trialing", "past_due"];
const TERMINAL = ["canceled", "unpaid", "incomplete_expired"];

async function verifySignature(payload: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  let t = ""; const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;   // replay window
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time-ish comparison
  return sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function stripeGet(path: string) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}` },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "Stripe error");
  return d;
}

// deno-lint-ignore no-explicit-any
function subFields(s: any) {
  const item = s.items?.data?.[0];
  // Newer Stripe API versions moved the period fields from the subscription
  // onto its items — read whichever is present.
  const periodEnd = s.current_period_end ?? item?.current_period_end;
  return {
    stripe_subscription_id: s.id,
    stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id,
    status: s.status,
    price_id: item?.price?.id ?? null,
    price_interval: item?.price?.recurring?.interval ?? null,
    cancel_at_period_end: !!s.cancel_at_period_end,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

// deno-lint-ignore no-explicit-any
async function removePlaidItems(admin: any, userId: string) {
  const { data: items } = await admin.from("plaid_items").select("*").eq("user_id", userId);
  for (const it of items ?? []) {
    try {
      await fetch(`https://${PLAID_ENV}.plaid.com/item/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: it.access_token }),
      });
    } catch (_e) { /* best effort per item */ }
  }
  await admin.from("plaid_items").delete().eq("user_id", userId);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("Stripe-Signature")))) {
    return new Response("bad signature", { status: 400 });
  }
  try {
    const event = JSON.parse(payload);
    const admin = createClient(SUPABASE_URL, SERVICE);
    const obj = event.data?.object ?? {};

    if (event.type === "checkout.session.completed") {
      const userId = obj.metadata?.supabase_user_id;
      if (userId && obj.subscription) {
        const s = await stripeGet(`/subscriptions/${obj.subscription}`);
        await admin.from("subscriptions").upsert({ user_id: userId, ...subFields(s) }, { onConflict: "user_id" });
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      // Map the subscription back to a user: metadata first, customer id as fallback.
      let userId = obj.metadata?.supabase_user_id as string | undefined;
      if (!userId && obj.customer) {
        const { data: row } = await admin.from("subscriptions").select("user_id")
          .eq("stripe_customer_id", typeof obj.customer === "string" ? obj.customer : obj.customer?.id).maybeSingle();
        userId = row?.user_id;
      }
      if (userId) {
        // Never let Stripe events overwrite a complimentary grant.
        const { data: cur } = await admin.from("subscriptions").select("status").eq("user_id", userId).maybeSingle();
        if (cur?.status !== "comp") {
          const fields = subFields(obj);
          if (event.type === "customer.subscription.deleted") fields.status = "canceled";
          await admin.from("subscriptions").upsert({ user_id: userId, ...fields }, { onConflict: "user_id" });
          if (TERMINAL.includes(fields.status) || !ENTITLED.includes(fields.status)) {
            await removePlaidItems(admin, userId);
          }
        }
      }
    }
  } catch (_e) { /* return 200 so Stripe doesn't retry-storm on our bugs; state re-syncs on next event */ }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
