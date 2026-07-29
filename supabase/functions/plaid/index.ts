// =====================================================================
// Black Ink — Plaid Edge Function (Supabase, Deno runtime)
// One function, three actions (link_token / exchange / sync). Talks to the
// Plaid REST API directly (no SDK). The Plaid secret NEVER reaches the
// browser; access tokens are stored in the plaid_items table (service-role
// only, RLS locked). Every request is authenticated as the signed-in user.
//
// Required secrets (Project Settings → Edge Functions → Secrets):
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided
//  automatically.)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_ENV = Deno.env.get("PLAID_ENV") ?? "sandbox";
const PLAID_BASE = `https://${PLAID_ENV}.plaid.com`;
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
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

async function plaid(path: string, payload: Record<string, unknown>) {
  const r = await fetch(PLAID_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...payload }),
  });
  const d = await r.json();
  if (!r.ok) {
    const err = new Error(d.error_message || d.error_code || "Plaid error");
    (err as any).code = d.error_code;
    throw err;
  }
  return d;
}
const errCode = (e: unknown) => (e as any)?.code ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Authenticate the caller as a signed-in Black Ink user.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE); // bypasses RLS to store tokens
    const { action, ...body } = await req.json();

    if (action === "link_token") {
      const base = {
        user: { client_user_id: user.id },
        client_name: "Black Ink",
        country_codes: ["US"],
        language: "en",
      };
      if (body.item_id) {
        // Update (re-auth) mode for an existing item: pass its access_token, no products.
        const { data: items } = await admin.from("plaid_items").select("*")
          .eq("user_id", user.id).eq("item_id", body.item_id);
        const it = items?.[0];
        if (!it) return json({ error: "Unknown bank connection" }, 404);
        const d = await plaid("/link/token/create", { ...base, access_token: it.access_token });
        return json({ link_token: d.link_token });
      }
      // optional_products: institutions that lack liabilities/investments stay linkable.
      // days_requested: pull up to 2 years of history (Plaid default is ~90 days).
      const d = await plaid("/link/token/create", {
        ...base,
        products: ["transactions"],
        optional_products: ["liabilities", "investments"],
        transactions: { days_requested: 730 },
      });
      return json({ link_token: d.link_token });
    }

    if (action === "exchange") {
      const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token });
      const accts = await plaid("/accounts/get", { access_token: ex.access_token });
      await admin.from("plaid_items").upsert(
        {
          user_id: user.id,
          item_id: ex.item_id,
          access_token: ex.access_token,
          institution: body.institutionName ?? "",
          cursor: null,
        },
        { onConflict: "user_id,item_id" },
      );
      return json({ item_id: ex.item_id, accounts: accts.accounts });
    }

    if (action === "sync") {
      const { data: items } = await admin.from("plaid_items").select("*").eq("user_id", user.id);
      const out: any = {
        added: [], modified: [], removed: [], accounts: [],
        liabilities: [], holdings: [], securities: [], reauth: [],
        items: (items ?? []).map((i: any) => ({ item_id: i.item_id, institution: i.institution })),
      };
      const needsReauth = (it: any) => {
        if (!out.reauth.some((r: any) => r.item_id === it.item_id)) {
          out.reauth.push({ item_id: it.item_id, institution: it.institution });
        }
      };
      for (const it of items ?? []) {
        try {
          const a = await plaid("/accounts/get", { access_token: it.access_token });
          out.accounts.push(...a.accounts.map((x: any) => ({ ...x, item_id: it.item_id })));
        } catch (e) {
          if (errCode(e) === "ITEM_LOGIN_REQUIRED") { needsReauth(it); continue; }
          /* balances best-effort */
        }
        // Liabilities + investment holdings: best-effort (not every institution/item has them).
        try {
          const l = await plaid("/liabilities/get", { access_token: it.access_token });
          const L = l.liabilities ?? {};
          for (const kind of ["credit", "student", "mortgage"]) {
            for (const row of L[kind] ?? []) out.liabilities.push({ ...row, kind, item_id: it.item_id });
          }
        } catch (_e) { /* product not enabled for this item */ }
        try {
          const h = await plaid("/investments/holdings/get", { access_token: it.access_token });
          out.holdings.push(...(h.holdings ?? []).map((x: any) => ({ ...x, item_id: it.item_id })));
          out.securities.push(...(h.securities ?? []));
        } catch (_e) { /* product not enabled for this item */ }
        let cursor = it.cursor as string | null;
        let hasMore = true;
        // sandbox may report "not ready" briefly right after linking; retry a few times
        let tries = 0;
        while (hasMore) {
          try {
            const d = await plaid("/transactions/sync", { access_token: it.access_token, cursor: cursor ?? undefined, count: 250 });
            out.added.push(...d.added.map((t: any) => ({ ...t, item_id: it.item_id })));
            out.modified.push(...d.modified.map((t: any) => ({ ...t, item_id: it.item_id })));
            out.removed.push(...d.removed);
            cursor = d.next_cursor;
            hasMore = d.has_more;
          } catch (e) {
            if (errCode(e) === "ITEM_LOGIN_REQUIRED") { needsReauth(it); break; }
            if (String(e).includes("PRODUCT_NOT_READY") && tries++ < 6) { await new Promise((r) => setTimeout(r, 2000)); continue; }
            throw e;
          }
        }
        await admin.from("plaid_items").update({ cursor }).eq("id", it.id);
      }
      return json(out);
    }

    if (action === "unlink") {
      const { data: items } = await admin.from("plaid_items").select("*").eq("user_id", user.id).eq("item_id", body.item_id);
      for (const it of items ?? []) { try { await plaid("/item/remove", { access_token: it.access_token }); } catch (_e) {} }
      await admin.from("plaid_items").delete().eq("user_id", user.id).eq("item_id", body.item_id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
