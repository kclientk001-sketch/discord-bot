import {
  configSchema,
  type Config,
  type Dashboard,
  type Playback,
} from "../shared.js";
import { Store } from "./store.js";
import { Vault } from "./auth/vault.js";
import { OAuth } from "./auth/oauth.js";
import { DiscordService, type DiscordProfile } from "./discord/service.js";
import {
  ManualAdapter,
  SpotifyAdapter,
  YouTubeAdapter,
  position,
} from "./music/adapters.js";
import { LyricsService, chooseLine } from "./lyrics/service.js";
import { LatestQueue } from "./sync/queue.js";
import { AppError, safeError, truncateStatus } from "./security.js";
import type { Fetcher } from "./http.js";
export class Engine {
  readonly startedAt = Date.now();
  config: Config;
  discord: DiscordService;
  manual = new ManualAdapter();
  spotify: SpotifyAdapter;
  youtube = new YouTubeAdapter();
  lyrics: LyricsService;
  queue: LatestQueue;
  enabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousTrack = "";
  private events: { at: number; message: string }[] = [];
  private lifecycleBusy = false;
  constructor(
    public store: Store,
    public vault: Vault,
    public oauth: OAuth,
    fetcher: Fetcher = fetch,
  ) {
    this.config = store.config();
    this.discord = new DiscordService(vault, oauth, () => {}, fetcher);
    this.spotify = new SpotifyAdapter(oauth, fetcher);
    this.lyrics = new LyricsService(store, fetcher);
    this.queue = new LatestQueue(
      (j) => this.discord.send(j.text, j.output, j.restore),
      () => this.config.minUpdateMs,
      (e) => {
        this.enabled = false;
        this.event(safeError(e).message);
      },
    );
  }
  event(message: string) {
    this.events.unshift({
      at: Date.now(),
      message: this.vault.secrets.redact(message),
    });
    this.events = this.events.slice(0, 30);
  }
  playback(now = Date.now()): Playback {
    return this.config.musicSource === "spotify"
      ? this.spotify.read(now)
      : this.config.musicSource === "youtube-music"
        ? this.youtube.read(now)
        : this.manual.read(now);
  }
  snapshot(now = Date.now()): Dashboard {
    const p = this.playback(now),
      l = p.track ? this.store.forTrack(p.track.id) : null,
      cursor = position(p, now);
    const selectedLine = l
      ? chooseLine(l, cursor, this.config.offsetMs, this.config.plainIntervalMs)
      : null;
    const fallback = this.config.fallback
      .replaceAll("{title}", p.track?.title ?? "Chưa có bài hát")
      .replaceAll("{artist}", p.track?.artist ?? "");
    const preview = truncateStatus(
      l && selectedLine !== null ? l.lines[selectedLine].text : fallback,
    );
    let state: Dashboard["sync"]["state"] = "stopped",
      reason = "Đồng bộ đang tắt.";
    const q = this.queue.state;
    if (this.enabled) {
      if (this.config.dryRun || this.config.output === "preview") {
        state = p.stale || !p.playing ? "paused" : "running";
        reason = "Chạy thử: chỉ cập nhật xem trước, không gửi Discord.";
      } else if (
        ["expired", "verification-required", "error"].includes(
          this.discord.state.connection,
        )
      ) {
        state = "error";
        reason = this.discord.state.lastError ?? "Phiên không hợp lệ.";
      } else if (this.discord.state.connection !== "connected") {
        state = "waiting";
        reason = "Đang chờ kết nối Discord.";
      } else if (p.stale || !p.playing || !p.track) {
        state = "paused";
        reason = p.stale
          ? "Nguồn phát không còn dữ liệu mới."
          : "Bài hát tạm dừng hoặc không có bài đang phát.";
      } else if (q.pending !== null || q.inFlight !== null) {
        state = "waiting";
        reason = "Đang chờ gửi hoặc chờ giới hạn dịch vụ.";
      } else {
        state = "running";
        reason = "Đang chọn dòng theo nguồn phát.";
      }
    } else if (q.pending !== null || q.inFlight !== null) {
      state = "waiting";
      reason = "Đang chờ khôi phục trạng thái ban đầu.";
    } else if (q.lastError) {
      state = "error";
      reason = q.lastError;
    }
    return this.vault.secrets.clean({
      now,
      startedAt: this.startedAt,
      config: { ...this.config },
      account: { ...this.discord.state },
      playback: p,
      lyrics: l,
      selectedLine,
      preview,
      timelinePositionMs: cursor,
      sync: { enabled: this.enabled, state, reason, queue: { ...q } },
      sources: {
        spotify: {
          active: this.spotify.active,
          lastError: this.spotify.lastError,
          retryAt: this.spotify.retryAt,
        },
        youtube: {
          lastSeen: this.youtube.lastSeen,
          lastError: this.youtube.lastError,
        },
      },
      events: [...this.events],
      vault: {
        available: this.vault.available,
        description: this.vault.description,
      },
    });
  }
  updateConfig(raw: unknown) {
    const c = configSchema.parse(raw);
    if (
      this.enabled &&
      (c.output !== this.config.output ||
        c.dryRun !== this.config.dryRun ||
        c.restoreOnStop !== this.config.restoreOnStop)
    )
      throw new AppError(
        "validation",
        "Tắt đồng bộ trước khi đổi chế độ gửi hoặc khôi phục.",
      );
    if (
      c.output !== this.config.output ||
      c.dryRun !== this.config.dryRun ||
      c.musicSource !== this.config.musicSource ||
      !c.restoreOnStop
    )
      this.queue.clear(true);
    this.config = c;
    this.store.saveConfig(c);
    this.event("Đã cập nhật cấu hình.");
  }
  async setEnabled(enable: boolean) {
    if (enable === this.enabled) return;
    if (enable) {
      if (this.queue.state.pending !== null && !this.enabled)
        throw new AppError(
          "validation",
          "Chờ khôi phục hoàn tất, hoặc tắt tùy chọn khôi phục để bỏ yêu cầu đang chờ.",
        );
      if (!this.config.dryRun && this.config.output !== "preview") {
        this.discord.canSend(this.config.output);
        if (this.config.restoreOnStop && this.config.output === "custom-status")
          await this.discord.captureOriginal();
      }
      this.enabled = true;
      this.queue.clear(true);
      this.event(
        this.config.dryRun || this.config.output === "preview"
          ? "Đã bật chạy thử."
          : "Đã bật đồng bộ tới dịch vụ.",
      );
    } else {
      const restore =
        this.enabled &&
        !this.config.dryRun &&
        this.config.output === "custom-status" &&
        this.config.restoreOnStop &&
        this.discord.state.originalStatusKnown;
      this.enabled = false;
      this.queue.clear();
      await this.queue.settle();
      if (restore && this.discord.state.connection === "connected") {
        this.queue.offer({
          text: this.discord.originalText(),
          output: "custom-status",
          restore: true,
        });
        await this.queue.flush();
      }
      this.event("Đã tắt đồng bộ; xem hàng đợi nếu đang chờ khôi phục.");
    }
  }
  private async lifecycle<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lifecycleBusy)
      throw new AppError(
        "validation",
        "Đang xử lý một thao tác tài khoản; hãy chờ.",
      );
    this.lifecycleBusy = true;
    try {
      return await fn();
    } finally {
      this.lifecycleBusy = false;
    }
  }
  private async beforeAccount() {
    await this.setEnabled(false);
    if (this.queue.state.pending !== null)
      throw new AppError(
        "validation",
        "Đang chờ khôi phục trạng thái; chờ hoàn tất hoặc tắt khôi phục trước khi đổi tài khoản.",
      );
    this.queue.resetTarget();
  }
  connect(p: DiscordProfile) {
    return this.lifecycle(async () => {
      await this.beforeAccount();
      await this.discord.connect(p);
      this.event("Đã xác minh danh tính Discord.");
    });
  }
  reconnect() {
    return this.lifecycle(async () => {
      await this.beforeAccount();
      await this.discord.reconnect();
    });
  }
  disconnect(forget = false) {
    return this.lifecycle(async () => {
      await this.beforeAccount();
      await this.discord.disconnect(forget);
    });
  }
  tick(now = Date.now()) {
    void this.discord.tick(now).catch(() => {});
    void this.spotify.poll(this.config.spotifyPollMs, now);
    const p = this.playback(now);
    const id = p.track?.id ?? "";
    if (id !== this.previousTrack) {
      if (this.enabled) this.queue.clear(true);
      this.previousTrack = id;
    }
    if (this.enabled) {
      if (
        !this.config.dryRun &&
        this.config.output !== "preview" &&
        ["expired", "verification-required", "error"].includes(
          this.discord.state.connection,
        )
      ) {
        this.enabled = false;
        this.queue.clear();
        this.event(
          this.discord.state.lastError ?? "Đã dừng vì phiên không hợp lệ.",
        );
      } else if (!p.track || !p.playing || p.stale) {
        this.queue.clear();
      } else if (
        !this.config.dryRun &&
        this.config.output !== "preview" &&
        this.discord.state.connection === "connected"
      ) {
        this.queue.offer({
          text: this.snapshot(now).preview,
          output: this.config.output,
        });
      }
    }
    if (this.discord.state.connection === "connected") void this.queue.flush();
  }
  async start(restoreSaved = true) {
    if (restoreSaved) {
      const p = this.vault.get<DiscordProfile>("discord-profile");
      if (p)
        try {
          await this.discord.connect(p);
        } catch (e) {
          this.event(safeError(e).message);
        }
      if (this.oauth.saved("spotify")) this.spotify.activate();
    }
    this.timer = setInterval(() => this.tick(), 250);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.enabled = false;
    this.queue.clear();
    await this.queue.settle();
    await this.discord.disconnect();
    this.store.close();
  }
}
