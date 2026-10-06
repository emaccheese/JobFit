// POST /delete-account { confirm: "delete" } — deletes the signed-in user:
// their sign-in, account and usage (the tables cascade from auth.users).
//
//   200 { deleted: true }
//   400 bad_request (no confirmation) · 401 unauthorized
//   409 subscription_active: a paid plan still renews; cancel it first, so
//       nobody is charged for an account that no longer exists.

import { consoleLogger, errorReply, json, readJsonBody, type Logger } from "./http.ts";
import { signedInUser } from "./account.ts";
import type { Backend } from "./supabase.ts";

export type DeleteDeps = { backend: Backend; log?: Logger };

const RENEWING = new Set(["active", "on_trial", "past_due"]);

export async function handleDeleteAccount(req: Request, deps: DeleteDeps): Promise<Response> {
  const started = Date.now();
  const log = deps.log || consoleLogger;
  const done = (response: Response) => {
    log({ fn: "delete-account", status: response.status, ms: Date.now() - started });
    return response;
  };

  if (req.method !== "POST") return done(errorReply(405, "method_not_allowed", {}, { Allow: "POST" }));
  const user = await signedInUser(req, deps.backend);
  if (!user) return done(errorReply(401, "unauthorized"));

  const read = await readJsonBody(req, 1024);
  if (!read.ok) return done(read.response);
  if (read.body.confirm !== "delete") return done(errorReply(400, "bad_request", { detail: 'Send { "confirm": "delete" }.' }));

  const summary = (await deps.backend.rpc("account_summary", { p_user: user.id })) as Record<string, any>;
  if (summary && summary.purchased_plan !== "free" && RENEWING.has(summary.billing_status)) {
    return done(errorReply(409, "subscription_active"));
  }

  const deleted = await deps.backend.deleteUser(user.id);
  return done(deleted ? json(200, { deleted: true }) : errorReply(502, "delete_failed"));
}
