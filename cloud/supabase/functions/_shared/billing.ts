// Payments, through a merchant of record (to be chosen: Lemon Squeezy or
// Paddle). Everything that doesn't depend on which one is here; the choice
// is one adapter implementing BillingProvider, passed in by env.ts.
//
// The flow:
// 1. The extension asks POST /checkout for a checkout page. The provider's
//    checkout carries the user's id as custom data.
// 2. The provider calls POST /billing-webhook on every subscription change,
//    signed with a shared secret. The adapter checks the signature and turns
//    the event into a PlanUpdate, with the user id from that custom data.
// 3. apply_billing_event() applies it once (by event id) and never lets an
//    older event undo a newer one.
//
// Until an adapter exists, both endpoints answer 501 billing_not_configured.

import { bearerToken, consoleLogger, errorReply, json, readJsonBody, type Logger } from "./http.ts";
import type { Backend, User } from "./supabase.ts";

export type PlanUpdate = {
  eventId: string;
  occurredAt: string;
  userId: string;
  plan: "free" | "pro";
  status: "active" | "on_trial" | "past_due" | "paused" | "cancelled" | "expired";
  periodEnd: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
};

export type WebhookResult = { valid: false } | { valid: true; update: PlanUpdate | null };

export interface BillingProvider {
  name: string;
  checkoutUrl(user: User, interval: "month" | "year"): Promise<string>;
  // Checks the delivery's signature against the raw body, then reads it.
  // update is null for events that don't change a plan (an order receipt…).
  parseWebhook(req: Request, rawBody: string): Promise<WebhookResult>;
}

// --- signatures (both candidate providers use HMAC-SHA256) --------------------

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares every character whatever the first difference, so the time it
// takes says nothing about how much of a forged signature was right.
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- POST /checkout ------------------------------------------------------------

export type CheckoutDeps = { backend: Backend; provider: BillingProvider | null; log?: Logger };

export async function handleCheckout(req: Request, deps: CheckoutDeps): Promise<Response> {
  const log = deps.log || consoleLogger;
  const done = (response: Response) => {
    log({ fn: "checkout", status: response.status });
    return response;
  };
  if (req.method !== "POST") return done(errorReply(405, "method_not_allowed", {}, { Allow: "POST" }));
  const token = bearerToken(req);
  const user = token ? await deps.backend.getUser(token) : null;
  if (!user) return done(errorReply(401, "unauthorized"));
  if (!deps.provider) return done(errorReply(501, "billing_not_configured"));

  const read = await readJsonBody(req, 1024);
  if (!read.ok) return done(read.response);
  const interval = read.body.interval === undefined ? "month" : read.body.interval;
  if (interval !== "month" && interval !== "year") return done(errorReply(400, "bad_request", { detail: "interval is month or year." }));
  return done(json(200, { url: await deps.provider.checkoutUrl(user, interval) }));
}

// --- POST /billing-webhook -------------------------------------------------------

export type WebhookDeps = { backend: Backend; provider: BillingProvider | null; log?: Logger };

const MAX_WEBHOOK_BYTES = 256 * 1024;

export function validUpdate(u: PlanUpdate): boolean {
  return (
    typeof u.eventId === "string" && u.eventId.length > 0 && u.eventId.length <= 200 &&
    typeof u.userId === "string" && UUID.test(u.userId) &&
    !Number.isNaN(Date.parse(u.occurredAt)) &&
    (u.plan === "free" || u.plan === "pro") &&
    ["active", "on_trial", "past_due", "paused", "cancelled", "expired"].includes(u.status) &&
    (u.periodEnd === null || !Number.isNaN(Date.parse(u.periodEnd)))
  );
}

export async function handleBillingWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const log = deps.log || consoleLogger;
  const done = (response: Response, fields: Record<string, unknown> = {}) => {
    log({ fn: "billing-webhook", status: response.status, ...fields });
    return response;
  };
  if (req.method !== "POST") return done(errorReply(405, "method_not_allowed", {}, { Allow: "POST" }));
  if (!deps.provider) return done(errorReply(501, "billing_not_configured"));

  const declared = Number(req.headers.get("Content-Length") || 0);
  if (declared > MAX_WEBHOOK_BYTES) return done(errorReply(413, "too_large"));
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return done(errorReply(413, "too_large"));

  const parsed = await deps.provider.parseWebhook(req, raw);
  if (!parsed.valid) return done(errorReply(401, "bad_signature"));
  // Acknowledged so the provider stops retrying; nothing to apply.
  if (!parsed.update) return done(json(200, { ignored: true }));
  // A signed event that still doesn't make sense is a bug to look at, not
  // something to retry forever: acknowledged and logged.
  if (!validUpdate(parsed.update)) return done(json(200, { ignored: true, reason: "unreadable" }), { unreadable: true });

  const u = parsed.update;
  const result = (await deps.backend.rpc("apply_billing_event", {
    p_event_id: `${deps.provider.name}:${u.eventId}`,
    p_occurred_at: u.occurredAt,
    p_user: u.userId,
    p_plan: u.plan,
    p_status: u.status,
    p_period_end: u.periodEnd,
    p_customer: u.customerId ?? null,
    p_subscription: u.subscriptionId ?? null,
  })) as Record<string, unknown>;
  return done(json(200, { applied: Boolean(result && result.applied), reason: (result && result.reason) ?? null }), {
    applied: Boolean(result && result.applied),
    reason: (result && result.reason) ?? null,
  });
}
