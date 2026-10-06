// /account — the signed-in user's plan and today's usage, for the
// extension's Settings and popup; and setting their time zone.
//
//   GET  → 200 { email, plan, billingStatus, periodEnd, tz, evaluations, helpers, dayResetsAt, monthResetsAt, checkoutAvailable }
//   POST { tz } → 200 { tz } · 400 bad_request · 409 too_soon { retryAt }
//
// POST /delete-account is in delete-account.ts.

import { bearerToken, consoleLogger, errorReply, json, readJsonBody, type Logger } from "./http.ts";
import type { Backend, User } from "./supabase.ts";

export type AccountDeps = { backend: Backend; billingConfigured: boolean; log?: Logger };

export async function signedInUser(req: Request, backend: Backend): Promise<User | null> {
  const token = bearerToken(req);
  return token ? backend.getUser(token) : null;
}

// The database's snake_case summary, as the extension reads it.
export function shapeSummary(summary: Record<string, any>, email: string | null, billingConfigured: boolean) {
  const evaluations = summary.evaluations || {};
  const helpers = summary.helpers || {};
  return {
    email,
    plan: summary.plan,
    purchasedPlan: summary.purchased_plan,
    billingStatus: summary.billing_status,
    periodEnd: summary.period_end ?? null,
    tz: summary.tz,
    evaluations: {
      usedToday: evaluations.used_today ?? 0,
      dailyLimit: evaluations.daily_limit ?? null,
      usedThisMonth: evaluations.used_this_month ?? 0,
      monthlyLimit: evaluations.monthly_limit ?? null,
    },
    helpers: { usedToday: helpers.used_today ?? 0, dailyLimit: helpers.daily_limit ?? null },
    dayResetsAt: summary.day_resets_at ?? null,
    monthResetsAt: summary.month_resets_at ?? null,
    checkoutAvailable: billingConfigured,
  };
}

// IANA names only ("America/Mexico_City", "UTC"); the database checks the
// name exists.
const TZ_NAME = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;

export async function handleAccount(req: Request, deps: AccountDeps): Promise<Response> {
  const started = Date.now();
  const log = deps.log || consoleLogger;
  const done = (response: Response) => {
    log({ fn: "account", method: req.method, status: response.status, ms: Date.now() - started });
    return response;
  };

  if (req.method !== "GET" && req.method !== "POST") return done(errorReply(405, "method_not_allowed", {}, { Allow: "GET, POST" }));
  const user = await signedInUser(req, deps.backend);
  if (!user) return done(errorReply(401, "unauthorized"));

  if (req.method === "POST") {
    const read = await readJsonBody(req, 4096);
    if (!read.ok) return done(read.response);
    const tz = read.body.tz;
    if (typeof tz !== "string" || tz.length > 64 || !TZ_NAME.test(tz)) return done(errorReply(400, "bad_request", { detail: "Invalid time zone." }));
    const set = (await deps.backend.rpc("set_timezone", { p_user: user.id, p_tz: tz })) as Record<string, any>;
    if (set.ok !== true) {
      if (set.reason === "too_soon") return done(errorReply(409, "too_soon", { tz: set.tz, retryAt: set.retry_at }));
      return done(errorReply(400, "bad_request", { detail: "Invalid time zone." }));
    }
  }

  const summary = (await deps.backend.rpc("account_summary", { p_user: user.id })) as Record<string, any>;
  return done(json(200, shapeSummary(summary, user.email, deps.billingConfigured)));
}
