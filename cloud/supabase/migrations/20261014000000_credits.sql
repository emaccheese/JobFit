-- Tino Cloud, credits instead of a daily allowance (2026-10-14).
--
-- Every new account gets a starter credit once ($1 to start, in
-- app_settings). Each call is charged what it actually cost: its tokens at the
-- prices of the effort level the user picked. The user decides how fast the
-- credit goes by choosing the level:
--
--   quick     gpt-6-luna · low      (the default)
--   careful   gpt-6-luna · medium
--   thorough  gpt-6-sol  · low
--   deep      gpt-6-sol  · medium
--
-- Money is in micro-dollars (1,000,000 = $1) as whole numbers, so nothing is
-- lost to rounding in a float. A price per million tokens in dollars is the
-- same number as micro-dollars per token.
--
-- Kept from the first migration: one call at a time per user (the lease), the
-- hourly brake, the operator's pause and the daily spending switch, and that
-- only the service role (the Edge Functions) can call any of this.

-- ---------------------------------------------------------------------------
-- Effort levels
-- ---------------------------------------------------------------------------

create table public.levels (
  id text primary key,
  model text not null,
  reasoning_effort text check (reasoning_effort in ('minimal', 'low', 'medium', 'high')),
  input_usd_per_m numeric not null check (input_usd_per_m >= 0),
  output_usd_per_m numeric not null check (output_usd_per_m >= 0),
  enabled boolean not null default true,
  sort integer not null,
  -- What a call has cost on average, from real calls; until there are some,
  -- the seeded estimate. "About N evaluations left" divides by this.
  est_cost_micros bigint not null check (est_cost_micros > 0),
  avg_cost_micros bigint,
  samples integer not null default 0
);

insert into public.levels (id, model, reasoning_effort, input_usd_per_m, output_usd_per_m, sort, est_cost_micros) values
  ('quick', 'gpt-6-luna', 'low', 0.1, 0.5, 1, 1000),
  ('careful', 'gpt-6-luna', 'medium', 0.1, 0.5, 2, 2000),
  ('thorough', 'gpt-6-sol', 'low', 2, 10, 3, 25000),
  ('deep', 'gpt-6-sol', 'medium', 2, 10, 4, 40000);

alter table public.levels enable row level security;
create policy "Levels are public"
  on public.levels for select
  to anon, authenticated
  using (true);
revoke insert, update, delete, truncate on public.levels from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The balance, and every movement of it
-- ---------------------------------------------------------------------------

alter table public.accounts
  add column credit_micros bigint not null default 0 check (credit_micros >= 0),
  add column starter_granted_at timestamptz,
  -- "Tell me when recharges open": when the user asked, once.
  add column recharge_interest_at timestamptz;

-- Every change to a balance, so it can always be explained:
--   grant    the starter credit (or one given by hand: 'adjust')
--   reserve  taken when a call starts: the most it could cost
--   refund   given back when it ends: the reserve minus what it cost
-- The sum of a user's rows is their balance.
create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('grant', 'reserve', 'refund', 'adjust')),
  amount_micros bigint not null,
  level text,
  call_id uuid,
  -- On a reserve: when its call was settled, so it's settled once.
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

create index credit_ledger_user on public.credit_ledger (user_id, created_at desc);
create unique index credit_ledger_reserve on public.credit_ledger (call_id) where kind = 'reserve';

alter table public.credit_ledger enable row level security;
create policy "Users read their own credit history"
  on public.credit_ledger for select
  to authenticated
  using ((select auth.uid()) = user_id);
revoke insert, update, delete, truncate on public.credit_ledger from anon, authenticated;

insert into public.app_settings (key, value) values ('starter_credit_usd', '1')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The starter credit
-- ---------------------------------------------------------------------------

-- Gives the starter credit once per account. Returns whether it gave it.
create function public.grant_starter_credit(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount bigint;
begin
  v_amount := round(coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'starter_credit_usd'), 0) * 1000000);
  update public.accounts
    set credit_micros = credit_micros + v_amount, starter_granted_at = now()
    where user_id = p_user and starter_granted_at is null;
  if not found then
    return false;
  end if;
  insert into public.credit_ledger (user_id, kind, amount_micros) values (p_user, 'grant', v_amount);
  return true;
end;
$$;

-- New users: the account, then the credit.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.accounts (user_id) values (new.id) on conflict do nothing;
  perform public.grant_starter_credit(new.id);
  return new;
end;
$$;

-- Accounts made before credits existed get theirs too.
select public.grant_starter_credit(user_id) from public.accounts where starter_granted_at is null;

-- ---------------------------------------------------------------------------
-- Starting a call: reserve its most expensive outcome
-- ---------------------------------------------------------------------------

-- The daily-allowance version is replaced: no daily or monthly limits now,
-- the credit is the limit.
drop function public.consume_quota(uuid, text);

-- p_kind is 'evaluation' or 'helper' (still counted per day, for usage);
-- p_level one of `levels`; p_max_input_tokens and p_max_output_tokens the
-- most this call can use, from the request's size and the kind's output cap,
-- which the Edge Function knows.
--
-- Returns { ok: true, call_id, level, model, reasoning_effort, reserved_micros }
-- or { ok: false, reason } with reason one of:
--   paused   hosted scoring is switched off, or today's spending limit is reached
--   busy     another call of this user's is still running (retry_after seconds)
--   hourly   the hourly brake (reset_at)
--   level    no such level, or it's switched off
--   credit   not enough credit left for one call at this level (balance_micros)
create function public.consume_quota(
  p_user uuid,
  p_kind text,
  p_level text,
  p_max_input_tokens integer,
  p_max_output_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  pl public.plans;
  lv public.levels;
  v_now timestamptz := now();
  v_day date;
  v_spent bigint;
  v_cap numeric;
  v_worst bigint;
  v_typical bigint;
  v_reserve bigint;
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

  select * into lv from public.levels where id = p_level and enabled;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'level');
  end if;

  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user for update;

  if acc.busy_until is not null and acc.busy_until > v_now then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'retry_after', 5);
  end if;

  select * into pl from public.plans where id = public.effective_plan(acc);
  if acc.hour_started_at is null or acc.hour_started_at <= v_now - interval '1 hour' then
    acc.hour_started_at := v_now;
    acc.hour_calls := 0;
  end if;
  if acc.hour_calls >= pl.hourly_calls then
    return jsonb_build_object('ok', false, 'reason', 'hourly', 'reset_at', acc.hour_started_at + interval '1 hour');
  end if;

  -- Enough for one typical call at this level, or it's out of credit. The
  -- reserve is the worst case, but never more than what's there: the last
  -- few calls of a balance still go through, charged what's left at most.
  v_typical := coalesce(lv.avg_cost_micros, lv.est_cost_micros);
  if acc.credit_micros < v_typical then
    return jsonb_build_object('ok', false, 'reason', 'credit', 'balance_micros', acc.credit_micros, 'level', lv.id);
  end if;
  v_worst := ceil(greatest(p_max_input_tokens, 0) * lv.input_usd_per_m + greatest(p_max_output_tokens, 0) * lv.output_usd_per_m);
  v_reserve := least(greatest(v_worst, v_typical), acc.credit_micros);

  v_day := (v_now at time zone acc.tz)::date;
  insert into public.usage_daily (user_id, day) values (p_user, v_day) on conflict do nothing;
  if p_kind = 'evaluation' then
    update public.usage_daily set evaluations = evaluations + 1 where user_id = p_user and day = v_day;
  else
    update public.usage_daily set helpers = helpers + 1 where user_id = p_user and day = v_day;
  end if;

  update public.accounts set
    credit_micros = credit_micros - v_reserve,
    busy_call = v_call,
    busy_until = v_now + interval '3 minutes',
    busy_kind = p_kind,
    busy_day = v_day,
    busy_plan = pl.id,
    hour_started_at = acc.hour_started_at,
    hour_calls = acc.hour_calls + 1
  where user_id = p_user;
  insert into public.credit_ledger (user_id, kind, amount_micros, level, call_id)
    values (p_user, 'reserve', -v_reserve, lv.id, v_call);

  return jsonb_build_object(
    'ok', true,
    'call_id', v_call,
    'level', lv.id,
    'model', lv.model,
    'reasoning_effort', lv.reasoning_effort,
    'reserved_micros', v_reserve
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ending a call: charge what it cost, give back the rest
-- ---------------------------------------------------------------------------

-- Settles the call's reserve, once: a call that answered is charged its
-- tokens at its level's prices (never more than was reserved); a call that
-- failed is charged nothing, since a failure is never the user's cost (its
-- tokens still count in spend_daily, which is ours). Also frees the user's
-- slot, records the tokens and, for a call that answered, updates the
-- level's average cost.
--
-- Returns { ok, charged_micros, balance_micros, est_left, level }.
create or replace function public.finish_call(
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
  lv public.levels;
  reserve public.credit_ledger;
  v_in bigint := greatest(coalesce(p_input_tokens, 0), 0);
  v_out bigint := greatest(coalesce(p_output_tokens, 0), 0);
  v_cost bigint := 0;
  v_charge bigint := 0;
  v_refund bigint := 0;
  v_mine boolean;
  v_day date;
  v_balance bigint;
begin
  select * into acc from public.accounts where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;

  select * into reserve from public.credit_ledger
    where call_id = p_call and user_id = p_user and kind = 'reserve' for update;
  if found then
    select * into lv from public.levels where id = reserve.level;
    v_cost := round(v_in * lv.input_usd_per_m + v_out * lv.output_usd_per_m);
  end if;

  -- Tokens, for the user's day and for the day's spending, whatever happened.
  v_mine := acc.busy_call is not distinct from p_call and p_call is not null;
  v_day := coalesce(case when v_mine then acc.busy_day end, (now() at time zone acc.tz)::date);
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

  -- Settle the reserve, once.
  if reserve.id is not null and reserve.settled_at is null then
    v_charge := case when p_ok then least(v_cost, -reserve.amount_micros) else 0 end;
    v_refund := -reserve.amount_micros - v_charge;
    update public.credit_ledger set settled_at = now() where id = reserve.id;
    if v_refund > 0 then
      insert into public.credit_ledger (user_id, kind, amount_micros, level, call_id)
        values (p_user, 'refund', v_refund, reserve.level, p_call);
      update public.accounts set credit_micros = credit_micros + v_refund where user_id = p_user;
    end if;
    -- What a call at this level costs, from the last couple of hundred.
    if p_ok and v_cost > 0 then
      update public.levels set
        avg_cost_micros = round((coalesce(avg_cost_micros, v_cost) * least(samples, 199) + v_cost)::numeric / (least(samples, 199) + 1)),
        samples = samples + 1
      where id = lv.id;
    end if;
  end if;

  if v_mine then
    update public.accounts set
      busy_call = null,
      busy_until = null,
      busy_kind = null,
      busy_day = null,
      busy_plan = null,
      hour_calls = case when p_ok then hour_calls else greatest(hour_calls - 1, 0) end
    where user_id = p_user;
    -- A failed call isn't counted as used either.
    if not p_ok then
      if acc.busy_kind = 'evaluation' then
        update public.usage_daily set evaluations = greatest(evaluations - 1, 0) where user_id = p_user and day = acc.busy_day;
      else
        update public.usage_daily set helpers = greatest(helpers - 1, 0) where user_id = p_user and day = acc.busy_day;
      end if;
    end if;
  end if;

  select credit_micros into v_balance from public.accounts where user_id = p_user;
  return jsonb_build_object(
    'ok', reserve.id is not null,
    'charged_micros', v_charge,
    'refunded_micros', v_refund,
    'balance_micros', v_balance,
    'level', reserve.level,
    'est_left', case when lv.id is null then null else floor(v_balance::numeric / coalesce(lv.avg_cost_micros, lv.est_cost_micros)) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The account, for the extension
-- ---------------------------------------------------------------------------

create or replace function public.account_summary(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  v_starter bigint;
begin
  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  select * into acc from public.accounts where user_id = p_user;
  v_starter := round(coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'starter_credit_usd'), 0) * 1000000);

  return jsonb_build_object(
    'plan', public.effective_plan(acc),
    'purchased_plan', acc.plan,
    'billing_status', acc.billing_status,
    'balance_micros', acc.credit_micros,
    'starter_micros', v_starter,
    'starter_granted_at', acc.starter_granted_at,
    'recharge_interest_at', acc.recharge_interest_at,
    'tz', acc.tz,
    'levels', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'model', l.model,
        'reasoning_effort', l.reasoning_effort,
        'cost_micros', coalesce(l.avg_cost_micros, l.est_cost_micros),
        'est_left', floor(acc.credit_micros::numeric / coalesce(l.avg_cost_micros, l.est_cost_micros))
      ) order by l.sort)
      from public.levels l where l.enabled
    ), '[]'::jsonb)
  );
end;
$$;

-- "Tell me when recharges open": recorded once, when first asked.
create function public.register_recharge_interest(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  insert into public.accounts (user_id) values (p_user) on conflict do nothing;
  update public.accounts set recharge_interest_at = coalesce(recharge_interest_at, now())
    where user_id = p_user
    returning recharge_interest_at into v_at;
  return jsonb_build_object('ok', true, 'at', v_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the service role may call these.
-- ---------------------------------------------------------------------------

revoke execute on function public.grant_starter_credit(uuid) from public, anon, authenticated;
revoke execute on function public.consume_quota(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.finish_call(uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
revoke execute on function public.account_summary(uuid) from public, anon, authenticated;
revoke execute on function public.register_recharge_interest(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.grant_starter_credit(uuid) to service_role;
grant execute on function public.consume_quota(uuid, text, text, integer, integer) to service_role;
grant execute on function public.finish_call(uuid, uuid, boolean, integer, integer) to service_role;
grant execute on function public.account_summary(uuid) to service_role;
grant execute on function public.register_recharge_interest(uuid) to service_role;
