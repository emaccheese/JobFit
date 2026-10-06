// POST /score — one model call on Tino Cloud, against the user's allowance.
//
// Request (Authorization: Bearer <the user's session token>):
//   { kind, lang?, user, markets?, languages? }
//   - kind: evaluate | summarize | draftProfile | suggestSalary | suggestFlags
//   - user: the request's user message, built by the extension exactly as for
//     any other model (the posting, the profile, the CV…)
//   - lang: the language the model writes its free text in (en, es, fr, pt)
//   - markets: for suggestSalary, [{ currency, period, country? }]
//   - languages: for suggestFlags, the languages the user reads postings in
//
// The instructions (system prompt), the model and the output limit are the
// server's choice, by kind: a request can't bring its own, so Tino Cloud
// can't be used as a general-purpose model on Tino's bill.
//
// Replies:
//   200 { data, model, plan, usage: { inputTokens, outputTokens }, limit, remaining, resetAt }
//   400 bad_request · 401 unauthorized · 413 too_large
//   429 quota { reason: daily | monthly | hourly | busy, resetAt?, upgrade } + Retry-After
//   503 paused (hosted scoring is switched off for now) + Retry-After
//   502/504 upstream (the model failed; the allowance was given back)

import { bearerToken, consoleLogger, errorReply, json, readJsonBody, secondsUntil, type Logger } from "./http.ts";
import { callOpenAi, requestBody } from "./openai.ts";
import type { Backend } from "./supabase.ts";

type Kind = "evaluate" | "summarize" | "draftProfile" | "suggestSalary" | "suggestFlags";

// counter: which allowance a kind spends. maxChars: the longest user message
// it takes (evaluate: a long profile plus a posting the extension already
// trimmed to 12,000 characters; draftProfile: a CV cut at 20,000).
export const KINDS: Record<Kind, { counter: "evaluation" | "helper"; maxChars: number; maxOutputTokens: number }> = {
  evaluate: { counter: "evaluation", maxChars: 40000, maxOutputTokens: 4000 },
  summarize: { counter: "evaluation", maxChars: 16000, maxOutputTokens: 3000 },
  draftProfile: { counter: "helper", maxChars: 24000, maxOutputTokens: 3000 },
  suggestSalary: { counter: "helper", maxChars: 12000, maxOutputTokens: 1500 },
  suggestFlags: { counter: "helper", maxChars: 12000, maxOutputTokens: 1000 },
};

export const MAX_BODY_BYTES = 128 * 1024;
// Under the Edge Function's own wall-clock limit (150 s on the free plan),
// and under the 3-minute lease consume_quota() takes.
export const MODEL_TIMEOUT_MS = 120_000;

export type Prompts = {
  LANGUAGES: string[];
  forKind(kind: string, options: { lang?: string; markets?: unknown; languages?: unknown }): string | null;
};

export type ScoreDeps = {
  backend: Backend;
  prompts: Prompts;
  openAiKey: string;
  fetch?: typeof fetch;
  log?: Logger;
  timeoutMs?: number;
};

type Market = { currency: string; period: string; country?: string };

export type Validated =
  | { ok: true; kind: Kind; lang: string; user: string; markets: Market[] | null; languages: string[] | null }
  | { ok: false; detail: string };

export function validate(body: Record<string, unknown>, languages: string[]): Validated {
  const kind = body.kind;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) return { ok: false, detail: "Unknown kind." };
  const spec = KINDS[kind as Kind];

  const lang = body.lang === undefined ? "en" : body.lang;
  if (typeof lang !== "string" || !languages.includes(lang)) return { ok: false, detail: "Unknown language." };

  const user = body.user;
  if (typeof user !== "string" || !user.trim()) return { ok: false, detail: "The request is empty." };
  if (user.length > spec.maxChars) return { ok: false, detail: `The request is longer than ${spec.maxChars} characters.` };

  let markets: Market[] | null = null;
  if (kind === "suggestSalary" && body.markets !== undefined) {
    const list = body.markets;
    const valid =
      Array.isArray(list) &&
      list.length <= 6 &&
      list.every(
        (m) =>
          m &&
          typeof m === "object" &&
          typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency) &&
          (m.period === "year" || m.period === "month") &&
          (m.country === undefined || m.country === null || (typeof m.country === "string" && /^[A-Z]{2}$/.test(m.country)))
      );
    if (!valid) return { ok: false, detail: "Invalid markets." };
    // Rebuilt from the checked fields only: nothing else reaches the prompt.
    markets = (list as Market[]).map((m) => ({ currency: m.currency, period: m.period, ...(m.country ? { country: m.country } : {}) }));
  }

  let readLanguages: string[] | null = null;
  if (kind === "suggestFlags" && body.languages !== undefined) {
    const list = body.languages;
    if (!Array.isArray(list) || list.length > languages.length || !list.every((l) => typeof l === "string" && languages.includes(l))) {
      return { ok: false, detail: "Invalid languages." };
    }
    readLanguages = list as string[];
  }

  return { ok: true, kind: kind as Kind, lang, user, markets, languages: readLanguages };
}

export async function handleScore(req: Request, deps: ScoreDeps): Promise<Response> {
  const started = Date.now();
  const log = deps.log || consoleLogger;
  const done = (response: Response, fields: Record<string, unknown> = {}) => {
    log({ fn: "score", status: response.status, ms: Date.now() - started, ...fields });
    return response;
  };

  if (req.method !== "POST") return done(errorReply(405, "method_not_allowed", {}, { Allow: "POST" }));

  const token = bearerToken(req);
  const user = token ? await deps.backend.getUser(token) : null;
  if (!user) return done(errorReply(401, "unauthorized"));

  const read = await readJsonBody(req, MAX_BODY_BYTES);
  if (!read.ok) return done(read.response);
  const request = validate(read.body, deps.prompts.LANGUAGES);
  if (!request.ok) return done(errorReply(400, "bad_request", { detail: request.detail }));

  const spec = KINDS[request.kind];
  const quota = (await deps.backend.rpc("consume_quota", { p_user: user.id, p_kind: spec.counter })) as Record<string, any>;
  if (!quota || quota.ok !== true) {
    const reason = quota && typeof quota.reason === "string" ? quota.reason : "paused";
    if (reason === "paused") return done(errorReply(503, "paused", {}, { "Retry-After": "3600" }), { kind: request.kind, reason });
    const retryAfter = reason === "busy" ? Number(quota.retry_after) || 5 : secondsUntil(quota.reset_at);
    return done(
      errorReply(
        429,
        "quota",
        {
          reason,
          resetAt: quota.reset_at ?? null,
          limit: quota.limit ?? null,
          plan: quota.plan ?? null,
          upgrade: quota.plan === "free" && (reason === "daily" || reason === "hourly"),
        },
        { "Retry-After": String(retryAfter) }
      ),
      { kind: request.kind, reason }
    );
  }

  const system = deps.prompts.forKind(request.kind, { lang: request.lang, markets: request.markets, languages: request.languages });
  const result = await callOpenAi({
    apiKey: deps.openAiKey,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? MODEL_TIMEOUT_MS,
    body: requestBody({
      model: quota.model,
      reasoningEffort: quota.reasoning_effort ?? null,
      system: system as string,
      user: request.user,
      maxOutputTokens: spec.maxOutputTokens,
    }),
  });

  // Always finished, success or not: it frees the user's slot, records the
  // tokens, and on failure gives the allowance back. If the database can't be
  // reached now, the result still goes out; the slot frees itself when its
  // lease runs out.
  const fields: Record<string, unknown> = { kind: request.kind, plan: quota.plan, model: quota.model };
  try {
    await deps.backend.rpc("finish_call", {
      p_user: user.id,
      p_call: quota.call_id,
      p_ok: result.ok,
      p_input_tokens: result.usage.inputTokens,
      p_output_tokens: result.usage.outputTokens,
    });
  } catch {
    fields.finishFailed = true;
  }

  if (!result.ok) {
    if (result.failure === "timeout") return done(errorReply(504, "upstream", { reason: "timeout" }), { ...fields, failure: result.failure });
    if (result.failure === "rate_limited") {
      return done(errorReply(503, "upstream", { reason: "busy" }, { "Retry-After": "30" }), { ...fields, failure: result.failure });
    }
    return done(errorReply(502, "upstream", { reason: result.failure }), { ...fields, failure: result.failure, upstreamStatus: result.status });
  }

  return done(
    json(200, {
      data: result.data,
      model: quota.model,
      plan: quota.plan,
      usage: result.usage,
      limit: quota.limit ?? null,
      remaining: quota.remaining ?? null,
      resetAt: quota.reset_at ?? null,
    }),
    fields
  );
}
