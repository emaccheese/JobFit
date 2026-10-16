// Tino Cloud in the extension: effort levels (provider.js), signing in and
// staying signed in (tinocloud.js), scoring through it from the service worker
// (background.js callTinoCloud), and the queue pausing and resuming on its
// answers (queue.js).
const { EXT_ORIGIN, fakeIndexedDB, makeChrome, load, loadWorker, suite, tick } = require("./support");

const { check, done } = suite("tinocloud");
const CLOUD = "https://abc.supabase.co";
const SESSION = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, user: { id: "u1", email: "sam@example.test" } };

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => body,
});

// A Supabase stand-in: Auth and the functions, recording every request.
function fakeCloud({ score = () => json(200, { data: { score: 82 }, usage: { inputTokens: 1200, outputTokens: 300 }, balanceMicros: 840000, estLeft: 840 }) } = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method || "GET", headers: init.headers || {}, body });
    const path = url.replace(CLOUD, "");
    if (path === "/auth/v1/otp") return json(200, {});
    if (path === "/auth/v1/verify") return body.token === "123456" ? json(200, SESSION) : json(403, { error: "otp_expired" });
    if (path === "/auth/v1/token?grant_type=pkce") return body.auth_code === "google-code" ? json(200, SESSION) : json(400, {});
    if (path === "/auth/v1/token?grant_type=refresh_token") {
      return body.refresh_token === "rt-1" ? json(200, { ...SESSION, access_token: "at-2", refresh_token: "rt-2" }) : json(400, {});
    }
    if (path === "/auth/v1/logout") return json(204, null);
    if (path === "/functions/v1/score") return score(body, init);
    if (path === "/functions/v1/account") {
      return json(200, { email: "sam@example.test", balanceMicros: 840000, starterMicros: 1000000, levels: [{ id: "quick", estLeft: 840 }, { id: "thorough", estLeft: 33 }] });
    }
    return json(404, {});
  };
  return { fetch, requests, to: (path) => requests.filter((r) => r.url === `${CLOUD}${path}`) };
}

function setUp(ctx) {
  ctx.JOB_FIT_DEFAULTS.cloud = { url: CLOUD, publishableKey: "sb_publishable_test" };
}

(async () => {
  // --- effort levels ----------------------------------------------------------------
  const p = load(["defaults.js", "provider.js"]).JOB_FIT_PROVIDER;
  let r = p.resolve({ modelProvider: "openai", modelLevel: "thorough" });
  check("own key at Thorough: gpt-6-sol, effort low", r.model === "gpt-6-sol" && r.reasoningEffort === "low" && r.level === "thorough");
  r = p.resolve({ modelProvider: "openai", modelLevel: "careful", openai: { model: "gpt-6-astra", reasoningEffort: "high" } });
  check("…a level wins over the saved model and effort", r.model === "gpt-6-luna" && r.reasoningEffort === "medium");
  r = p.resolve({ modelProvider: "openai", modelLevel: "custom", openai: { model: "gpt-6-astra", reasoningEffort: "high" } });
  check("…Custom uses your own model and effort", r.model === "gpt-6-astra" && r.reasoningEffort === "high");
  r = p.resolve({ modelProvider: "openai", openai: { model: "gpt-6-luna", reasoningEffort: "low" } });
  check("an older own-key setup (luna, low) reads as Quick, nothing switched", r.level === "quick" && r.model === "gpt-6-luna");
  r = p.resolve({ modelProvider: "openai", openai: { model: "gpt-6-astra", reasoningEffort: "low" } });
  check("…one that matches no level stays Custom, on its own model", r.level === "custom" && r.model === "gpt-6-astra");
  r = p.resolve({ modelProvider: "tinocloud", modelLevel: "deep" });
  check("Tino Cloud: the level, and a model name that keeps levels apart", r.provider === "tinocloud" && r.level === "deep" && r.model === "tino-cloud:deep" && r.label === "Tino Cloud");
  r = p.resolve({ modelProvider: "tinocloud", modelLevel: "custom" });
  check("…Custom isn't a Tino Cloud level: Quick", r.level === "quick");
  check("…and the timeout leaves room for the server's 120 s", p.resolve({ modelProvider: "tinocloud", lmStudio: { timeoutSeconds: 60 } }).timeoutSeconds === 150);
  check("an unknown provider is LM Studio", p.resolve({ modelProvider: "something" }).provider === "lmstudio");

  // --- signing in ---------------------------------------------------------------------
  const page = (cloud, chromeOptions = {}) => {
    const mock = makeChrome(chromeOptions);
    const ctx = load(["defaults.js", "vault.js", "provider.js", "tinocloud.js"], { chrome: mock.chrome, origin: EXT_ORIGIN, indexedDB: fakeIndexedDB(), fetch: cloud.fetch });
    setUp(ctx);
    return { ctx, store: mock.store, C: ctx.JOB_FIT_CLOUD, V: ctx.JOB_FIT_VAULT };
  };

  let cloud = fakeCloud();
  let pg = page(cloud);
  check("not set up in this build: not offered", (() => {
    const bare = load(["defaults.js", "provider.js", "tinocloud.js"], { chrome: makeChrome().chrome });
    return bare.JOB_FIT_CLOUD.available() === false;
  })());
  check("a malformed email is refused before anything is sent", (await pg.C.requestCode("not an email")).error === "email" && cloud.requests.length === 0);
  check("a code is requested for the address", (await pg.C.requestCode("sam@example.test")).ok && cloud.to("/auth/v1/otp")[0].body.email === "sam@example.test" && cloud.to("/auth/v1/otp")[0].body.create_user === true);
  check("…with the project's publishable key", cloud.to("/auth/v1/otp")[0].headers.apikey === "sb_publishable_test");
  check("a wrong code is refused", (await pg.C.verifyCode("sam@example.test", "654321")).error === "code" && !(await pg.C.isSignedIn()));
  check("a code that isn't 6 digits isn't sent", (await pg.C.verifyCode("sam@example.test", "12ab")).error === "code" && cloud.to("/auth/v1/verify").length === 1);
  const signedIn = await pg.C.verifyCode("sam@example.test", "123 456");
  check("the right code signs in", signedIn.ok && signedIn.email === "sam@example.test" && (await pg.C.isSignedIn()));
  check("the session is in the vault", (await pg.V.tinoSession()).refreshToken === "rt-1");
  check("…never in storage: only a stamp and the email", !JSON.stringify(pg.store).includes("rt-1") && !JSON.stringify(pg.store).includes("at-1") && pg.store.tinoCloud.email === "sam@example.test" && pg.store.tinoCloud.sessionSavedAt > 0);

  // Google, with PKCE.
  let flowUrl = null;
  cloud = fakeCloud();
  pg = page(cloud, { authFlow: (url) => ((flowUrl = url), "https://jobfit-test.chromiumapp.org/?code=google-code") });
  const google = await pg.C.signInWithGoogle();
  const authorize = new URL(flowUrl);
  const exchange = cloud.to("/auth/v1/token?grant_type=pkce")[0];
  check("Google: Supabase's authorize page, back to the extension's redirect", authorize.origin === CLOUD && authorize.searchParams.get("provider") === "google" && authorize.searchParams.get("redirect_to") === "https://jobfit-test.chromiumapp.org/");
  check("…with a PKCE challenge, S256", authorize.searchParams.get("code_challenge_method") === "s256" && /^[A-Za-z0-9_-]{43}$/.test(authorize.searchParams.get("code_challenge")));
  const verifierHash = Buffer.from(require("crypto").createHash("sha256").update(exchange.body.code_verifier).digest()).toString("base64url");
  check("…the code is exchanged with the verifier that matches it", exchange.body.auth_code === "google-code" && verifierHash === authorize.searchParams.get("code_challenge"));
  check("…and signs in", google.ok && (await pg.C.isSignedIn()));
  cloud = fakeCloud();
  pg = page(cloud, { authFlow: null });
  check("closing the Google window is a cancel, not an error", (await pg.C.signInWithGoogle()).error === "cancelled" && !(await pg.C.isSignedIn()));

  // Staying signed in.
  cloud = fakeCloud();
  pg = page(cloud);
  await pg.C.verifyCode("sam@example.test", "123456");
  const stale = await pg.V.tinoSession();
  await pg.V.saveTinoSession({ ...stale, expiresAt: Date.now() + 10 * 1000 });
  const token = await pg.C.accessToken();
  check("a session about to expire is refreshed first", token === "at-2" && (await pg.V.tinoSession()).refreshToken === "rt-2");
  await pg.V.saveTinoSession({ ...(await pg.V.tinoSession()), refreshToken: "revoked", expiresAt: 0 });
  check("a refresh the server refuses signs out", (await pg.C.accessToken()) === null && !(await pg.C.isSignedIn()));

  // The account, and a 401 retried with a fresh token.
  cloud = fakeCloud();
  let calls = 0;
  const original = cloud.fetch;
  cloud.fetch = async (url, init) => {
    if (url.endsWith("/functions/v1/account") && calls++ === 0) return json(401, { error: "unauthorized" });
    return original(url, init);
  };
  pg = page(cloud);
  await pg.C.verifyCode("sam@example.test", "123456");
  const account = await pg.C.account();
  check("a call rejected as unauthorized refreshes the token and tries once more", account.ok && account.balanceMicros === 840000 && calls === 2);
  await pg.C.signOut();
  check("signing out ends it here and on the server", !(await pg.C.isSignedIn()) && cloud.to("/auth/v1/logout").length === 1);

  // --- scoring through Tino Cloud, from the service worker ------------------------------
  async function worker(scoreReply) {
    const c = fakeCloud({ score: scoreReply });
    const w = loadWorker({
      store: { modelProvider: "tinocloud", modelLevel: "thorough", uiLanguage: "es" },
      origin: EXT_ORIGIN,
      indexedDB: fakeIndexedDB(),
      fetch: c.fetch,
    });
    setUp(w.ctx);
    await tick(30);
    await w.ctx.JOB_FIT_CLOUD.verifyCode("sam@example.test", "123456");
    return { w, c };
  }
  const posting = "<<<POSTING\nSenior Backend Engineer. Requirements: Go, AWS. ".repeat(20) + "\nPOSTING>>>";

  let { w, c } = await worker();
  let result = await w.ctx.callLmStudio("ignored system prompt", posting, { kind: "evaluate" });
  const sent = c.to("/functions/v1/score")[0];
  check("an evaluation goes to Tino Cloud's score function", result.ok && result.data.score === 82 && sent.method === "POST");
  check("…with the kind, the level, the language and the user message, never instructions", sent.body.kind === "evaluate" && sent.body.level === "thorough" && sent.body.lang === "es" && sent.body.user === posting && !JSON.stringify(sent.body).includes("ignored system prompt"));
  check("…with the session's token", sent.headers.Authorization === "Bearer at-1");
  check("…its usage counted under Tino Cloud", (() => {
    const day = Object.values(w.store.usageByDay || {})[0] || {};
    return day.tinocloud && day.tinocloud.input === 1200 && day.tinocloud.requests === 1;
  })());
  check("…and the balance kept for the popup and card", w.store.tinoCloudBalance.balanceMicros === 840000 && w.store.tinoCloudBalance.estLeft === 840);
  result = await w.ctx.callLmStudio("x", "CANDIDATE PROFILE:\nGo", { kind: "suggestFlags", extra: { languages: ["en", "es"] } });
  check("a helper call carries its kind and extras", c.to("/functions/v1/score")[1].body.kind === "suggestFlags" && c.to("/functions/v1/score")[1].body.languages.join() === "en,es");

  ({ w, c } = await worker(() => json(402, { error: "credit", balanceMicros: 400, level: "thorough" })));
  result = await w.ctx.callLmStudio("x", posting, { kind: "evaluate" });
  check("out of credit (402) → failure credit, with a message saying what to do", !result.ok && result.failure === "credit" && /Tino Cloud/.test(result.error));
  check("…and the balance noted", w.store.tinoCloudBalance.balanceMicros === 400);

  const later = new Date(Date.now() + 40 * 60 * 1000).toISOString();
  ({ w, c } = await worker(() => json(429, { error: "quota", reason: "hourly", resetAt: later }, { "Retry-After": "2400" })));
  result = await w.ctx.callLmStudio("x", posting, { kind: "evaluate" });
  check("the hourly brake (429) → failure quota, retried when it lifts", !result.ok && result.failure === "quota" && result.retryAt === Date.parse(later));
  ({ w, c } = await worker(() => json(503, { error: "paused" }, { "Retry-After": "3600" })));
  result = await w.ctx.callLmStudio("x", posting, { kind: "evaluate" });
  check("hosted scoring paused (503) → quota, retried in an hour", result.failure === "quota" && result.retryAt > Date.now() + 3500 * 1000);
  ({ w, c } = await worker(() => json(502, { error: "upstream", reason: "parse" })));
  result = await w.ctx.callLmStudio("x", posting, { kind: "evaluate" });
  check("the model failing upstream (502) → http, saying nothing was charged (here in Spanish)", result.failure === "http" && /502/.test(result.error) && /No se cobró nada/.test(result.error));

  const signedOut = loadWorker({ store: { modelProvider: "tinocloud" }, origin: EXT_ORIGIN, indexedDB: fakeIndexedDB(), fetch: fakeCloud().fetch });
  setUp(signedOut.ctx);
  result = await signedOut.ctx.callLmStudio("x", posting, { kind: "evaluate" });
  check("signed out → failure config, saying to sign in", result.failure === "config" && /Sign in/i.test(result.error));

  // --- the queue: pauses that end by themselves -------------------------------------------
  const q = load(["queue.js"], { chrome: makeChrome().chrome }).JOB_FIT_QUEUE;
  check("credit and quota pause the queue", q.shouldPause("credit", 0) && q.shouldPause("quota", 0));
  const now = Date.UTC(2026, 9, 14, 15, 0);
  check("a quota pause ends when Tino Cloud said", q.pauseEndsAt({ failure: "quota", retryAt: now + 40 * 60 * 1000 }, now) === now + 40 * 60 * 1000);
  const midnight = new Date(q.pauseEndsAt({ failure: "budget" }, now));
  check("the OpenAI daily budget's pause ends just after local midnight", midnight.getHours() === 0 && midnight.getMinutes() === 1 && midnight.getTime() > now);
  check("out of credit doesn't end by itself", q.pauseEndsAt({ failure: "credit" }, now) === null);

  const scheduled = [];
  const qm = makeChrome();
  const queueCtx = load(["queue.js"], { chrome: qm.chrome });
  const Q = queueCtx.JOB_FIT_QUEUE;
  let clock = now;
  Q.configure({
    evaluate: async () => ({ ok: false, failure: "quota", retryAt: now + 30 * 60 * 1000, error: "brake" }),
    scheduleResume: async (when) => scheduled.push(when),
    now: () => clock,
  });
  await Q.enqueue({ kind: "evaluate", jobKey: "linkedin:1", profileId: "p1", postingText: "x" });
  await Q.pump();
  let snap = await Q.snapshot();
  check("a quota pause keeps the job and schedules the resume", snap.state === "paused" && snap.pauseFailure === "quota" && snap.pauseUntil === now + 30 * 60 * 1000 && scheduled[0] === snap.pauseUntil && snap.items[0].state === "pending");
  check("the alarm firing early doesn't resume it", (await Q.resumeIfDue()) === false);
  clock = now + 30 * 60 * 1000;
  check("at the time, it resumes", (await Q.resumeIfDue()) === true && (await Q.snapshot()).state === "running");

  done();
})();
