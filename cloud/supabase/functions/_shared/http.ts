// Small helpers shared by the Edge Functions: JSON replies, the bearer token,
// and reading a request body with a size limit.
//
// No CORS headers anywhere: the only client is the extension's service
// worker, which reaches this host through its host permissions and doesn't
// need them. A web page shouldn't be able to call these from a browser.

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorReply(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json(status, { error, ...extra }, headers);
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

// The body as a JSON object, refused before parsing when it's larger than
// maxBytes: what it may hold is capped per field later, but nothing should
// read a megabyte to find that out.
export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const declared = Number(req.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return { ok: false, response: errorReply(413, "too_large") };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, response: errorReply(413, "too_large") };
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, response: errorReply(400, "bad_request", { detail: "The body isn't JSON." }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: errorReply(400, "bad_request", { detail: "The body must be a JSON object." }) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

// Seconds from now until an ISO time, at least 1: for Retry-After.
export function secondsUntil(iso: unknown, now: number = Date.now()): number {
  const at = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 1000)) : 60;
}

// One line per request, for the function logs: never a body, a token or an
// email, only what's needed to see the service working.
export type Logger = (entry: Record<string, unknown>) => void;
export const consoleLogger: Logger = (entry) => console.log(JSON.stringify(entry));
