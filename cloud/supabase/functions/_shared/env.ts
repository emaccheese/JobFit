// Wires the handlers to the real world, from the function's environment.
// Only the Deno entry points (*/index.ts) import this; the tests pass their
// own stand-ins to the handlers instead.
//
// Set by Supabase in every Edge Function: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Set by you (supabase secrets set …): OPENAI_API_KEY, and later the billing
// provider's keys. See cloud/README.md.

import { JOB_FIT_PROMPTS } from "./prompts.js";
import { supabaseBackend, type Backend } from "./supabase.ts";
import type { BillingProvider } from "./billing.ts";
import type { Prompts } from "./score.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function backend(): Backend {
  return supabaseBackend({ url: required("SUPABASE_URL"), serviceKey: required("SUPABASE_SERVICE_ROLE_KEY") });
}

export function prompts(): Prompts {
  return JOB_FIT_PROMPTS as Prompts;
}

export function openAiKey(): string {
  return required("OPENAI_API_KEY");
}

// The merchant of record's adapter, once one is chosen. null: checkout and
// the webhook answer 501 billing_not_configured.
export function billingProvider(): BillingProvider | null {
  return null;
}
