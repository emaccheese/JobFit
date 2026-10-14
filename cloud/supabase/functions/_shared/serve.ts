// The Deno entry points' common shell: an unexpected error becomes a plain
// 500 with nothing from the error in it, and is logged without the request.

import { consoleLogger, errorReply } from "./http.ts";

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): unknown };

export function serve(fn: string, handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      consoleLogger({ fn, status: 500, error: err instanceof Error ? err.message : "unknown" });
      return errorReply(500, "internal");
    }
  });
}
