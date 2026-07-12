-- =====================================================================
-- Black Ink — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- =====================================================================

-- One row per user. The whole app state (accounts, transactions, budgets,
-- debts, investments, settings, …) is stored as a single JSON blob, matching
-- how the client already keeps everything in one object.
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      jsonb       not null default '{}'::jsonb,
  revision   bigint      not null default 0,   -- bumped on every write; used for conflict detection
  device_id  text,                             -- last device that wrote (informational)
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Keep updated_at fresh on every write.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch
  before update on public.user_data
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row-Level Security: a user can only ever see or change their own row.
-- =====================================================================
alter table public.user_data enable row level security;

drop policy if exists "own row select" on public.user_data;
create policy "own row select"
  on public.user_data for select
  using (auth.uid() = user_id);

drop policy if exists "own row insert" on public.user_data;
create policy "own row insert"
  on public.user_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "own row update" on public.user_data;
create policy "own row update"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own row delete" on public.user_data;
create policy "own row delete"
  on public.user_data for delete
  using (auth.uid() = user_id);
