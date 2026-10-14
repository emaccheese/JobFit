// The call to OpenAI's Responses API, as the extension makes it with a user's
// own key (background.js openAiRequestBody/readOpenAiResponse), minus what
// only matters there: the model is fixed per plan, so there's nothing to
// learn about what it rejects, and no Flex.

export type OpenAiUsage = { inputTokens: number; outputTokens: number };

export type OpenAiResult =
  | { ok: true; data: Record<string, unknown>; usage: OpenAiUsage }
  | { ok: false; failure: "timeout" | "unreachable" | "rate_limited" | "http" | "refusal" | "length" | "empty" | "parse"; status?: number; usage: OpenAiUsage };

export function requestBody({ model, reasoningEffort, system, user, maxOutputTokens }: {
  model: string;
  reasoningEffort: string | null;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Record<string, unknown> {
  return {
    model,
    // JSON mode needs the word "JSON" in the input: the instructions say it,
    // so they go in as a developer message.
    input: [
      { role: "developer", content: system },
      { role: "user", content: user },
    ],
    text: { format: { type: "json_object" } },
    max_output_tokens: maxOutputTokens,
    // Nothing here ever retrieves a response, and the input is a CV.
    store: false,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : { temperature: 0.2 }),
  };
}

export function usageFrom(data: unknown): OpenAiUsage {
  const usage = (data && typeof data === "object" ? (data as Record<string, any>).usage : null) || {};
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
}

// The assistant's text from a Responses reply, or why there is none.
export function readText(data: any): { ok: true; text: string } | { ok: false; failure: "refusal" | "length" | "empty" } {
  const parts = (Array.isArray(data?.output) ? data.output : [])
    .filter((item: any) => item && item.type === "message")
    .flatMap((item: any) => (Array.isArray(item.content) ? item.content : []));
  if (parts.some((p: any) => p.type === "refusal")) return { ok: false, failure: "refusal" };
  const text = parts
    .filter((p: any) => p.type === "output_text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
  if (text.trim()) return { ok: true, text };
  if (data?.status === "incomplete" && data?.incomplete_details?.reason === "max_output_tokens") return { ok: false, failure: "length" };
  return { ok: false, failure: "empty" };
}

// JSON mode returns a JSON object; the fallback takes the outermost {…} in
// case a model wraps it anyway.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const attempt = (s: string) => {
    try {
      const value = JSON.parse(s);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(text.trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? attempt(text.slice(start, end + 1)) : null;
}

export async function callOpenAi({ apiKey, body, timeoutMs, fetch: doFetch = fetch }: {
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Promise<OpenAiResult> {
  const none = { inputTokens: 0, outputTokens: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await doFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, failure: controller.signal.aborted ? "timeout" : "unreachable", usage: none };
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    return { ok: false, failure: resp.status === 429 ? "rate_limited" : "http", status: resp.status, usage: none };
  }
  const data = await resp.json().catch(() => null);
  // Billed whatever happens next, so it's counted whatever happens next.
  const usage = usageFrom(data);
  const read = readText(data);
  if (!read.ok) return { ok: false, failure: read.failure, usage };
  const parsed = parseJsonObject(read.text);
  if (!parsed) return { ok: false, failure: "parse", usage };
  return { ok: true, data: parsed, usage };
}
