# Tino Cloud

The hosted option: people sign in (Google, or a 6-digit code sent by email) and
score postings without installing a model or bringing an OpenAI key. Each new
account gets **$1 of credit** once, about 1,000 evaluations at the Quick level.
There are no payments yet: when the credit runs out, the extension offers LM
Studio, the user's own OpenAI key, and "tell me when recharges open", which is
recorded here so interest can be measured first. LM Studio and your own key
stay free and unlimited.

It runs on [Supabase](https://supabase.com): sign-in (Auth), Postgres for
accounts, credit and usage, and five Edge Functions.

## What the server keeps, and what it doesn't

- **Keeps:** the account (Google sign-in, plan, billing status, time zone) and
  usage counts per day: evaluations, helper calls and tokens.
- **Never keeps:** CVs, profiles, postings or the model's replies. A request
  passes through to OpenAI (with `store: false`) and the answer goes straight
  back. The function logs record the kind of request, the status and the
  timing, never the content, the user's email or their id.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| `score` | `functions/_shared/score.ts` | One model call. Checks the session, reserves credit for the call at the user's effort level, calls OpenAI with the **server's** instructions for that kind of request, then charges what it cost (nothing if the model failed). |
| `account` | `functions/_shared/account.ts` | GET: plan and today's usage. POST `{ tz }`: the user's time zone. |
| `checkout` | `functions/_shared/billing.ts` | A checkout page for Pro. 501 until a payment provider is set up. |
| `billing-webhook` | `functions/_shared/billing.ts` | Subscription changes from the payment provider, signature-checked, applied once. 501 until set up. |
| `delete-account` | `functions/_shared/delete-account.ts` | Deletes the user and everything about them (refused while a subscription still renews). |
| Database | `migrations/` | `20261006000000_tino_cloud.sql`: accounts, usage, the lease and the brakes. `20261014000000_credits.sql`: effort levels, the credit, its ledger, and the functions that reserve and charge it. |

**Why the server picks the instructions.** A request says what *kind* of
call it is (`evaluate`, `summarize`, `draftProfile`, `suggestSalary`,
`suggestFlags`) and sends the user message. The system prompt, the model and
the output limit come from the server. So Tino Cloud can't be used as a free
general-purpose model. The prompts are the extension's own
(`job-fit-evaluator/prompts.js`), copied into `functions/_shared/prompts.js`
by `node tools/cloud.js`; the tests fail if the copy is out of date.

**Credit** (`20261014000000_credits.sql`). Money is kept in micro-dollars
(1,000,000 = $1), as whole numbers.

- **The starter credit:** `app_settings.starter_credit_usd` ($1), given once per
  account when it's created (`grant_starter_credit`).
- **Effort levels** (the `levels` table) decide the model and reasoning effort,
  and so how fast the credit goes. The user picks one in the extension.

  | Level | Model · effort | About per evaluation | $1 lasts |
  |---|---|---|---|
  | `quick` (default) | gpt-6-luna · low | $0.001 | ~1,000 |
  | `careful` | gpt-6-luna · medium | $0.002 | ~500 |
  | `thorough` | gpt-6-sol · low | $0.025 | ~40 |
  | `deep` | gpt-6-sol · medium | $0.04 | ~25 |

  Each level keeps the average cost of its last couple of hundred calls
  (`avg_cost_micros`), so "about N left" follows what calls really cost. Until
  there are calls, `est_cost_micros` stands in.
- **A call reserves, then settles.** `consume_quota` takes the most the call
  could cost (the request's size and the kind's output cap, at the level's
  prices), never more than what's left. `finish_call` charges what it cost,
  gives back the rest, and charges nothing for a failed call. Every movement is
  a row in `credit_ledger`, and a user's rows add up to their balance.
- **Out of credit:** a call needs at least one typical call's worth at its
  level, or `score` answers 402.
- **Still from the first migration:** one call at a time per user (the account
  row is locked), and an hourly brake (`plans.hourly_calls`, 20) against
  scripts. The daily and monthly limits are gone: the credit is the limit.

**Cost controls:**

- `app_settings.daily_spend_limit_usd` (25 to start) pauses hosted scoring
  for the rest of the UTC day once the day's estimated spend reaches it.
- `app_settings.paused` stops it at once.
- Set a hard monthly limit on the OpenAI project too. The database's figure
  is an estimate from token counts.

**Who can do what.** Row-level security is on for every table. Signed-in
users can read their own account, usage and credit history, and the plans and
levels; nothing else. The credit functions can only be called by the service
role (the Edge Functions): a user who could call them could give themselves
credit.

## The API, for Phase 4

Every call sends `Authorization: Bearer <the user's Supabase session token>`.

`POST /functions/v1/score`

```json
{ "kind": "evaluate", "level": "quick", "lang": "es", "user": "<the user message the extension builds>" }
```

| Reply | Meaning |
|---|---|
| 200 `{ data, model, level, usage, chargedMicros, balanceMicros, estLeft }` | `data` is the model's JSON, as from OpenAI. `estLeft`: about how many more at this level. |
| 402 `{ error: "credit", balanceMicros, level }` | Not enough credit for a call at this level. A cheaper level may still work. |
| 429 `{ error: "quota", reason, resetAt }` + `Retry-After` | `reason`: `hourly` (the brake) or `busy` (another call of the user's is running). |
| 503 `{ error: "paused" }` + `Retry-After` | Hosted scoring is switched off for now (spending limit or by hand). |
| 502 / 504 `{ error: "upstream", reason }` | The model failed or timed out. Nothing was charged. |
| 400, 401, 413 | Bad request (including an unknown level), no valid session, body over 128 KB. |

`GET /functions/v1/account` returns `{ email, balanceMicros, starterMicros,
levels: [{ id, model, effort, costMicros, estLeft }], rechargeInterestAt }`.
`POST` it `{ "rechargeInterest": true }` for "tell me when recharges open".

**Signing in** uses Supabase Auth's own API; there's no function for it:
- **Email code:** `POST /auth/v1/otp { email, create_user: true }`, then
  `POST /auth/v1/verify { type: "email", email, token }` returns the session.
- **Google:** `chrome.identity.launchWebAuthFlow` on
  `/auth/v1/authorize?provider=google&redirect_to=<the extension's redirect>`
  with PKCE, then `POST /auth/v1/token?grant_type=pkce`.
- **Staying signed in:** `POST /auth/v1/token?grant_type=refresh_token`.

`suggestSalary` also takes `markets: [{ currency, period, country? }]`, and
`suggestFlags` takes `languages: ["en", "es"]`.

## Tests

Two sets:

- **The functions**, in Node, against stand-ins for Supabase and OpenAI:
  `node tools/test.js cloud`. Part of the normal `node tools/test.js`.
- **The database** (the starter credit, reserving and charging by level,
  refunds, the ledger, running out, the brakes, billing events, row-level
  security), in Postgres with pgTAP: `supabase test db`. These need the tools
  below.

## Setting it up

### 1. Install the tools (once)

1. Start **Docker Desktop** (already installed; Supabase runs its services in it).
2. Install the Supabase CLI:

   ```bash
   brew install supabase/tap/supabase
   ```

3. Optional, for type checks of the functions: `brew install deno`, then
   `deno check cloud/supabase/functions/*/index.ts`.

### 2. Run it on this Mac

```bash
cd cloud
supabase start
```

The first start downloads the Docker images (about 2–3 GB) and applies the
migration. It prints the local URLs and keys. Then:

```bash
supabase test db
```

To try the functions, put an OpenAI key (a test project's) in
`cloud/supabase/functions/.env` (git-ignored):

```
OPENAI_API_KEY=sk-...
```

```bash
supabase functions serve --env-file supabase/functions/.env
```

Locally there's no Google sign-in unless you configure it, so make a test
user instead: open Studio (http://127.0.0.1:54323) → Authentication → Add
user, with an email and password. Get a session token for it with the
`anon`/publishable key `supabase start` printed:

```bash
curl -s 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' -H 'apikey: <publishable key>' -H 'Content-Type: application/json' -d '{"email":"you@example.test","password":"<password>"}'
```

Then call `score` with the `access_token` from that reply:

```bash
curl -s http://127.0.0.1:54321/functions/v1/score -H 'Authorization: Bearer <access_token>' -H 'Content-Type: application/json' -d '{"kind":"suggestFlags","user":"CANDIDATE PROFILE:\nBackend engineer, Go and AWS. Gaps: Kubernetes, mobile."}'
```

### 3. Put it online

1. **Supabase project:** create one at supabase.com, in the region closest to
   most users (for the Americas, `us-east-1`).
2. **Link and push** from `cloud/`:

   ```bash
   supabase login
   supabase link --project-ref <your project ref>
   supabase db push
   ```

3. **OpenAI:** make a separate project for Tino Cloud in the OpenAI dashboard.
   - Give it a **monthly budget** with a hard limit.
   - Allow only the models in the `levels` table (gpt-6-luna, gpt-6-sol).
   - Create a key for that project only.
4. **Secrets and functions:**

   ```bash
   supabase secrets set OPENAI_API_KEY=sk-...
   supabase functions deploy score account checkout billing-webhook delete-account
   ```

5. **Google sign-in:**
   - In Google Cloud Console, create an OAuth client (type *Web application*).
     Its authorised redirect URI is `https://<project ref>.supabase.co/auth/v1/callback`.
   - In Supabase, go to Authentication → Sign In / Providers → Google, and paste
     the client id and secret.
   - In Authentication → URL Configuration, add the extension's redirect,
     `https://<extension id>.chromiumapp.org/` (Phase 4 says which id).
6. **Email codes:**
   - Create an account with an email-sending service (Resend or Postmark both have
     free tiers) and verify your sending domain.
   - In Supabase, go to Authentication → Emails → SMTP Settings and enter its details.
     Supabase's own mailer only sends a few emails an hour.
   - In Authentication → Emails → Templates, use `supabase/templates/sign-in-code.html`
     for both **Confirm signup** and **Magic Link**, so the email carries the code
     (`{{ .Token }}`), not a link. `config.toml` does this for local runs.
7. **Check each level's quality** before launch: score the test postings at Quick
   and at Thorough, and compare.

### 4. Payments (later)

- Choose the merchant of record (Lemon Squeezy or Paddle).
- Write its adapter: a `BillingProvider` in `functions/_shared/billing.ts`
  (checkout URL, webhook signature check, event → plan update).
- Return it from `billingProvider()` in `functions/_shared/env.ts` and set its
  secrets.
- Point its webhook at `https://<project ref>.supabase.co/functions/v1/billing-webhook`.

Until then, `checkout` and `billing-webhook` answer 501. Everything else,
including applying plan changes idempotently, is in place and tested.

Before taking payments, consider forming a company and having a lawyer
review the terms and privacy policy for the countries Tino sells in (the US,
Mexico, Canada, Brazil, the EU).

## Operating it

From the SQL editor in the Supabase dashboard:

```sql
-- Stop hosted scoring now / start it again
update app_settings set value = 'true' where key = 'paused';
update app_settings set value = 'false' where key = 'paused';

-- The daily spending switch, in dollars
update app_settings set value = '40' where key = 'daily_spend_limit_usd';

-- The starter credit for new accounts, in dollars
update app_settings set value = '0.5' where key = 'starter_credit_usd';

-- Give one user credit by hand (a tester, a goodwill gesture)
update accounts set credit_micros = credit_micros + 500000 where user_id = '<user id>';
insert into credit_ledger (user_id, kind, amount_micros) values ('<user id>', 'adjust', 500000);

-- Switch a level off, or change its model or prices
update levels set enabled = false where id = 'deep';

-- Who asked to be told when recharges open
select a.recharge_interest_at, u.email from accounts a join auth.users u on u.id = a.user_id
  where a.recharge_interest_at is not null order by 1;

-- What each level really costs per call so far
select id, model, reasoning_effort, avg_cost_micros, samples from levels order by sort;

-- Today's spending
select * from spend_daily order by day desc limit 7;
```
