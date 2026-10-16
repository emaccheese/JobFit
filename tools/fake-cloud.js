#!/usr/bin/env node
// A stand-in for Tino Cloud (Supabase Auth plus the score and account
// functions), for trying the extension's Tino Cloud screens before a real
// project exists. In memory, no dependencies. Never for real use: any email
// gets in with the code 123456.
//
// Usage: node tools/fake-cloud.js [port]   (default 8787)
// Point a development copy at it by setting JOB_FIT_DEFAULTS.cloud to
//   { url: "http://127.0.0.1:8787", publishableKey: "fake" }
//
// To try the edge cases, while it runs:
//   POST /__fake { "balanceMicros": 0 }       out of credit
//   POST /__fake { "next": 429 }              the hourly brake, once
//   POST /__fake { "next": 503 }              hosted scoring paused, once
const http = require("http");

const PORT = Number(process.argv[2]) || 8787;
const LEVELS = [
  { id: "quick", model: "gpt-6-luna", reasoning_effort: "low", cost: 1000 },
  { id: "careful", model: "gpt-6-luna", reasoning_effort: "medium", cost: 2000 },
  { id: "thorough", model: "gpt-6-sol", reasoning_effort: "low", cost: 25000 },
  { id: "deep", model: "gpt-6-sol", reasoning_effort: "medium", cost: 40000 },
];

const state = { balanceMicros: 1000000, starterMicros: 1000000, email: null, interestAt: null, next: null, tokens: new Set() };

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    // The extension needs no CORS (host permissions); a page served from a
    // development server does.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
    ...headers,
  });
  res.end(body == null ? "" : JSON.stringify(body));
}

function session(email) {
  const access = `fake-access-${Math.random().toString(36).slice(2)}`;
  state.tokens.add(access);
  return { access_token: access, refresh_token: `fake-refresh-${Date.now()}`, expires_in: 3600, user: { id: "fake-user", email } };
}

function authorized(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  return state.tokens.has(token);
}

function account() {
  return {
    email: state.email,
    balanceMicros: state.balanceMicros,
    starterMicros: state.starterMicros,
    rechargeInterestAt: state.interestAt,
    levels: LEVELS.map((l) => ({ id: l.id, model: l.model, effort: l.reasoning_effort, costMicros: l.cost, estLeft: Math.floor(state.balanceMicros / l.cost) })),
  };
}

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, null);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url;

      if (url === "/__fake") {
        Object.assign(state, body);
        return send(res, 200, { ok: true, balanceMicros: state.balanceMicros, next: state.next });
      }
      if (url === "/auth/v1/otp") {
        state.email = body.email;
        console.log(`code for ${body.email}: 123456`);
        return send(res, 200, {});
      }
      if (url === "/auth/v1/verify") return body.token === "123456" ? send(res, 200, session(body.email)) : send(res, 403, { error: "otp_expired" });
      if (url.startsWith("/auth/v1/token")) return send(res, 200, session(state.email || "you@example.test"));
      if (url === "/auth/v1/logout") return send(res, 204, null);

      if (url.startsWith("/functions/v1/") && !authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (url === "/functions/v1/account") {
        if (req.method === "POST" && body.rechargeInterest) state.interestAt = state.interestAt || new Date().toISOString();
        return send(res, 200, account());
      }
      if (url === "/functions/v1/delete-account") {
        state.email = null;
        state.tokens.clear();
        return send(res, 200, { deleted: true });
      }
      if (url === "/functions/v1/score") {
        const level = LEVELS.find((l) => l.id === (body.level || "quick"));
        if (!level) return send(res, 400, { error: "bad_request", detail: "Unknown level." });
        if (state.next === 429) {
          state.next = null;
          return send(res, 429, { error: "quota", reason: "hourly", resetAt: new Date(Date.now() + 120000).toISOString() }, { "Retry-After": "120" });
        }
        if (state.next === 503) {
          state.next = null;
          return send(res, 503, { error: "paused" }, { "Retry-After": "120" });
        }
        if (state.balanceMicros < level.cost) return send(res, 402, { error: "credit", balanceMicros: state.balanceMicros, level: level.id });
        state.balanceMicros -= level.cost;
        // An answer shaped like the evaluator's, made up.
        const data =
          body.kind === "evaluate"
            ? { score: 78, verdict: "apply", location: "remote", sponsorship: "unstated", matches: ["Go", "AWS"], gaps: ["Kubernetes"], required_gaps: [], salary: { posting_stated: "not stated", posting_stated_min: null, posting_stated_max: null, estimated_market_min: 120000, estimated_market_max: 150000, estimated_market_currency: "USD", note: "" }, one_line: "A good match on the backend work; Kubernetes is the gap." }
            : { terms: ["Kubernetes", "machine learning"] };
        return send(res, 200, { data, model: level.model, level: level.id, usage: { inputTokens: 4200, outputTokens: 600 }, chargedMicros: level.cost, balanceMicros: state.balanceMicros, estLeft: Math.floor(state.balanceMicros / level.cost) });
      }
      send(res, 404, { error: "not_found" });
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake Tino Cloud on http://127.0.0.1:${PORT} (sign-in code: 123456)`));
