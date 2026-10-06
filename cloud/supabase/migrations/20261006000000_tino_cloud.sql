-- Tino Cloud: plans, accounts, usage, and the functions the Edge Functions
-- call to spend and refund a user's allowance.
--
-- What the server keeps: the account (plan, billing state, time zone) and
-- usage counts. Never a CV, a posting or a model's reply.
--
-- Who can do what:
-- - Signed-in users can READ their own account and usage, and the plans.
--   Nothing else, and they can't write anything: every change goes through
--   the functions below.
-- - The functions run as their owner (security definer) and only the
--   service role may call them, so the Edge Functions are the only way in.
--   A user calling finish_call() themselves could refund their own quota.

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------

-- Limits and the model per plan, in a table so they can be tuned without a
-- deploy. A null limit means no limit of that kind.
create table public.plans (
  id text primary key,
  -- Evaluations (scoring or summarising a posting) per local day.
  daily_evaluations integer check (daily_evaluations >= 0),
  -- Evaluations per calendar month, in the user's time zone: Pro's fair use.
  monthly_evaluations integer check (monthly_evaluations >= 0),
  -- The setup wizard's helpers (draft a profile, suggest salary or flags).
  daily_helpers integer not null check (daily_helpers >= 0),
  -- Any kind, per rolling hour: a brake on scripts, not on people.
  hourly_calls integer not null check (hourly_calls > 0),
  model text not null,
  -- For reasoning models; null for models that take a temperature instead.
  reasoning_effort text check (reasoning_effort in ('minimal', 'low', 'medium', 'high')),
  -- OpenAI's price per million tokens, in dollars, which is the same number
  -- as micro-dollars per token. Used for the daily spending switch only.
  input_usd_per_m numeric not null check (input_usd_per_m >= 0),
  output_usd_per_m numeric not null check (output_usd_per_m >= 0)
);

insert into public.plans
  (id, daily_evaluations, monthly_evaluations, daily_helpers, hourly_calls, model, reasoning_effort, input_usd_per_m, output_usd_per_m)
values
  ('free', 10, null, 5, 20, 'gpt-6-luna', 'low', 0.1, 0.5),
  ('pro', null, 500, 50, 60, 'gpt-6-sol', 'low', 2, 10);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table public.accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- What was bought. Whether it applies right now is effective_plan().
  plan text not null default 'free' references public.plans (id),
  billing_status text not null default 'none'
    check (billing_status in ('none', 'active', 'on_trial', 'past_due', 'paused', 'cancelled', 'expired')),
  -- End of the paid period. A cancelled subscription keeps Pro until then.
  period_end timestamptz,
  billing_customer_id text,
  billing_subscription_id text,
  -- When the newest billing event applied happened, so an older one arriving
  -- late (webhooks aren't ordered) can't undo it.
  billing_updated_at timestamptz,
  -- "Today" is the user's day: the free allowance refills at their midnight.
  tz text not null default 'UTC',
  tz_set_at timestamptz,
  -- The call in progress, if any: one at a time per user. The lease runs out
  -- on its own if an Edge Function dies before finishing.
  busy_call uuid,
  busy_until timestamptz,
  busy_kind text,
  busy_day date,
  busy_plan text,
  hour_started_at timestamptz,
  hour_calls integer not null default 0,
  created_at timestamptz not null default now()
);

-- A row for every new user, made with the account.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.accounts (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Pro while the subscription is active, on trial, being retried (past due)
-- or cancelled but paid up, and only until its period ends.
create function public.effective_plan(acc public.accounts)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when acc.plan <> 'free'
      and acc.billing_status in ('active', 'on_trial', 'past_due', 'cancelled')
      and (acc.period_end is null or acc.period_end > now())
    then acc.plan
    else 'free'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Usage and spending
-- ---------------------------------------------------------------------------

create table public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The user's local date.
  day date not null,
  evaluations integer not null default 0,
  helpers integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (user_id, day)
);

-- All users together, per UTC day: what the daily spending switch reads.
create table public.spend_daily (
  day date primary key,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micros bigint not null default 0
);

-- Operator switches, as JSON values:
-- - paused: true stops all hosted scoring at once.
-- - daily_spend_limit_usd: hosted scoring pauses for the rest of the UTC day
--   once the day's estimated spend reaches it. Set a matching hard limit on
--   the OpenAI project too; this one is an estimate from token counts.
create table public.app_settings (
  key text primary key,
  value jsonb not null
);

insert into public.app_settings (key, value) values
  ('paused', 'false'),
  ('daily_spend_limit_usd', '25');

-- Billing webhook deliveries already applied, by the provider's event id:
-- a retried delivery is acknowledged and ignored.
create table public.billing_events (
  event_id text primary key,
  kind text,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.plans enable row level security;
alter table public.accounts enable row level security;
alter table public.usage_daily enable row level security;
alter table public.spend_daily enable row level security;
alter table public.app_settings enable row level security;
alter table public.billing_events enable row level security;

create policy "Plans are public"
  on public.plans for select
  to anon, authenticated
  using (true);

create policy "Users read their own account"
  on public.accounts for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users read their own usage"
  on public.usage_daily for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Supabase grants every new table to anon and authenticated; row-level
-- security already stops writes, and this says so twice.
revoke insert, update, delete, truncate on public.plans, public.accounts, public.usage_daily from anon, authenticated;
revoke all on public.spend_daily, public.app_settings, public.billing_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Spending the allowance
-- ---------------------------------------------------------------------------

-- Takes one unit of the user's allowance for a call of p_kind ('evaluation'
-- or 'helper') and leases the user's one call slot. Returns:
--   { ok: true, call_id, plan, model, reasoning_effort, limit, remaining, reset_at }
--   { ok: false, reason, ... } with reason one of:
--     paused   hosted scoring is switched off, or today's spending limit is reached
--     busy     another call of this user's is still running (retry_after seconds)
--     hourly   the hourly brake (reset_at)
--     daily    the day's allowance is used up (reset_at: the user's next midnight)
--     monthly  Pro's monthly fair use is used up (reset_at: the next month)
-- limit/remaining describe the window that applies to this kind: the day's,
-- or the month's for a plan without a daily limit; null when unlimited.
--
-- The account row is locked for the whole check-and-take, so two requests at
-- once can't both take the last unit.
create function public.consume_quota(p_user uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  pl public.plans;
  v_plan text;
  v_now timestamptz := now();
  v_day date;
  v_day_reset timestamptz;
  v_month_start date;
  v_month_reset timestamptz;
  v_used integer;
  v_month_used integer;
  v_limit integer;
  v_remaining integer;
  v_reset timestamptz;
  v_spent bigint;
  v_cap numeric;
  v_call uuid := gen_random_uuid();
begin
  if p_kind not in ('evaluation', 'helper') then
    raise exception 'unknown kind: %', p_kind using errcode = '22023';
  end if;

  if coalesce((select (value #>> '{}')::boolean from public.app_settings where key = 'paused'), false) then
    return jsonb_build_object('ok', false, 'reason', 'paused');
  end if;
  v_cap := (select (value #>> '{}')::numeric from public.app_settings where key = 'daily_spend_limit_usd');
  if v_cap is not null then
    v_spent := coalesce((select cost_micros from public.spend_daily where day = (v_now at time zone 'UTC')::date), 0);
    if v_spent >= v_cap * 1000000 then
      return jsonb_build_object('ok', false, 'reason', 'paused');
    end if;
  end if;

  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user for update;

  if acc.busy_until is not null and acc.busy_until > v_now then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'retry_after', 5);
  end if;

  v_plan := public.effective_plan(acc);
  select * into pl from public.plans where id = v_plan;

  if acc.hour_started_at is null or acc.hour_started_at <= v_now - interval '1 hour' then
    acc.hour_started_at := v_now;
    acc.hour_calls := 0;
  end if;
  if acc.hour_calls >= pl.hourly_calls then
    return jsonb_build_object('ok', false, 'reason', 'hourly', 'plan', v_plan,
      'reset_at', acc.hour_started_at + interval '1 hour');
  end if;

  v_day := (v_now at time zone acc.tz)::date;
  v_day_reset := (v_day + 1)::timestamp at time zone acc.tz;
  v_month_start := date_trunc('month', v_day)::date;
  v_month_reset := (v_month_start + interval '1 month')::date::timestamp at time zone acc.tz;

  insert into public.usage_daily (user_id, day) values (p_user, v_day) on conflict do nothing;

  if p_kind = 'evaluation' then
    select evaluations into v_used from public.usage_daily where user_id = p_user and day = v_day;
    if pl.daily_evaluations is not null and v_used >= pl.daily_evaluations then
      return jsonb_build_object('ok', false, 'reason', 'daily', 'plan', v_plan,
        'limit', pl.daily_evaluations, 'remaining', 0, 'reset_at', v_day_reset);
    end if;
    if pl.monthly_evaluations is not null then
      select coalesce(sum(evaluations), 0) into v_month_used
        from public.usage_daily where user_id = p_user and day >= v_month_start and day <= v_day;
      if v_month_used >= pl.monthly_evaluations then
        return jsonb_build_object('ok', false, 'reason', 'monthly', 'plan', v_plan,
          'limit', pl.monthly_evaluations, 'remaining', 0, 'reset_at', v_month_reset);
      end if;
    end if;
    update public.usage_daily set evaluations = evaluations + 1 where user_id = p_user and day = v_day;

    if pl.daily_evaluations is not null then
      v_limit := pl.daily_evaluations;
      v_remaining := pl.daily_evaluations - v_used - 1;
      v_reset := v_day_reset;
    elsif pl.monthly_evaluations is not null then
      v_limit := pl.monthly_evaluations;
      v_remaining := pl.monthly_evaluations - v_month_used - 1;
      v_reset := v_month_reset;
    end if;
  else
    select helpers into v_used from public.usage_daily where user_id = p_user and day = v_day;
    if v_used >= pl.daily_helpers then
      return jsonb_build_object('ok', false, 'reason', 'daily', 'plan', v_plan,
        'limit', pl.daily_helpers, 'remaining', 0, 'reset_at', v_day_reset);
    end if;
    update public.usage_daily set helpers = helpers + 1 where user_id = p_user and day = v_day;
    v_limit := pl.daily_helpers;
    v_remaining := pl.daily_helpers - v_used - 1;
    v_reset := v_day_reset;
  end if;

  -- Longer than the Edge Function's own time limit, so a lease only ever
  -- runs out on its own when the function died without finishing.
  update public.accounts set
    busy_call = v_call,
    busy_until = v_now + interval '3 minutes',
    busy_kind = p_kind,
    busy_day = v_day,
    busy_plan = v_plan,
    hour_started_at = acc.hour_started_at,
    hour_calls = acc.hour_calls + 1
  where user_id = p_user;

  return jsonb_build_object(
    'ok', true,
    'call_id', v_call,
    'plan', v_plan,
    'model', pl.model,
    'reasoning_effort', pl.reasoning_effort,
    'limit', v_limit,
    'remaining', v_remaining,
    'reset_at', v_reset
  );
end;
$$;

-- Ends the call consume_quota() started: frees the user's slot, records the
-- tokens it used (for the user and for the day's spending), and, when the
-- call failed, gives the unit back. A failure is never the user's cost.
--
-- If the lease had already run out and another call took the slot, the
-- tokens are still recorded but nothing is refunded or freed.
create function public.finish_call(
  p_user uuid,
  p_call uuid,
  p_ok boolean,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  pl public.plans;
  v_mine boolean;
  v_day date;
  v_in bigint := greatest(coalesce(p_input_tokens, 0), 0);
  v_out bigint := greatest(coalesce(p_output_tokens, 0), 0);
  v_cost bigint;
begin
  select * into acc from public.accounts where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;
  v_mine := acc.busy_call is not distinct from p_call and p_call is not null;
  v_day := coalesce(case when v_mine then acc.busy_day end, (now() at time zone acc.tz)::date);

  select * into pl from public.plans
    where id = coalesce(case when v_mine then acc.busy_plan end, public.effective_plan(acc));
  v_cost := round(v_in * pl.input_usd_per_m + v_out * pl.output_usd_per_m);

  insert into public.usage_daily (user_id, day, input_tokens, output_tokens)
    values (p_user, v_day, v_in, v_out)
    on conflict (user_id, day) do update set
      input_tokens = public.usage_daily.input_tokens + excluded.input_tokens,
      output_tokens = public.usage_daily.output_tokens + excluded.output_tokens;

  insert into public.spend_daily (day, input_tokens, output_tokens, cost_micros)
    values ((now() at time zone 'UTC')::date, v_in, v_out, v_cost)
    on conflict (day) do update set
      input_tokens = public.spend_daily.input_tokens + excluded.input_tokens,
      output_tokens = public.spend_daily.output_tokens + excluded.output_tokens,
      cost_micros = public.spend_daily.cost_micros + excluded.cost_micros;

  if not v_mine then
    return jsonb_build_object('ok', false, 'reason', 'not_current');
  end if;

  if not p_ok then
    if acc.busy_kind = 'evaluation' then
      update public.usage_daily set evaluations = greatest(evaluations - 1, 0)
        where user_id = p_user and day = acc.busy_day;
    else
      update public.usage_daily set helpers = greatest(helpers - 1, 0)
        where user_id = p_user and day = acc.busy_day;
    end if;
  end if;

  update public.accounts set
    busy_call = null,
    busy_until = null,
    busy_kind = null,
    busy_day = null,
    busy_plan = null,
    hour_calls = case when p_ok then hour_calls else greatest(hour_calls - 1, 0) end
  where user_id = p_user;

  return jsonb_build_object('ok', true, 'refunded', not p_ok);
end;
$$;

-- ---------------------------------------------------------------------------
-- The account, for the extension's Settings and popup
-- ---------------------------------------------------------------------------

create function public.account_summary(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  pl public.plans;
  v_plan text;
  v_day date;
  v_month_start date;
  u public.usage_daily;
  v_month_used integer;
begin
  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user;
  v_plan := public.effective_plan(acc);
  select * into pl from public.plans where id = v_plan;
  v_day := (now() at time zone acc.tz)::date;
  v_month_start := date_trunc('month', v_day)::date;
  select * into u from public.usage_daily where user_id = p_user and day = v_day;
  select coalesce(sum(evaluations), 0) into v_month_used
    from public.usage_daily where user_id = p_user and day >= v_month_start and day <= v_day;

  return jsonb_build_object(
    'plan', v_plan,
    'purchased_plan', acc.plan,
    'billing_status', acc.billing_status,
    'period_end', acc.period_end,
    'tz', acc.tz,
    'model', pl.model,
    'evaluations', jsonb_build_object(
      'used_today', coalesce(u.evaluations, 0),
      'daily_limit', pl.daily_evaluations,
      'used_this_month', v_month_used,
      'monthly_limit', pl.monthly_evaluations
    ),
    'helpers', jsonb_build_object('used_today', coalesce(u.helpers, 0), 'daily_limit', pl.daily_helpers),
    'day_resets_at', (v_day + 1)::timestamp at time zone acc.tz,
    'month_resets_at', (v_month_start + interval '1 month')::date::timestamp at time zone acc.tz
  );
end;
$$;

-- The user's time zone, which decides when "today" ends. Set freely the
-- first time; after that at most once every 30 days, so hopping time zones
-- can't buy extra days.
create function public.set_timezone(p_user uuid, p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
begin
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user for update;
  if acc.tz = p_tz then
    return jsonb_build_object('ok', true, 'tz', acc.tz);
  end if;
  if acc.tz_set_at is not null and acc.tz_set_at > now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon', 'tz', acc.tz,
      'retry_at', acc.tz_set_at + interval '30 days');
  end if;
  update public.accounts set tz = p_tz, tz_set_at = now() where user_id = p_user;
  return jsonb_build_object('ok', true, 'tz', p_tz);
end;
$$;

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------

-- Applies one billing event, already verified by the webhook. Idempotent:
-- the same event id twice is applied once, and an event older than the last
-- one applied is ignored.
create function public.apply_billing_event(
  p_event_id text,
  p_occurred_at timestamptz,
  p_user uuid,
  p_plan text,
  p_status text,
  p_period_end timestamptz,
  p_customer text default null,
  p_subscription text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
begin
  if not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('applied', false, 'reason', 'unknown_user');
  end if;
  if not exists (select 1 from public.plans where id = p_plan) then
    return jsonb_build_object('applied', false, 'reason', 'unknown_plan');
  end if;

  insert into public.billing_events (event_id, kind) values (p_event_id, p_status) on conflict do nothing;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user for update;
  if acc.billing_updated_at is not null and p_occurred_at < acc.billing_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'stale');
  end if;

  update public.accounts set
    plan = p_plan,
    billing_status = p_status,
    period_end = p_period_end,
    billing_customer_id = coalesce(p_customer, billing_customer_id),
    billing_subscription_id = coalesce(p_subscription, billing_subscription_id),
    billing_updated_at = p_occurred_at
  where user_id = p_user;
  return jsonb_build_object('applied', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the service role (the Edge Functions) may call these.
-- ---------------------------------------------------------------------------

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.effective_plan(public.accounts) from public, anon, authenticated;
revoke execute on function public.consume_quota(uuid, text) from public, anon, authenticated;
revoke execute on function public.finish_call(uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
revoke execute on function public.account_summary(uuid) from public, anon, authenticated;
revoke execute on function public.set_timezone(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_billing_event(text, timestamptz, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;

grant execute on function public.effective_plan(public.accounts) to service_role;
grant execute on function public.consume_quota(uuid, text) to service_role;
grant execute on function public.finish_call(uuid, uuid, boolean, integer, integer) to service_role;
grant execute on function public.account_summary(uuid) to service_role;
grant execute on function public.set_timezone(uuid, text) to service_role;
grant execute on function public.apply_billing_event(text, timestamptz, uuid, text, text, timestamptz, text, text) to service_role;
