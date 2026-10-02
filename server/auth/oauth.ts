import { randomBytes, createHash } from "node:crypto";
import { requestJson, type Fetcher } from "../http.js";
import { AppError } from "../security.js";
import { Vault } from "./vault.js";
export type Provider = "discord" | "spotify";
interface Profile {
  clientId: string;
  clientSecret?: string;
  persist: boolean;
}
interface Session {
  profile: Profile;
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
  scope: string;
}
const endpoints = {
  discord: {
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    scope: "identify",
  },
  spotify: {
    authorize: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scope: "user-read-currently-playing",
  },
};
export class OAuth {
  private pending = new Map<
    string,
    {
      provider: Provider;
      owner: string;
      profile: Profile;
      verifier: string;
      expires: number;
    }
  >();
  private refreshes = new Map<Provider, Promise<Session>>();
  constructor(
    private vault: Vault,
    public origin: string,
    private fetcher: Fetcher = fetch,
  ) {}
  start(provider: Provider, profile: Profile, owner: string) {
    this.vault.assertPersistence(profile.persist);
    this.vault.secrets.register(profile);
    if (!profile.clientId || (provider === "discord" && !profile.clientSecret))
      throw new AppError("validation", "Thiếu Client ID hoặc Client Secret.");
    if (provider === "spotify" && new URL(this.origin).hostname === "localhost")
      throw new AppError(
        "validation",
        "Spotify cần địa chỉ loopback IP 127.0.0.1, không dùng localhost.",
      );
    const now = Date.now();
    for (const [key, v] of this.pending)
      if (v.expires < now) this.pending.delete(key);
    if (this.pending.size >= 20)
      throw new AppError(
        "rate-limit",
        "Có quá nhiều yêu cầu OAuth đang chờ.",
        60000,
        429,
      );
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, {
      provider,
      owner,
      profile,
      verifier,
      expires: now + 600000,
    });
    const url = new URL(endpoints[provider].authorize);
    url.search = new URLSearchParams({
      client_id: profile.clientId,
      response_type: "code",
      redirect_uri: this.redirect(provider),
      scope: endpoints[provider].scope,
      state,
    }).toString();
    if (provider === "spotify") {
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
    }
    return url.toString();
  }
  private redirect(p: Provider) {
    return `${this.origin}/api/oauth/${p}/callback`;
  }
  private async exchange(
    provider: Provider,
    profile: Profile,
    params: URLSearchParams,
    previous?: Session,
  ) {
    params.set("client_id", profile.clientId);
    if (provider === "discord")
      params.set("client_secret", profile.clientSecret!);
    const { data } = await requestJson<any>(
      endpoints[provider].token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
      this.fetcher,
    );
    if (
      typeof data?.access_token !== "string" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new AppError("service", "Phản hồi OAuth không hợp lệ.");
    const scope =
      typeof data.scope === "string" ? data.scope : (previous?.scope ?? "");
    if (!scope.split(" ").includes(endpoints[provider].scope))
      throw new AppError(
        "auth",
        "Phiên OAuth không có quyền tối thiểu đã yêu cầu.",
      );
    const s: Session = {
      profile,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? previous?.refresh_token,
      scope,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.vault.put(`oauth-${provider}`, s, profile.persist);
    return s;
  }
  async finish(provider: Provider, state: string, code: string, owner: string) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (
      !p ||
      p.provider !== provider ||
      p.owner !== owner ||
      p.expires < Date.now()
    )
      throw new AppError(
        "auth",
        "OAuth state không hợp lệ, hết hạn hoặc không thuộc phiên dashboard.",
      );
    this.vault.secrets.add(code);
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirect(provider),
    });
    if (provider === "spotify") params.set("code_verifier", p.verifier);
    return this.exchange(provider, p.profile, params);
  }
  async session(provider: Provider, force = false): Promise<Session> {
    const s = this.vault.get<Session>(`oauth-${provider}`);
    if (!s)
      throw new AppError("auth", "Chưa có phiên OAuth; hãy kết nối nguồn.");
    if (!force && s.expiresAt > Date.now() + 30000) return s;
    if (!s.refresh_token)
      throw new AppError(
        "auth",
        "Phiên OAuth hết hạn và không có refresh token.",
      );
    let job = this.refreshes.get(provider);
    if (!job) {
      job = this.exchange(
        provider,
        s.profile,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: s.refresh_token,
        }),
        s,
      )
        .catch((e) => {
          if (e instanceof AppError && e.kind === "auth")
            this.vault.remove(`oauth-${provider}`);
          throw e;
        })
        .finally(() => this.refreshes.delete(provider));
      this.refreshes.set(provider, job);
    }
    return job;
  }
  saved(provider: Provider) {
    return !!this.vault.get<Session>(`oauth-${provider}`);
  }
  forget(provider: Provider) {
    this.vault.remove(`oauth-${provider}`);
  }
}
