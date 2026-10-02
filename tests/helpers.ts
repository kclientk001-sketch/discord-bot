import { Store } from "../server/store.js";
import { Secrets } from "../server/security.js";
import { Vault } from "../server/auth/vault.js";
import { OAuth } from "../server/auth/oauth.js";
import { Engine } from "../server/engine.js";
import type { Fetcher } from "../server/http.js";
export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const fake = (
  fn: (url: string, init: RequestInit) => Promise<Response> | Response,
): Fetcher =>
  (async (url: any, init?: RequestInit) =>
    fn(String(url), init ?? {})) as Fetcher;
export function fixture(fetcher = fake(() => json({}))) {
  const store = new Store(":memory:"),
    vault = new Vault(new Secrets()),
    oauth = new OAuth(vault, "http://127.0.0.1:3210", fetcher),
    engine = new Engine(store, vault, oauth, fetcher);
  return { store, vault, oauth, engine };
}
export const user = {
  id: "123456789012345678",
  username: "nghiencuu",
  global_name: "Người dùng thử",
  avatar: "abc123",
  bot: false,
};
export const userProfile = {
  mode: "user-token" as const,
  token: "FAKE_USER_SECRET_NOT_REAL",
  persist: false,
  acceptedRisk: true,
};
export function seedSpotify(vault: Vault) {
  vault.put("oauth-spotify", {
    profile: { clientId: "FAKE_CLIENT_ID", persist: false },
    access_token: "FAKE_SPOTIFY_ACCESS",
    refresh_token: "FAKE_SPOTIFY_REFRESH",
    expiresAt: Date.now() + 3600000,
    scope: "user-read-currently-playing",
  });
}
export const track = (id = "FAKE_ID", name = "Bài thử") => ({
  id,
  name,
  duration_ms: 120000,
  artists: [{ name: "Nghệ sĩ thử" }],
});
