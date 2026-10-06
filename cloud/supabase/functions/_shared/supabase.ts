// What the functions need from Supabase, over its HTTP APIs with plain fetch:
// who a session token belongs to (Auth), the database functions (PostgREST
// RPC, as the service role), and deleting a user (Auth admin). No SDK, so
// there's nothing to install and the tests can stand in for all three.

export type User = { id: string; email: string | null };

export interface Backend {
  getUser(token: string): Promise<User | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  deleteUser(id: string): Promise<boolean>;
}

type Fetch = typeof fetch;

// Supabase's newer secret keys (sb_secret_…) go in the apikey header only;
// the older service_role key is a JWT and goes in Authorization as well.
function serviceHeaders(serviceKey: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: serviceKey };
  if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;
  return headers;
}

export function supabaseBackend({ url, serviceKey, fetch: doFetch = fetch }: { url: string; serviceKey: string; fetch?: Fetch }): Backend {
  const base = url.replace(/\/+$/, "");
  return {
    // Asks Auth itself, so a revoked or signed-out session is refused even
    // though its JWT hasn't expired yet.
    async getUser(token) {
      const resp = await doFetch(`${base}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return null;
      const user = await resp.json().catch(() => null);
      return user && typeof user.id === "string" ? { id: user.id, email: typeof user.email === "string" ? user.email : null } : null;
    },

    async rpc(name, args) {
      const resp = await doFetch(`${base}/rest/v1/rpc/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { ...serviceHeaders(serviceKey), "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!resp.ok) throw new Error(`rpc ${name} failed: ${resp.status}`);
      return resp.json();
    },

    async deleteUser(id) {
      const resp = await doFetch(`${base}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: serviceHeaders(serviceKey),
      });
      return resp.ok;
    },
  };
}
