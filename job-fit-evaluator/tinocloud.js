// Tino Cloud from the extension's side: signing in, staying signed in, and
// calling the server (cloud/supabase/functions). Used by the service worker
// (scoring) and by Settings and the wizard (signing in, the account box).
// Never by scripts on job pages: the session lives in the vault, which they
// can't reach.
//
// Signing in uses Supabase Auth's own API with fetch, no SDK:
// - a 6-digit code by email: POST /auth/v1/otp, then /auth/v1/verify;
// - Google: chrome.identity.launchWebAuthFlow on /auth/v1/authorize with PKCE
//   (a one-time secret only this extension knows, so a code intercepted on
//   the way back is useless), then /auth/v1/token?grant_type=pkce.
// The session (access and refresh tokens) is refreshed a minute before it
// expires. Signing out, or a refresh the server refuses, clears it.
//
// Assigned with var so a page that loads it twice doesn't throw.
var JOB_FIT_CLOUD = (function () {
  const REFRESH_MARGIN_MS = 60 * 1000;
  const REQUEST_TIMEOUT_MS = 20 * 1000;

  function base() {
    return JOB_FIT_PROVIDER.cloudUrl();
  }

  function publishableKey() {
    return String((JOB_FIT_DEFAULTS.cloud && JOB_FIT_DEFAULTS.cloud.publishableKey) || "");
  }

  // Configured: the project exists and the extension knows where it is.
  function available() {
    return Boolean(base() && publishableKey());
  }

  async function request(url, { method = "GET", headers = {}, body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: { apikey: publishableKey(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = await resp.json().catch(() => null);
      return { ok: resp.ok, status: resp.status, json, headers: resp.headers };
    } catch (err) {
      if (signal && signal.aborted) return { ok: false, status: 0, error: "cancelled" };
      return { ok: false, status: 0, error: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  // --- the session -------------------------------------------------------------------

  function sessionFrom(data) {
    if (!data || !data.access_token || !data.refresh_token) return null;
    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      email: (data.user && data.user.email) || "",
      userId: (data.user && data.user.id) || "",
    };
  }

  // Into the vault, with a stamp in storage so the other pages and the worker
  // notice (vault writes fire no storage event). The email is kept beside the
  // stamp for display; it's no secret, and the popup can't read the vault.
  async function saveSession(session) {
    await JOB_FIT_VAULT.saveTinoSession(session);
    await chrome.storage.local.set({ tinoCloud: { sessionSavedAt: Date.now(), email: (session && session.email) || "" } });
  }

  async function isSignedIn() {
    return Boolean(await JOB_FIT_VAULT.tinoSession());
  }

  let refreshing = null;

  // A fresh access token, refreshing the session when it's about to expire
  // (or when `force`d, after the server said the token was no good). Null when
  // signed out, or when the refresh token was refused: then the session is
  // cleared and the user signs in again.
  async function accessToken({ force = false } = {}) {
    const session = await JOB_FIT_VAULT.tinoSession();
    if (!session) return null;
    if (!force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
    if (!refreshing) {
      refreshing = (async () => {
        const resp = await request(`${base()}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          body: { refresh_token: session.refreshToken },
        });
        if (resp.ok) {
          const next = sessionFrom(resp.json);
          if (next) {
            await saveSession({ ...next, email: next.email || session.email, userId: next.userId || session.userId });
            return next.accessToken;
          }
        }
        // Refused (revoked, or the account deleted): signed out. Can't reach
        // the server: keep the session, and try again next time.
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) await saveSession(null);
        return null;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  // --- signing in -------------------------------------------------------------------

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Sends the 6-digit code. { ok } or { ok: false, error: "email" | "rate" | "unreachable" | "failed" }.
  async function requestCode(email) {
    const address = String(email || "").trim();
    if (!EMAIL.test(address) || address.length > 254) return { ok: false, error: "email" };
    const resp = await request(`${base()}/auth/v1/otp`, { method: "POST", body: { email: address, create_user: true } });
    if (resp.ok) return { ok: true };
    if (resp.status === 429) return { ok: false, error: "rate" };
    if (resp.status === 0) return { ok: false, error: "unreachable" };
    return { ok: false, error: "failed" };
  }

  // { ok, email } or { ok: false, error: "code" | "unreachable" | "failed" }.
  async function verifyCode(email, code) {
    const token = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(token)) return { ok: false, error: "code" };
    const resp = await request(`${base()}/auth/v1/verify`, {
      method: "POST",
      body: { type: "email", email: String(email || "").trim(), token },
    });
    const session = resp.ok ? sessionFrom(resp.json) : null;
    if (session) {
      await saveSession(session);
      return { ok: true, email: session.email };
    }
    if (resp.status === 0) return { ok: false, error: "unreachable" };
    return { ok: false, error: resp.status >= 400 && resp.status < 500 ? "code" : "failed" };
  }

  function base64url(bytes) {
    let text = "";
    new Uint8Array(bytes).forEach((b) => (text += String.fromCharCode(b)));
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function pkcePair() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    return { verifier, challenge };
  }

  // Google, in a Chrome sign-in window. { ok, email } or { ok: false, error: "cancelled" | "failed" | "unreachable" }.
  async function signInWithGoogle() {
    const { verifier, challenge } = await pkcePair();
    const redirect = chrome.identity.getRedirectURL();
    const url =
      `${base()}/auth/v1/authorize?provider=google` +
      `&redirect_to=${encodeURIComponent(redirect)}` +
      `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=s256`;
    let responseUrl;
    try {
      responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (err) {
      // Closing the window is the common case.
      return { ok: false, error: "cancelled" };
    }
    let code = null;
    try {
      const back = new URL(responseUrl);
      // Only from our own redirect: launchWebAuthFlow ends there, but checking
      // costs nothing.
      if (!responseUrl.startsWith(redirect)) return { ok: false, error: "failed" };
      code = back.searchParams.get("code");
    } catch (err) {
      return { ok: false, error: "failed" };
    }
    if (!code) return { ok: false, error: "cancelled" };
    const resp = await request(`${base()}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      body: { auth_code: code, code_verifier: verifier },
    });
    const session = resp.ok ? sessionFrom(resp.json) : null;
    if (!session) return { ok: false, error: resp.status === 0 ? "unreachable" : "failed" };
    await saveSession(session);
    return { ok: true, email: session.email };
  }

  // Ends the session on the server too (best effort), then here.
  async function signOut() {
    const session = await JOB_FIT_VAULT.tinoSession();
    if (session) {
      await request(`${base()}/auth/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.accessToken}` } });
    }
    await saveSession(null);
  }

  // --- the server's functions -------------------------------------------------------

  // A call to one of the Edge Functions with the user's token. A 401 refreshes
  // the session once and tries again. { ok, status, json, headers } or
  // { ok: false, status: 401, error: "signedOut" }.
  async function callFunction(name, { method = "GET", body, signal, timeoutMs } = {}) {
    let token = await accessToken();
    if (!token) return { ok: false, status: 401, error: "signedOut" };
    const go = (t) =>
      request(`${base()}/functions/v1/${name}`, { method, body, signal, timeoutMs, headers: { Authorization: `Bearer ${t}` } });
    let resp = await go(token);
    if (resp.status === 401) {
      token = await accessToken({ force: true });
      if (!token) return { ok: false, status: 401, error: "signedOut" };
      resp = await go(token);
    }
    return resp;
  }

  // The balance and the levels: { email, balanceMicros, starterMicros, levels, rechargeInterestAt }.
  async function account() {
    const resp = await callFunction("account");
    return resp.ok ? { ok: true, ...resp.json } : { ok: false, status: resp.status, error: resp.error || (resp.json && resp.json.error) || "failed" };
  }

  async function registerInterest() {
    const resp = await callFunction("account", { method: "POST", body: { rechargeInterest: true } });
    return resp.ok ? { ok: true, ...resp.json } : { ok: false, status: resp.status };
  }

  // Deletes the account on the server, then signs out here.
  async function deleteAccount() {
    const resp = await callFunction("delete-account", { method: "POST", body: { confirm: "delete" } });
    if (resp.ok) await saveSession(null);
    return { ok: resp.ok, status: resp.status, error: resp.json && resp.json.error };
  }

  // One model call: { kind, level, lang, user, markets?, languages? }.
  function score(body, { signal, timeoutMs } = {}) {
    return callFunction("score", { method: "POST", body, signal, timeoutMs });
  }

  return {
    available,
    isSignedIn,
    accessToken,
    requestCode,
    verifyCode,
    signInWithGoogle,
    signOut,
    account,
    registerInterest,
    deleteAccount,
    score,
    // For tests.
    sessionFrom,
    pkcePair,
  };
})();
