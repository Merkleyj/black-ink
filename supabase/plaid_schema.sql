-- =====================================================================
-- Black Ink — Plaid link storage
-- Run once in Supabase (SQL Editor). Stores one row per linked bank "item"
-- with its Plaid access token and sync cursor.
--
-- SECURITY: RLS is enabled with NO policies, so the browser (anon /
-- authenticated roles) can never read these tokens. Only the Plaid Edge
-- Function — which uses the service_role key — can access them.
-- =====================================================================
create table if not exists public.plaid_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  item_id      text not null,
  access_token text not null,
  institution  text,
  cursor       text,
  created_at   timestamptz not null default now(),
  unique (user_id, item_id)
);

alter table public.plaid_items enable row level security;
-- (intentionally no policies — service_role bypasses RLS; clients get nothing)
