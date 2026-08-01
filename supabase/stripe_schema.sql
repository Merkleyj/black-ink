-- =====================================================================
-- Black Ink — subscription storage (Black Ink Plus via Stripe)
-- Run once in Supabase (SQL Editor). One row per user; written ONLY by
-- the stripe / stripe-webhook Edge Functions (service role). The browser
-- may read its own row so the UI can show plan status — never write.
--
-- status values:
--   'comp'      — complimentary access (granted manually; Stripe never touches it)
--   'active' | 'trialing' | 'past_due'          — entitled (Stripe-managed)
--   'canceled' | 'unpaid' | 'incomplete' | ...  — not entitled
-- =====================================================================
create table if not exists public.subscriptions (
  user_id               uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id    text,
  stripe_subscription_id text,
  status                text not null default 'none',
  price_id              text,
  price_interval        text,           -- 'month' | 'year'
  cancel_at_period_end  boolean not null default false,
  current_period_end    timestamptz,
  updated_at            timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- Users can see their own subscription status; only service role writes.
drop policy if exists "own subscription readable" on public.subscriptions;
create policy "own subscription readable" on public.subscriptions
  for select using (auth.uid() = user_id);
