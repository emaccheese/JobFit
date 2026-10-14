-- Tino Cloud's database: the starter credit, reserving and charging calls by
-- effort level, refunds, the ledger, the brakes, billing events and who can
-- read or call what. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'a@example.test'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.test'),
  ('00000000-0000-4000-8000-00000000000c', 'c@example.test');

create temporary table calls (name text primary key, result jsonb) on commit drop;

-- --- the starter credit -------------------------------------------------------------
select is(
  (select credit_micros from public.accounts where user_id = '00000000-0000-4000-8000-00000000000a'),
  1000000::bigint,
  'a new account starts with $1 of credit'
);
select is(
  (select count(*)::int from public.credit_ledger where user_id = '00000000-0000-4000-8000-00000000000a' and kind = 'grant' and amount_micros = 1000000),
  1,
  '…recorded once in the ledger'
);
select is(public.grant_starter_credit('00000000-0000-4000-8000-00000000000a'), false, 'the starter credit is given once only');

-- --- a call: reserve the most it can cost, then charge what it cost -------------------
-- Quick is gpt-6-luna at $0.10 / $0.50 per million tokens: 3,000 tokens in and
-- 4,000 out at most is 300 + 2,000 = 2,300 micro-dollars.
insert into calls values ('a1', public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'quick', 3000, 4000));
select is((select (result ->> 'ok')::boolean from calls where name = 'a1'), true, 'a call at Quick starts');
select is((select result ->> 'model' from calls where name = 'a1'), 'gpt-6-luna', '…on the level''s model');
select is((select (result ->> 'reserved_micros')::bigint from calls where name = 'a1'), 2300::bigint, '…reserving the most it can cost');
select is(
  (select credit_micros from public.accounts where user_id = '00000000-0000-4000-8000-00000000000a'),
  997700::bigint,
  '…which comes off the balance while it runs'
);
select is(
  public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'quick', 3000, 4000) ->> 'reason',
  'busy',
  'a second call while the first runs is refused as busy'
);
-- It used 1,200 tokens in and 300 out: 120 + 150 = 270 micro-dollars.
insert into calls values ('a1-done', public.finish_call('00000000-0000-4000-8000-00000000000a', (select (result ->> 'call_id')::uuid from calls where name = 'a1'), true, 1200, 300));
select is((select (result ->> 'charged_micros')::bigint from calls where name = 'a1-done'), 270::bigint, 'a call is charged what it cost');
select is(
  (select credit_micros from public.accounts where user_id = '00000000-0000-4000-8000-00000000000a'),
  999730::bigint,
  '…and the rest of the reserve comes back'
);
select is(
  (select sum(amount_micros)::bigint from public.credit_ledger where user_id = '00000000-0000-4000-8000-00000000000a'),
  999730::bigint,
  'the ledger adds up to the balance'
);
select is(
  (select avg_cost_micros from public.levels where id = 'quick'),
  270::bigint,
  'the level learns what a call costs'
);
select is(
  (select (result ->> 'est_left')::bigint from calls where name = 'a1-done'),
  3702::bigint,
  '…and says about how many are left at it'
);
select is(
  (select (public.finish_call('00000000-0000-4000-8000-00000000000a', (select (result ->> 'call_id')::uuid from calls where name = 'a1'), true, 1200, 300) ->> 'charged_micros')::bigint),
  0::bigint,
  'finishing the same call again charges nothing more'
);

-- --- a failed call costs the user nothing ---------------------------------------------
insert into calls values ('a2', public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'quick', 3000, 4000));
do $$ begin perform public.finish_call('00000000-0000-4000-8000-00000000000a', (select (result ->> 'call_id')::uuid from calls where name = 'a2'), false, 900, 0); end $$;
select is(
  (select credit_micros from public.accounts where user_id = '00000000-0000-4000-8000-00000000000a'),
  999730::bigint,
  'a failed call is refunded in full'
);
select ok(
  (select cost_micros from public.spend_daily where day = (now() at time zone 'UTC')::date) >= 270 + 90,
  '…though its tokens still count in the day''s spending'
);

-- --- levels -------------------------------------------------------------------------------
select is(
  public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'astra', 3000, 4000) ->> 'reason',
  'level',
  'an unknown level is refused'
);
update public.levels set enabled = false where id = 'deep';
select is(
  public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'deep', 3000, 4000) ->> 'reason',
  'level',
  'a level switched off is refused'
);
update public.levels set enabled = true where id = 'deep';

-- --- running out ----------------------------------------------------------------------------
update public.accounts set credit_micros = 500 where user_id = '00000000-0000-4000-8000-00000000000b';
insert into calls values ('b-thorough', public.consume_quota('00000000-0000-4000-8000-00000000000b', 'evaluation', 'thorough', 3000, 4000));
select is((select result ->> 'reason' from calls where name = 'b-thorough'), 'credit', 'not enough for one call at Thorough: out of credit');
select is((select (result ->> 'balance_micros')::bigint from calls where name = 'b-thorough'), 500::bigint, '…with the balance');
insert into calls values ('b-quick', public.consume_quota('00000000-0000-4000-8000-00000000000b', 'evaluation', 'quick', 3000, 4000));
select is((select (result ->> 'reserved_micros')::bigint from calls where name = 'b-quick'), 500::bigint, 'the last call of a balance reserves only what''s left');
do $$ begin perform public.finish_call('00000000-0000-4000-8000-00000000000b', (select (result ->> 'call_id')::uuid from calls where name = 'b-quick'), true, 9000, 4000); end $$;
select is(
  (select credit_micros from public.accounts where user_id = '00000000-0000-4000-8000-00000000000b'),
  0::bigint,
  '…and a balance never goes below zero'
);

-- --- the account, and asking about recharges -----------------------------------------------------
select is((public.account_summary('00000000-0000-4000-8000-00000000000a') ->> 'balance_micros')::bigint, 999730::bigint, 'the summary has the balance');
select is(jsonb_array_length(public.account_summary('00000000-0000-4000-8000-00000000000a') -> 'levels'), 4, '…and the four levels');
select ok((public.register_recharge_interest('00000000-0000-4000-8000-00000000000a') ->> 'at') is not null, '"tell me when recharges open" is recorded');
select is(
  public.account_summary('00000000-0000-4000-8000-00000000000a') ->> 'recharge_interest_at',
  public.register_recharge_interest('00000000-0000-4000-8000-00000000000a') ->> 'at',
  '…once: asking again keeps the first time'
);

-- --- the brakes -------------------------------------------------------------------------------------
update public.plans set hourly_calls = 1 where id = 'free';
select is(public.consume_quota('00000000-0000-4000-8000-00000000000a', 'evaluation', 'quick', 3000, 4000) ->> 'reason', 'hourly', 'the hourly brake still applies');
update public.plans set hourly_calls = 20 where id = 'free';
update public.app_settings set value = 'true' where key = 'paused';
select is(public.consume_quota('00000000-0000-4000-8000-00000000000c', 'evaluation', 'quick', 3000, 4000) ->> 'reason', 'paused', 'pausing stops hosted scoring');
update public.app_settings set value = 'false' where key = 'paused';

-- --- time zones and billing events, unchanged ---------------------------------------------------------
select is((public.set_timezone('00000000-0000-4000-8000-00000000000c', 'America/Mexico_City') ->> 'ok')::boolean, true, 'the time zone is set');
select is(
  (public.apply_billing_event('evt-1', now(), '00000000-0000-4000-8000-00000000000c', 'pro', 'active', now() + interval '30 days') ->> 'applied')::boolean,
  true,
  'a billing event is applied'
);
select is(
  public.apply_billing_event('evt-1', now(), '00000000-0000-4000-8000-00000000000c', 'pro', 'active', now() + interval '30 days') ->> 'reason',
  'duplicate',
  '…once'
);

-- --- what a signed-in user can do --------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4000-8000-00000000000a", "role": "authenticated"}';
select is(
  (select count(distinct user_id)::int from public.credit_ledger),
  1,
  'a user sees only their own credit history'
);
select throws_ok(
  $$ select public.grant_starter_credit('00000000-0000-4000-8000-00000000000a') $$,
  '42501',
  null,
  'a user can''t give themselves credit'
);
select throws_ok(
  $$ update public.accounts set credit_micros = 99000000 $$,
  '42501',
  null,
  'a user can''t change their own balance'
);
reset role;

select * from finish();
rollback;
