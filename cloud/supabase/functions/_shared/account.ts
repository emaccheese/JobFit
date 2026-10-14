// /account — the signed-in user's credit and the effort levels, for the
// extension's Settings, wizard and popup; the "tell me when recharges open"
// request; and the time zone.
//
//   GET  → 200 { email, balanceMicros, starterMicros, levels: [{ id, model, effort, costMicros, estLeft }],
//                rechargeInterestAt, checkoutAvailable }
//   POST { rechargeInterest: true } → 200 (the same, with rechargeInterestAt set; asking twice keeps the first time)
//   POST { tz } → 200 · 400 bad_request · 409 too_soon { retryAt }
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
  const levels = Array.isArray(summary.levels) ? summary.levels : [];
  return {
    email,
    balanceMicros: Number(summary.balance_micros) || 0,
    starterMicros: Number(summary.starter_micros) || 0,
    levels: levels.map((l: Record<string, any>) => ({
      id: l.id,
      model: l.model,
      effort: l.reasoning_effort ?? null,
      costMicros: Number(l.cost_micros) || 0,
      estLeft: Number(l.est_left) || 0,
    })),
    rechargeInterestAt: summary.recharge_interest_at ?? null,
    plan: summary.plan,
    billingStatus: summary.billing_status,
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
    if (read.body.rechargeInterest === true) {
      await deps.backend.rpc("register_recharge_interest", { p_user: user.id });
    } else {
      const tz = read.body.tz;
      if (typeof tz !== "string" || tz.length > 64 || !TZ_NAME.test(tz)) return done(errorReply(400, "bad_request", { detail: "Invalid time zone." }));
      const set = (await deps.backend.rpc("set_timezone", { p_user: user.id, p_tz: tz })) as Record<string, any>;
      if (set.ok !== true) {
        if (set.reason === "too_soon") return done(errorReply(409, "too_soon", { tz: set.tz, retryAt: set.retry_at }));
        return done(errorReply(400, "bad_request", { detail: "Invalid time zone." }));
      }
    }
  }

  const summary = (await deps.backend.rpc("account_summary", { p_user: user.id })) as Record<string, any>;
  return done(json(200, shapeSummary(summary, user.email, deps.billingConfigured)));
}
