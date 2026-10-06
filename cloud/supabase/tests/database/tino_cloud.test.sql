-- Tino Cloud's database: allowances, refunds, time zones, billing events and
-- who can read or call what. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'a@example.test'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.test'),
  ('00000000-0000-4000-8000-00000000000c', 'c@example.test');

-- --- a new user gets a free account --------------------------------------------
select is(
  (select plan from public.accounts where user_id = '00000000-0000-4000-8000-00000000000a'),
  'free',
  'a new user has a free account'
);

-- --- one call at a time ---------------------------------------------------------
create temporary table calls (name text primary key, result jsonb) on commit drop;
insert into calls values ('a1', public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation'));
select is((select (result ->> 'ok')::boolean from calls where name = 'a1'), true, 'the first evaluation is allowed');
select is((select (result ->> 'remaining')::int from calls where name = 'a1'), 9, '…with 9 left today');
select is(
  public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation') ->> 'reason',
  'busy',
  'a second call while the first runs is refused as busy'
);
select is(
  public.finish_call('00000000-0000-4000-8000-00000000000a', (select (result ->> 'call_id')::uuid from calls where name = 'a1'), true, 100, 50) ->> 'refunded',
  'false',
  'a successful call is not refunded'
);

-- --- the daily allowance --------------------------------------------------------
do $$
declare
  r jsonb;
begin
  for i in 1..9 loop
    r := public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation');
    perform public.finish_call('00000000-0000-4000-8000-00000000000a', (r ->> 'call_id')::uuid, true, 100, 50);
  end loop;
end;
$$;
insert into calls values ('a11', public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation'));
select is((select result ->> 'reason' from calls where name = 'a11'), 'daily', 'the 11th evaluation of the day is refused');
select is((select (result ->> 'remaining')::int from calls where name = 'a11'), 0, '…with none left');
select is(
  (select (result ->> 'reset_at')::timestamptz from calls where name = 'a11'),
  ((now() at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC',
  '…until midnight in the user''s time zone'
);
select is(
  (select evaluations from public.usage_daily where user_id = '00000000-0000-4000-8000-00000000000a'),
  10,
  'ten evaluations are counted'
);
select is(
  (select input_tokens from public.usage_daily where user_id = '00000000-0000-4000-8000-00000000000a'),
  1000::bigint,
  'their input tokens are recorded'
);
select ok(
  (select cost_micros from public.spend_daily where day = (now() at time zone 'UTC')::date) >= 350,
  'and the day''s spending grows by their cost'
);

-- --- helpers have their own allowance, and failures are refunded ---------------
insert into calls values ('ah', public.consume_quota('00000000-0000-4000-8000-00000000000a', 'helper'));
select is((select (result ->> 'ok')::boolean from calls where name = 'ah'), true, 'a helper call is allowed after the evaluations run out');
select is(
  public.finish_call('00000000-0000-4000-8000-00000000000a', (select (result ->> 'call_id')::uuid from calls where name = 'ah'), false) ->> 'refunded',
  'true',
  'a failed call is refunded'
);
select is(
  (select helpers from public.usage_daily where user_id = '00000000-0000-4000-8000-00000000000a'),
  0,
  '…so it isn''t counted'
);
select is(
  public.finish_call('00000000-0000-4000-8000-00000000000a', gen_random_uuid(), false) ->> 'reason',
  'not_current',
  'finishing a call that isn''t the current one refunds nothing'
);

-- --- time zones -----------------------------------------------------------------
select is(public.set_timezone('00000000-0000-4000-8000-00000000000b', 'Mars/Olympus') ->> 'reason', 'invalid', 'an unknown time zone is refused');
select is((public.set_timezone('00000000-0000-4000-8000-00000000000b', 'America/Mexico_City') ->> 'ok')::boolean, true, 'the first time zone is set');
select is(public.set_timezone('00000000-0000-4000-8000-00000000000b', 'Europe/Paris') ->> 'reason', 'too_soon', 'changing it again within 30 days is refused');
insert into calls values ('b1', public.consume_quota('00000000-0000-4000-8000-00000000000b', 'evaluation'));
select is(
  (select (result ->> 'reset_at')::timestamptz from calls where name = 'b1'),
  ((now() at time zone 'America/Mexico_City')::date + 1)::timestamp at time zone 'America/Mexico_City',
  'the allowance resets at midnight in Mexico City for a user there'
);
do $$ begin perform public.finish_call('00000000-0000-4000-8000-00000000000b', (select (result ->> 'call_id')::uuid from calls where name = 'b1'), true); end $$;

-- --- billing events ---------------------------------------------------------------
select is(
  (public.apply_billing_event('evt-1', now(), '00000000-0000-4000-8000-00000000000b', 'pro', 'active', now() + interval '30 days') ->> 'applied')::boolean,
  true,
  'a subscription event makes the user Pro'
);
select is(
  public.apply_billing_event('evt-1', now(), '00000000-0000-4000-8000-00000000000b', 'pro', 'active', now() + interval '30 days') ->> 'reason',
  'duplicate',
  'the same event twice is applied once'
);
select is(
  public.apply_billing_event('evt-0', now() - interval '1 day', '00000000-0000-4000-8000-00000000000b', 'free', 'expired', null) ->> 'reason',
  'stale',
  'an older event arriving late is ignored'
);
insert into calls values ('b2', public.consume_quota('00000000-0000-4000-8000-00000000000b', 'evaluation'));
select is((select result ->> 'plan' from calls where name = 'b2'), 'pro', 'a Pro user is scored on Pro');
select is((select (result ->> 'limit')::int from calls where name = 'b2'), 500, '…against the monthly fair-use limit');
do $$ begin perform public.finish_call('00000000-0000-4000-8000-00000000000b', (select (result ->> 'call_id')::uuid from calls where name = 'b2'), true); end $$;
select is(
  public.apply_billing_event('evt-2', now(), '00000000-0000-4000-8000-00000000000b', 'pro', 'expired', now() - interval '1 day') ->> 'applied',
  'true',
  'an expiry is applied'
);
select is(public.account_summary('00000000-0000-4000-8000-00000000000b') ->> 'plan', 'free', '…and the user is back on Free');
select is(
  public.apply_billing_event('evt-3', now(), '00000000-0000-4000-8000-0000000000ff', 'pro', 'active', null) ->> 'reason',
  'unknown_user',
  'an event for an unknown user is not applied'
);

-- --- the operator switch ------------------------------------------------------------
update public.app_settings set value = 'true' where key = 'paused';
select is(public.consume_quota('00000000-0000-4000-8000-00000000000c', 'evaluation') ->> 'reason', 'paused', 'pausing stops hosted scoring');
update public.app_settings set value = 'false' where key = 'paused';

-- --- what a signed-in user can do ------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4000-8000-00000000000a", "role": "authenticated"}';
select is((select count(*)::int from public.accounts), 1, 'a user sees only their own account');
select throws_ok(
  $$ select public.finish_call('00000000-0000-4000-8000-00000000000a', gen_random_uuid(), false) $$,
  '42501',
  null,
  'a user can''t call the quota functions (or refund themselves)'
);
select throws_ok(
  $$ update public.accounts set plan = 'pro' $$,
  '42501',
  null,
  'a user can''t change their own plan'
);
reset role;

select * from finish();
rollback;
