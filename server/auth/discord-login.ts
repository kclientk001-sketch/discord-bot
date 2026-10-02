import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DiscordLoginState } from "../../shared.js";
import type { DiscordProfile } from "../discord/service.js";
import { retryDelay, type Fetcher } from "../http.js";
import { AppError, safeError } from "../security.js";
import { Vault } from "./vault.js";

// Observed in Discord's public web client on 2026-10-02, not an OAuth grant.
// No cookie, client fingerprint, CAPTCHA solver, or browser-token extraction.
const endpoint = "https://discord.com/api/v10";
export const passwordLoginSchema = z.object({
  login: z.string().trim().min(1).max(320).refine(
    (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v),
  ),
  password: z.string().min(1).max(1024),
  persist: z.boolean(),
  acceptedRisk: z.literal(true),
}).strict();
export const mfaLoginSchema = z.object({
  challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^\d{6}$/),
}).strict();
interface Pending {
  id: string;
  ticket: string;
  instance?: string;
  owner: string;
  expires: number;
  persist: boolean;
  attempts: number;
}
const idle = (): DiscordLoginState => ({
  stage: "idle", challengeId: null, expiresAt: null,
  attemptsRemaining: null, retryAt: null, lastError: null,
});

export class DiscordPasswordLogin {
  private pending: Pending | null = null;
  private view = idle();
  private owner: string | null = null;
  private generation = 0;
  private busy = false;
  private cooldownUntil = 0;
  private attempts = 0;
  private windowUntil = 0;
  private aborter: AbortController | null = null;
  private job: Promise<void> | null = null;
  constructor(
    private vault: Vault,
    private connect: (p: DiscordProfile, signal?: AbortSignal) => Promise<unknown>,
    private fetcher: Fetcher = fetch,
    private now: () => number = Date.now,
  ) {}
  sweep() {
    if (this.pending && this.pending.expires <= this.now()) {
      this.pending = null;
      this.view = { ...idle(), stage: "error", lastError: "Bước 2FA đã hết hạn; đăng nhập lại." };
    }
  }
  state(owner: string): DiscordLoginState {
    this.sweep();
    const view = this.owner === owner ? { ...this.view } : idle();
    view.retryAt = this.cooldownUntil > this.now() ? this.cooldownUntil : null;
    return view;
  }
  cancel(owner: string) {
    if (this.owner === owner) this.cancelAll();
  }
  cancelAll() {
    this.generation++;
    this.aborter?.abort();
    this.pending = null;
    this.owner = null;
    this.view = idle();
  }
  async settle() {
    await this.job?.catch(() => {});
  }
  private check(generation: number) {
    if (generation !== this.generation)
      throw new AppError("auth", "Bước đăng nhập đã được hủy.", 0, 409);
  }
  private guard(owner: string) {
    this.sweep();
    if (this.busy)
      throw new AppError("validation", "Đang xử lý đăng nhập; hãy chờ.", 0, 409);
    if (this.pending && this.pending.owner !== owner)
      throw new AppError("auth", "Có bước đăng nhập thuộc phiên dashboard khác.", 0, 409);
    if (this.cooldownUntil > this.now())
      throw new AppError("rate-limit", "Đang chờ trước lần đăng nhập tiếp theo.", this.cooldownUntil - this.now(), 429);
  }
  private async run(owner: string, fn: (generation: number, signal: AbortSignal) => Promise<void>) {
    this.busy = true;
    this.owner = owner;
    const generation = ++this.generation;
    const aborter = this.aborter = new AbortController();
    const work = (async () => {
      try {
        await fn(generation, AbortSignal.any([aborter.signal, AbortSignal.timeout(10000)]));
      } catch (error) {
        const e = safeError(error);
        if (generation === this.generation) {
          if (e.kind === "rate-limit")
            this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + e.retryMs);
          if (this.pending && this.pending.attempts >= 5 && e.kind === "auth")
            this.pending = null;
          if (e.status === 410) this.pending = null;
          if (!(this.pending && ["auth", "rate-limit"].includes(e.kind)))
            this.pending = null;
          this.view = {
            ...this.view,
            stage: this.pending ? "mfa-required" : e.kind === "verification" ? "verification-required" : "error",
            challengeId: this.pending?.id ?? null,
            expiresAt: this.pending?.expires ?? null,
            attemptsRemaining: this.pending ? Math.max(0, 5 - this.pending.attempts) : null,
            lastError: e.message,
          };
        }
        throw e;
      } finally {
        this.busy = false;
        if (this.aborter === aborter) this.aborter = null;
      }
    })();
    this.job = work;
    try { await work; } finally { if (this.job === work) this.job = null; }
  }
  private async post(path: "/auth/login" | "/auth/mfa/totp", body: unknown, signal: AbortSignal, mfa: boolean) {
    let response: Response;
    try {
      response = await this.fetcher(endpoint + path, {
        method: "POST", redirect: "error", credentials: "omit", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      throw new AppError("network", "Không nhận được phản hồi đăng nhập. Không tự gửi lại mật khẩu/mã 2FA; đăng nhập lại khi mạng ổn định.", 0, 503);
    }
    let data: any;
    try { data = await response.json(); } catch {
      if (response.status === 429)
        throw new AppError("rate-limit", "Discord giới hạn đăng nhập; hãy chờ Retry-After rồi gửi thủ công.", retryDelay(response.headers, null, this.now()), 429);
      throw new AppError("service", "Phản hồi đăng nhập không đúng định dạng; chưa kết nối tài khoản.", 0, 502);
    }
    this.vault.secrets.register(data);
    if (response.status === 429)
      throw new AppError("rate-limit", "Discord giới hạn đăng nhập; hãy chờ Retry-After rồi gửi thủ công.", retryDelay(response.headers, data, this.now()), 429);
    if (data?.captcha_key || data?.captcha_sitekey || data?.suspended_user_token ||
      [40002, 40003, 70007, 20011, 20013].includes(data?.code) || response.status === 403 ||
      (Array.isArray(data?.required_actions) && data.required_actions.length > 0))
      throw new AppError("verification", "Discord yêu cầu CAPTCHA, xác minh hoặc xử lý tài khoản. Hãy hoàn tất trong ứng dụng/trang Discord chính thức rồi thử lại; ứng dụng đã dừng đăng nhập.", 0, 403);
    if (mfa && [60006, 60009].includes(data?.code))
      throw new AppError("auth", "Discord báo bước 2FA đã hết hiệu lực; đăng nhập lại.", 0, 410);
    if (response.status === 400 || response.status === 401)
      throw new AppError("auth", mfa ? "Mã 2FA không hợp lệ hoặc bước xác minh đã hết hiệu lực." : "Email/số điện thoại hoặc mật khẩu không đúng, hoặc Discord từ chối đăng nhập.", 0, 401);
    if ([404, 405].includes(response.status))
      throw new AppError("unsupported", "Discord không hỗ trợ endpoint đăng nhập thử nghiệm này; chọn OAuth2 chính thức.", 0, 422);
    if (!response.ok)
      throw new AppError("service", `Discord trả HTTP ${response.status}; chi tiết nhạy cảm đã được ẩn.`, 0, 502);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new AppError("service", "Phản hồi đăng nhập không hợp lệ.", 0, 502);
    if (response.headers.get("x-ratelimit-remaining") === "0")
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + retryDelay(response.headers, data, this.now()));
    return data;
  }
  private async complete(data: any, persist: boolean, generation: number) {
    this.check(generation);
    if (typeof data.token !== "string" || !data.token.length || data.token.length > 8192)
      throw new AppError("service", "Discord chưa trả phiên hợp lệ; chưa kết nối tài khoản.", 0, 502);
    this.pending = null;
    await this.connect({ mode: "user-token", token: data.token, persist, acceptedRisk: true, loginMethod: "password" }, this.aborter?.signal);
    this.check(generation);
    this.view = { ...idle(), stage: "connected" };
  }
  async start(owner: string, raw: unknown) {
    const input = passwordLoginSchema.parse(raw);
    // Short passwords/codes can coincide with public IDs or lyrics. They never
    // enter the display model; redact them in logs without altering identity.
    this.vault.secrets.add(input.password, false);
    this.vault.secrets.add(input.login, false);
    this.vault.assertPersistence(input.persist);
    this.guard(owner);
    if (this.now() >= this.windowUntil) { this.attempts = 0; this.windowUntil = this.now() + 60000; }
    if (this.attempts >= 5)
      throw new AppError("rate-limit", "Tối đa 5 lần gửi mật khẩu trong 60 giây.", this.windowUntil - this.now(), 429);
    this.attempts++;
    this.cooldownUntil = this.now() + 3000;
    this.pending = null;
    this.view = { ...idle(), stage: "authenticating" };
    await this.run(owner, async (generation, signal) => {
      const data = await this.post("/auth/login", { login: input.login, password: input.password }, signal, false);
      this.check(generation);
      if (data.mfa === true) {
        if (data.totp !== true)
          throw new AppError("verification", "Discord yêu cầu phương thức MFA khác TOTP. Dùng Discord chính thức/OAuth2 để xác minh bằng SMS, passkey hoặc mã dự phòng.", 0, 403);
        if (typeof data.ticket !== "string" || !data.ticket.length || data.ticket.length > 8192 ||
          (data.login_instance_id !== undefined && (typeof data.login_instance_id !== "string" || data.login_instance_id.length > 256)))
          throw new AppError("service", "Thử thách 2FA không đúng định dạng; hãy đăng nhập lại.", 0, 502);
        const p = this.pending = {
          id: randomBytes(32).toString("base64url"), ticket: data.ticket,
          instance: data.login_instance_id, owner, expires: this.now() + 300000,
          persist: input.persist, attempts: 0,
        };
        this.view = { ...idle(), stage: "mfa-required", challengeId: p.id, expiresAt: p.expires, attemptsRemaining: 5 };
      } else await this.complete(data, input.persist, generation);
    });
    return this.state(owner);
  }
  async verify(owner: string, raw: unknown) {
    const input = mfaLoginSchema.parse(raw);
    this.vault.secrets.add(input.code, false);
    this.guard(owner);
    const p = this.pending;
    if (!p || p.owner !== owner || p.id !== input.challengeId)
      throw new AppError("auth", "Bước 2FA không hợp lệ, đã hủy hoặc hết hạn; đăng nhập lại.", 0, 401);
    if (p.attempts >= 5) {
      this.pending = null;
      throw new AppError("auth", "Đã hết lượt xác minh 2FA; đăng nhập lại.", 0, 401);
    }
    p.attempts++;
    this.cooldownUntil = this.now() + 3000;
    this.view = { ...this.view, stage: "verifying", lastError: null };
    await this.run(owner, async (generation, signal) => {
      const data = await this.post("/auth/mfa/totp", {
        ticket: p.ticket, code: input.code,
        ...(p.instance ? { login_instance_id: p.instance } : {}),
      }, signal, true);
      await this.complete(data, p.persist, generation);
    });
    return this.state(owner);
  }
}
