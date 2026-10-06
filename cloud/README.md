# Tino Cloud

The hosted option: people sign in with Google and score postings without
installing a model or bringing an OpenAI key. Free gives a daily allowance;
Pro (once payments are set up) gives more on a better model. LM Studio and
your own OpenAI key stay free and unlimited in the extension.

It runs on [Supabase](https://supabase.com): Google sign-in (Auth), Postgres
for accounts and usage, and five Edge Functions.

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
| `score` | `functions/_shared/score.ts` | One model call. Checks the session, spends one unit of the allowance, calls OpenAI with the **server's** instructions for that kind of request, finishes the call (refunded if the model failed). |
| `account` | `functions/_shared/account.ts` | GET: plan and today's usage. POST `{ tz }`: the user's time zone. |
| `checkout` | `functions/_shared/billing.ts` | A checkout page for Pro. 501 until a payment provider is set up. |
| `billing-webhook` | `functions/_shared/billing.ts` | Subscription changes from the payment provider, signature-checked, applied once. 501 until set up. |
| `delete-account` | `functions/_shared/delete-account.ts` | Deletes the user and everything about them (refused while a subscription still renews). |
| Database | `migrations/20261006000000_tino_cloud.sql` | Plans, accounts, usage, and the functions that spend and refund the allowance. |

**Why the server picks the instructions.** A request says what *kind* of
call it is (`evaluate`, `summarize`, `draftProfile`, `suggestSalary`,
`suggestFlags`) and sends the user message. The system prompt, the model and
the output limit come from the server. So Tino Cloud can't be used as a free
general-purpose model. The prompts are the extension's own
(`job-fit-evaluator/prompts.js`), copied into `functions/_shared/prompts.js`
by `node tools/cloud.js`; the tests fail if the copy is out of date.

**The allowance** (`consume_quota` and `finish_call` in the migration):

- One call at a time per user. The account row is locked while a unit is
  taken, so two requests at once can't both take the last one.
- Free: 10 evaluations a day (scoring or summarising a posting) plus 5 helper
  calls for the setup wizard. "A day" ends at midnight in the user's time zone.
- Pro: 500 evaluations a month (fair use) and 50 helper calls a day.
- Both: an hourly brake (20 calls Free, 60 Pro) against scripts.
- A failed model call is refunded. Its tokens are still counted, since OpenAI
  billed them.
- Limits and models are rows in the `plans` table: change them with SQL, no
  deploy needed.

**Cost controls:**

- `app_settings.daily_spend_limit_usd` (25 to start) pauses hosted scoring
  for the rest of the UTC day once the day's estimated spend reaches it.
- `app_settings.paused` stops it at once.
- Set a hard monthly limit on the OpenAI project too. The database's figure
  is an estimate from token counts.

**Who can do what.** Row-level security is on for every table. Signed-in
users can read their own account and usage and the plans, nothing else. The
quota functions can only be called by the service role (the Edge Functions):
a user who could call `finish_call` could refund themselves.

## The API, for Phase 4

Every call sends `Authorization: Bearer <the user's Supabase session token>`.

`POST /functions/v1/score`

```json
{ "kind": "evaluate", "lang": "es", "user": "<the user message the extension builds>" }
```

| Reply | Meaning |
|---|---|
| 200 `{ data, model, plan, usage, limit, remaining, resetAt }` | `data` is the model's JSON, as from OpenAI. |
| 429 `{ error: "quota", reason, resetAt, upgrade }` + `Retry-After` | `reason`: `daily`, `monthly`, `hourly` or `busy`. `upgrade` is true for a Free user who could buy more. |
| 503 `{ error: "paused" }` + `Retry-After` | Hosted scoring is switched off for now (spending limit or by hand). |
| 502 / 504 `{ error: "upstream", reason }` | The model failed or timed out. The allowance was given back. |
| 400, 401, 413 | Bad request, no valid session, body over 128 KB. |

`suggestSalary` also takes `markets: [{ currency, period, country? }]`, and
`suggestFlags` takes `languages: ["en", "es"]`.

## Tests

Two sets:

- **The functions**, in Node, against stand-ins for Supabase and OpenAI:
  `node tools/test.js cloud`. Part of the normal `node tools/test.js`.
- **The database** (allowances, refunds, time zones, billing events,
  row-level security), in Postgres with pgTAP: `supabase test db`. These need
  the tools below.

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
   - Allow only the models in the `plans` table.
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
     the client id and secret. Turn off email sign-ups.
   - In Authentication → URL Configuration, add the extension's redirect,
     `https://<extension id>.chromiumapp.org/` (Phase 4 says which id).
6. **Check the free model's quality** before launch: score the test postings
   on the Free model and compare with the Pro one.

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

-- Change a plan's limits or model
update plans set daily_evaluations = 15 where id = 'free';

-- Today's spending
select * from spend_daily order by day desc limit 7;
```
