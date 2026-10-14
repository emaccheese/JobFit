// POST /score — one model call on Tino Cloud, paid from the user's credit.
//
// Request (Authorization: Bearer <the user's session token>):
//   { kind, level?, lang?, user, markets?, languages? }
//   - kind: evaluate | summarize | draftProfile | suggestSalary | suggestFlags
//   - level: quick (the default) | careful | thorough | deep — the model and
//     reasoning effort, and so how fast the credit goes (the `levels` table)
//   - user: the request's user message, built by the extension exactly as for
//     any other model (the posting, the profile, the CV…)
//   - lang: the language the model writes its free text in (en, es, fr, pt)
//   - markets: for suggestSalary, [{ currency, period, country? }]
//   - languages: for suggestFlags, the languages the user reads postings in
//
// The instructions (system prompt), the output limit and, through the level,
// the model are the server's choice: a request can't bring its own, so Tino
// Cloud can't be used as a general-purpose model on Tino's bill.
//
// Replies:
//   200 { data, model, level, usage: { inputTokens, outputTokens }, chargedMicros, balanceMicros, estLeft }
//   400 bad_request (also an unknown or switched-off level) · 401 unauthorized · 413 too_large
//   402 credit { balanceMicros, level }: not enough credit for a call at this level
//   429 quota { reason: hourly | busy, resetAt? } + Retry-After
//   503 paused (hosted scoring is switched off for now) + Retry-After
//   502/504 upstream (the model failed; nothing was charged)

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
  | { ok: true; kind: Kind; level: string; lang: string; user: string; markets: Market[] | null; languages: string[] | null }
  | { ok: false; detail: string };

export function validate(body: Record<string, unknown>, languages: string[]): Validated {
  const kind = body.kind;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) return { ok: false, detail: "Unknown kind." };
  const spec = KINDS[kind as Kind];

  // Checked against the levels table by consume_quota; here only its shape.
  const level = body.level === undefined ? "quick" : body.level;
  if (typeof level !== "string" || !/^[a-z]{1,20}$/.test(level)) return { ok: false, detail: "Unknown level." };

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

  return { ok: true, kind: kind as Kind, level, lang, user, markets, languages: readLanguages };
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
  const system = deps.prompts.forKind(request.kind, { lang: request.lang, markets: request.markets, languages: request.languages }) as string;
  // The most this call can use, for the credit it reserves: about one token
  // per 3 characters at most (usually 4), and the kind's output cap.
  const quota = (await deps.backend.rpc("consume_quota", {
    p_user: user.id,
    p_kind: spec.counter,
    p_level: request.level,
    p_max_input_tokens: Math.ceil((system.length + request.user.length) / 3),
    p_max_output_tokens: spec.maxOutputTokens,
  })) as Record<string, any>;
  if (!quota || quota.ok !== true) {
    const reason = quota && typeof quota.reason === "string" ? quota.reason : "paused";
    const fields = { kind: request.kind, level: request.level, reason };
    if (reason === "paused") return done(errorReply(503, "paused", {}, { "Retry-After": "3600" }), fields);
    if (reason === "level") return done(errorReply(400, "bad_request", { detail: "Unknown level." }), fields);
    if (reason === "credit") {
      return done(errorReply(402, "credit", { balanceMicros: Number(quota.balance_micros) || 0, level: quota.level ?? request.level }), fields);
    }
    const retryAfter = reason === "busy" ? Number(quota.retry_after) || 5 : secondsUntil(quota.reset_at);
    return done(errorReply(429, "quota", { reason, resetAt: quota.reset_at ?? null }, { "Retry-After": String(retryAfter) }), fields);
  }

  const result = await callOpenAi({
    apiKey: deps.openAiKey,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? MODEL_TIMEOUT_MS,
    body: requestBody({
      model: quota.model,
      reasoningEffort: quota.reasoning_effort ?? null,
      system,
      user: request.user,
      maxOutputTokens: spec.maxOutputTokens,
    }),
  });

  // Always finished, success or not: it charges what the call cost (nothing
  // if it failed) and gives back the rest of the reserve, frees the user's
  // slot and records the tokens. If the database can't be reached now, the
  // result still goes out; the slot frees itself when its lease runs out.
  const fields: Record<string, unknown> = { kind: request.kind, level: quota.level, model: quota.model };
  let settled: Record<string, any> | null = null;
  try {
    settled = (await deps.backend.rpc("finish_call", {
      p_user: user.id,
      p_call: quota.call_id,
      p_ok: result.ok,
      p_input_tokens: result.usage.inputTokens,
      p_output_tokens: result.usage.outputTokens,
    })) as Record<string, any>;
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
      level: quota.level,
      usage: result.usage,
      chargedMicros: settled ? Number(settled.charged_micros) || 0 : null,
      balanceMicros: settled ? Number(settled.balance_micros) : null,
      estLeft: settled && settled.est_left != null ? Number(settled.est_left) : null,
    }),
    fields
  );
}
