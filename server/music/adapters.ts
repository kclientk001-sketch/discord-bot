import { createHash } from "node:crypto";
import { z } from "zod";
import type { Playback, Track } from "../../shared.js";
import { AppError, safeError } from "../security.js";
import { requestJson, type Fetcher } from "../http.js";
import { OAuth } from "../auth/oauth.js";
export interface MusicAdapter {
  read(now?: number): Playback;
}
export function position(p: Playback, now = Date.now()) {
  return Math.min(
    p.track?.durationMs ?? Infinity,
    Math.max(
      0,
      p.positionMs +
        (p.playing && !p.stale ? Math.max(0, now - p.observedAt) * p.rate : 0),
    ),
  );
}
export function canonicalMusicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("validation", "URL nhạc không hợp lệ.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    throw new AppError(
      "validation",
      "Chỉ nhận URL HTTPS của Spotify hoặc YouTube, không có thông tin xác thực.",
    );
  if (u.hostname === "open.spotify.com") {
    const m = u.pathname.match(
      /^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})\/?$/,
    );
    if (m) return `https://open.spotify.com/track/${m[1]}`;
  }
  if (
    [
      "music.youtube.com",
      "www.youtube.com",
      "youtube.com",
      "youtu.be",
    ].includes(u.hostname)
  ) {
    const id =
      u.hostname === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v");
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id))
      return `https://music.youtube.com/watch?v=${id}`;
  }
  throw new AppError(
    "validation",
    "URL chưa được hỗ trợ; không tải URL tùy ý.",
  );
}
export const manualSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    artist: z.string().trim().min(1).max(256),
    durationMs: z.number().finite().min(1000).max(86400000),
    url: z.string().max(2048).optional(),
  })
  .strict();
export class ManualAdapter implements MusicAdapter {
  private p: Playback = {
    source: "manual",
    track: null,
    positionMs: 0,
    playing: false,
    observedAt: Date.now(),
    rate: 1,
    stale: false,
  };
  set(raw: z.infer<typeof manualSchema>, now = Date.now()) {
    const v = manualSchema.parse(raw);
    const url = v.url ? canonicalMusicUrl(v.url) : undefined;
    this.p = {
      ...this.p,
      track: {
        ...v,
        url,
        id:
          "manual:" +
          createHash("sha256")
            .update(`${v.title}|${v.artist}|${v.durationMs}|${url ?? ""}`)
            .digest("hex"),
      },
      positionMs: 0,
      playing: false,
      observedAt: now,
    };
  }
  transport(playing: boolean, seek?: number, now = Date.now()) {
    if (!this.p.track)
      throw new AppError("validation", "Chưa nhập bài hát thủ công.");
    this.p = {
      ...this.p,
      positionMs: Math.min(
        this.p.track.durationMs,
        Math.max(0, seek ?? position(this.p, now)),
      ),
      observedAt: now,
      playing,
    };
  }
  read(now = Date.now()) {
    return {
      ...this.p,
      playing:
        this.p.playing &&
        position(this.p, now) < (this.p.track?.durationMs ?? Infinity),
    };
  }
}
function spotifyTrack(t: any): Track {
  if (
    !t ||
    typeof t.id !== "string" ||
    typeof t.name !== "string" ||
    !Number.isFinite(t.duration_ms) ||
    !Array.isArray(t.artists)
  )
    throw new AppError("service", "Metadata Spotify không hợp lệ.");
  return {
    id: "spotify:" + t.id,
    title: t.name,
    artist: t.artists
      .map((a: any) => (typeof a.name === "string" ? a.name : ""))
      .filter(Boolean)
      .join(", "),
    durationMs: t.duration_ms,
    url: `https://open.spotify.com/track/${t.id}`,
  };
}
export class SpotifyAdapter implements MusicAdapter {
  active = false;
  lastError: string | null = null;
  retryAt: number | null = null;
  private generation = 0;
  private busy = false;
  private attempts = 0;
  private lastPoll = 0;
  private p: Playback = {
    source: "spotify",
    track: null,
    positionMs: 0,
    playing: false,
    observedAt: Date.now(),
    rate: 1,
    stale: true,
  };
  constructor(
    private oauth: OAuth,
    private fetcher: Fetcher = fetch,
  ) {}
  activate() {
    this.active = true;
    this.generation++;
    this.lastPoll = 0;
    this.retryAt = null;
    this.lastError = null;
  }
  disconnect() {
    this.active = false;
    this.generation++;
    this.oauth.forget("spotify");
    this.p = { ...this.p, track: null, playing: false, stale: true };
  }
  read(now = Date.now()) {
    return {
      ...this.p,
      stale: this.p.stale || now - this.p.observedAt > 15000,
    };
  }
  private async api(url: string) {
    let s = await this.oauth.session("spotify");
    try {
      return await requestJson<any>(
        url,
        { headers: { Authorization: `Bearer ${s.access_token}` } },
        this.fetcher,
      );
    } catch (e) {
      if (safeError(e).kind !== "auth") throw e;
      s = await this.oauth.session("spotify", true);
      return requestJson<any>(
        url,
        { headers: { Authorization: `Bearer ${s.access_token}` } },
        this.fetcher,
      );
    }
  }
  async poll(interval: number, now = Date.now()) {
    if (
      !this.active ||
      this.busy ||
      now - this.lastPoll < Math.max(5000, interval) ||
      (this.retryAt && now < this.retryAt)
    )
      return;
    const gen = this.generation;
    this.busy = true;
    this.lastPoll = now;
    try {
      const r = await this.api(
        "https://api.spotify.com/v1/me/player/currently-playing",
      );
      if (gen !== this.generation) return;
      const d = r.data;
      if (d === null) {
        this.p = {
          ...this.p,
          track: null,
          playing: false,
          stale: false,
          positionMs: 0,
          observedAt: now,
        };
      } else if (d.currently_playing_type !== "track" || !d.item) {
        this.p = {
          ...this.p,
          track: null,
          playing: false,
          stale: true,
          observedAt: now,
        };
        this.lastError = "Nguồn hiện tại không phải bài hát được hỗ trợ.";
      } else {
        this.p = {
          source: "spotify",
          track: spotifyTrack(d.item),
          positionMs: Math.max(0, Number(d.progress_ms) || 0),
          playing: !!d.is_playing,
          observedAt: now,
          rate: 1,
          stale: false,
        };
        this.lastError = null;
      }
      this.attempts = 0;
      this.retryAt = r.rateWaitMs ? now + r.rateWaitMs : null;
    } catch (raw) {
      if (gen !== this.generation) return;
      const e = safeError(raw);
      this.p = {
        ...this.p,
        positionMs: position(this.p, now),
        observedAt: now,
        stale: true,
      };
      this.lastError = e.message;
      if (["auth", "verification", "quota"].includes(e.kind)) {
        this.active = false;
        this.retryAt = null;
      } else
        this.retryAt =
          now + (e.retryMs || Math.min(60000, 5000 * 2 ** this.attempts++));
    } finally {
      this.busy = false;
    }
  }
  async metadata(url: string) {
    if (this.retryAt && this.retryAt > Date.now())
      throw new AppError(
        "rate-limit",
        "Spotify đang chờ giới hạn dịch vụ.",
        this.retryAt - Date.now(),
        429,
      );
    const u = canonicalMusicUrl(url);
    if (!u.includes("open.spotify.com"))
      throw new AppError("validation", "URL này không phải Spotify.");
    try {
      const r = await this.api(
        `https://api.spotify.com/v1/tracks/${u.split("/").pop()}`,
      );
      if (r.rateWaitMs) this.retryAt = Date.now() + r.rateWaitMs;
      return spotifyTrack(r.data);
    } catch (raw) {
      const e = safeError(raw);
      if (e.kind === "rate-limit") this.retryAt = Date.now() + e.retryMs;
      throw e;
    }
  }
}
export const youtubeSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(256),
    artist: z.string().trim().min(1).max(256),
    durationMs: z.number().finite().min(1000).max(86400000),
    positionMs: z.number().finite().nonnegative().max(86400000),
    playing: z.boolean(),
    rate: z.number().finite().min(0.1).max(8),
    url: z.string().max(2048),
    observedAt: z.number().finite(),
  })
  .strict();
export class YouTubeAdapter implements MusicAdapter {
  lastSeen: number | null = null;
  lastError: string | null = null;
  private tabId: number | null = null;
  private p: Playback = {
    source: "youtube-music",
    track: null,
    positionMs: 0,
    playing: false,
    observedAt: Date.now(),
    rate: 1,
    stale: true,
  };
  receive(raw: z.infer<typeof youtubeSchema>, now = Date.now()) {
    const v = youtubeSchema.parse(raw);
    if (Math.abs(now - v.observedAt) > 15000)
      throw new AppError(
        "validation",
        "Mẫu phát YouTube quá cũ hoặc đồng hồ lệch quá 15 giây.",
      );
    const url = canonicalMusicUrl(v.url);
    if (!url.includes("music.youtube.com"))
      throw new AppError("validation", "Bridge chỉ nhận YouTube Music.");
    if (
      this.tabId !== null &&
      v.tabId !== this.tabId &&
      this.p.playing &&
      !v.playing &&
      this.lastSeen &&
      now - this.lastSeen < 8000
    )
      return;
    this.tabId = v.tabId;
    this.lastSeen = now;
    this.lastError = null;
    this.p = {
      source: "youtube-music",
      track: {
        id: "youtube:" + new URL(url).searchParams.get("v"),
        title: v.title,
        artist: v.artist,
        durationMs: v.durationMs,
        url,
      },
      positionMs: Math.min(v.positionMs, v.durationMs),
      playing: v.playing,
      rate: v.rate,
      observedAt: now,
      stale: false,
    };
  }
  read(now = Date.now()) {
    const stale = this.lastSeen === null || now - this.lastSeen > 8000;
    return { ...this.p, stale };
  }
}
