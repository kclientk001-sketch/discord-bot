import { Client, GatewayIntentBits, ActivityType } from "discord.js";
import type {
  AccountState,
  Config,
  DiscordMode,
  Submission,
} from "../../shared.js";
import { AppError, safeError } from "../security.js";
import { requestJson, type Fetcher } from "../http.js";
import { Vault } from "../auth/vault.js";
import { OAuth } from "../auth/oauth.js";
export interface DiscordProfile {
  mode: DiscordMode;
  token?: string;
  persist: boolean;
  acceptedRisk?: boolean;
}
export interface SendResult {
  submission: Submission;
  rateWaitMs: number;
}
const empty = (): AccountState => ({
  mode: null,
  connection: "disconnected",
  identity: null,
  connectedAt: null,
  lastError: null,
  retryAt: null,
  customStatusSupported: false,
  savedSession: false,
  originalStatusKnown: false,
});
export class DiscordService {
  state: AccountState = empty();
  private profile: DiscordProfile | null = null;
  private bot: Client | null = null;
  private original: any = null;
  private attempts = 0;
  private lastCheck = 0;
  private checking = false;
  private generation = 0;
  private cooldownUntil = 0;
  constructor(
    private vault: Vault,
    private oauth: OAuth,
    private changed: () => void = () => {},
    private fetcher: Fetcher = fetch,
  ) {}
  private async headers() {
    if (this.cooldownUntil > Date.now())
      throw new AppError(
        "rate-limit",
        "Discord đang chờ giới hạn dịch vụ.",
        this.cooldownUntil - Date.now(),
        429,
      );
    if (!this.profile) throw new AppError("auth", "Chưa kết nối Discord.");
    let token = this.profile.token ?? "";
    if (this.profile.mode === "oauth2")
      token = (await this.oauth.session("discord")).access_token;
    return {
      Authorization:
        this.profile.mode === "bot"
          ? `Bot ${token}`
          : this.profile.mode === "oauth2"
            ? `Bearer ${token}`
            : token,
      "Content-Type": "application/json",
    };
  }
  private async api(url: string, init: RequestInit = {}) {
    try {
      const r = await requestJson<any>(
        url,
        { ...init, headers: await this.headers() },
        this.fetcher,
      );
      if (r.rateWaitMs) {
        this.cooldownUntil = Date.now() + r.rateWaitMs;
        this.state.retryAt = this.cooldownUntil;
      }
      return r;
    } catch (e) {
      if (e instanceof AppError && e.kind === "rate-limit")
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          Date.now() + e.retryMs,
        );
      throw e;
    }
  }
  private async verify() {
    const { data: u } = await this.api("https://discord.com/api/v10/users/@me");
    if (
      !u ||
      typeof u.id !== "string" ||
      !/^\d{5,25}$/.test(u.id) ||
      typeof u.username !== "string"
    )
      throw new AppError("service", "Không xác minh được danh tính Discord.");
    if (!!u.bot !== (this.profile!.mode === "bot"))
      throw new AppError(
        "validation",
        "Loại token không khớp loại tài khoản đã chọn.",
      );
    this.state.identity = {
      id: u.id,
      username: u.username,
      name: u.global_name || u.username,
      avatar:
        typeof u.avatar === "string" && /^[a-zA-Z0-9_]+$/.test(u.avatar)
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
          : null,
      kind: u.bot ? "bot" : "personal",
    };
    if (this.profile!.mode === "user-token") {
      try {
        const { data } = await this.api(
          "https://discord.com/api/v10/users/@me/settings",
        );
        this.state.customStatusSupported =
          !!data && Object.hasOwn(data, "custom_status");
        if (!this.state.customStatusSupported)
          this.state.lastError =
            "Legacy settings không trả custom_status; chức năng gửi bị vô hiệu hóa.";
      } catch (e) {
        if (safeError(e).kind !== "unsupported") throw e;
        this.state.customStatusSupported = false;
        this.state.lastError =
          "Endpoint legacy không còn hỗ trợ; vẫn đọc được danh tính, chưa thể đổi Custom Status.";
      }
    }
  }
  async connect(profile: DiscordProfile) {
    this.vault.assertPersistence(profile.persist);
    this.vault.secrets.register(profile);
    if (profile.mode === "user-token" && !profile.acceptedRisk)
      throw new AppError(
        "validation",
        "Cần xác nhận tài khoản của bạn và giới hạn self-bot.",
      );
    if (profile.mode !== "oauth2" && !profile.token)
      throw new AppError("validation", "Thiếu token.");
    await this.disconnect(false);
    const gen = ++this.generation;
    this.profile = profile;
    this.vault.put("discord-profile", profile, false);
    this.state = {
      ...empty(),
      mode: profile.mode,
      connection: "connecting",
      savedSession: profile.persist,
    };
    this.changed();
    try {
      await this.verify();
      if (gen !== this.generation) return;
      if (profile.mode === "bot") await this.connectBot(profile.token!);
      if (gen !== this.generation) return;
      this.vault.put("discord-profile", profile, profile.persist);
      this.state.connection = "connected";
      this.state.connectedAt = Date.now();
      this.attempts = 0;
      this.lastCheck = Date.now();
    } catch (e) {
      this.failure(e);
      throw safeError(e);
    } finally {
      this.changed();
    }
  }
  private async connectBot(token: string) {
    const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.bot = bot;
    bot.on("error", () => {
      this.state.lastError = "Gateway báo lỗi; chi tiết nhạy cảm đã ẩn.";
      this.changed();
    });
    bot.on("shardReconnecting", () => {
      this.state.connection = "reconnecting";
      this.changed();
    });
    bot.on("shardResume", () => {
      this.state.connection = "connected";
      this.state.lastError = null;
      this.changed();
    });
    bot.on("shardDisconnect", (event) => {
      if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) {
        this.failure(
          new AppError(
            "auth",
            "Gateway từ chối phiên hoặc cấu hình; hãy kết nối lại.",
          ),
        );
        bot.destroy();
      }
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bot.login(token),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new AppError(
                  "network",
                  "Kết nối Gateway hết thời gian chờ.",
                  10000,
                ),
              ),
            20000,
          );
        }),
      ]);
    } catch (e) {
      bot.destroy();
      throw e instanceof AppError
        ? e
        : new AppError("auth", "Gateway không chấp nhận bot token.");
    } finally {
      clearTimeout(timeout);
    }
  }
  failure(raw: unknown) {
    const e = safeError(raw);
    this.state.lastError = this.vault.secrets.redact(e.message);
    this.state.retryAt = null;
    if (e.kind === "auth") this.state.connection = "expired";
    else if (e.kind === "verification")
      this.state.connection = "verification-required";
    else if (e.kind === "network") {
      this.state.connection = "reconnecting";
      this.state.retryAt =
        Date.now() + Math.min(60000, 5000 * 2 ** this.attempts++);
    } else if (e.kind === "rate-limit")
      this.state.retryAt = Date.now() + e.retryMs;
    else if (e.kind === "unsupported") this.state.customStatusSupported = false;
    else if (["connecting", "reconnecting"].includes(this.state.connection))
      this.state.connection = "error";
    this.changed();
  }
  async reconnect() {
    const p = this.profile ?? this.vault.get<DiscordProfile>("discord-profile");
    if (!p) throw new AppError("auth", "Không có phiên để kết nối lại.");
    return this.connect(p);
  }
  async disconnect(forget = false) {
    this.generation++;
    this.bot?.destroy();
    this.bot = null;
    this.profile = null;
    this.original = null;
    this.state = empty();
    if (forget) {
      this.vault.remove("discord-profile");
      this.oauth.forget("discord");
    }
    this.changed();
  }
  async tick(now = Date.now()) {
    if (
      this.checking ||
      !this.profile ||
      ["expired", "verification-required", "disconnected", "error"].includes(
        this.state.connection,
      )
    )
      return;
    if (
      this.state.retryAt
        ? now < this.state.retryAt
        : now - this.lastCheck < 60000
    )
      return;
    this.checking = true;
    const gen = this.generation;
    try {
      await this.verify();
      if (gen === this.generation) {
        this.state.connection = "connected";
        this.state.retryAt = null;
        this.state.lastError =
          this.state.customStatusSupported || this.state.mode !== "user-token"
            ? null
            : this.state.lastError;
        this.lastCheck = now;
        this.attempts = 0;
      }
    } catch (e) {
      if (gen === this.generation) this.failure(e);
    } finally {
      this.checking = false;
    }
  }
  canSend(output: Config["output"]) {
    if (this.state.connection !== "connected")
      throw new AppError("auth", "Discord chưa kết nối hợp lệ.");
    if (
      output === "custom-status" &&
      (this.state.mode !== "user-token" || !this.state.customStatusSupported)
    )
      throw new AppError(
        "unsupported",
        "Custom Status cần user token và endpoint legacy còn hoạt động; OAuth identify / bot không có quyền này.",
      );
    if (output === "bot-activity" && this.state.mode !== "bot")
      throw new AppError("unsupported", "Activity này chỉ gửi cho bot riêng.");
    if (output === "preview")
      throw new AppError("validation", "Đích xem trước không gửi dịch vụ.");
  }
  async captureOriginal() {
    this.canSend("custom-status");
    const { data } = await this.api(
      "https://discord.com/api/v10/users/@me/settings",
    );
    if (!data || !Object.hasOwn(data, "custom_status"))
      throw new AppError(
        "unsupported",
        "Không đọc được trạng thái ban đầu để khôi phục.",
      );
    this.original = data.custom_status;
    this.state.originalStatusKnown = true;
  }
  originalText() {
    return this.original?.text ?? "";
  }
  async send(
    text: string,
    output: Config["output"],
    restore = false,
  ): Promise<SendResult> {
    this.canSend(output);
    if (this.state.retryAt && this.state.retryAt > Date.now())
      throw new AppError(
        "rate-limit",
        "Đang chờ giới hạn Discord.",
        this.state.retryAt - Date.now(),
        429,
      );
    try {
      if (output === "bot-activity") {
        if (!this.bot?.isReady())
          throw new AppError("network", "Gateway chưa sẵn sàng.", 5000);
        this.bot.user.setPresence({
          activities: [
            { name: text || "Âm nhạc", type: ActivityType.Listening },
          ],
          status: "online",
        });
        return {
          submission: {
            text,
            at: Date.now(),
            result: "gateway-submitted",
            target: output,
          },
          rateWaitMs: 0,
        };
      }
      let status: any = { text, expires_at: null };
      if (restore) {
        if (!this.state.originalStatusKnown)
          throw new AppError("validation", "Chưa lưu trạng thái ban đầu.");
        status =
          this.original?.expires_at &&
          Date.parse(this.original.expires_at) <= Date.now()
            ? null
            : this.original;
      }
      const r = await this.api(
        "https://discord.com/api/v10/users/@me/settings",
        { method: "PATCH", body: JSON.stringify({ custom_status: status }) },
      );
      const expected = status?.text ?? "";
      if (
        !r.data ||
        !Object.hasOwn(r.data, "custom_status") ||
        (r.data.custom_status?.text ?? "") !== expected
      )
        throw new AppError(
          "service",
          "Phản hồi không xác nhận Custom Status yêu cầu; chưa báo thành công.",
        );
      this.state.lastError = null;
      this.state.retryAt = r.rateWaitMs ? Date.now() + r.rateWaitMs : null;
      return {
        submission: {
          text: expected,
          at: Date.now(),
          result: "settings-confirmed",
          target: output,
        },
        rateWaitMs: r.rateWaitMs,
      };
    } catch (e) {
      this.failure(e);
      throw safeError(e);
    }
  }
}
