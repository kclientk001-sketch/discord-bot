import { createHash } from "node:crypto";
import type { Lyrics, Track } from "../../shared.js";
import { AppError } from "../security.js";
import { Store } from "../store.js";
import { requestJson, type Fetcher } from "../http.js";
export function parseLyrics(
  input: string,
): Pick<Lyrics, "kind" | "lines" | "offsetMs"> {
  const text = input.replace(/^\uFEFF/, "").replace(/\r/g, "");
  let offsetMs = 0;
  let timed = false;
  const lines: Lyrics["lines"] = [];
  const plain: Lyrics["lines"] = [];
  for (const raw of text.split("\n")) {
    const off = raw.match(/^\[offset:\s*(-?\d+)\s*\]/i);
    if (off) {
      offsetMs = Math.max(-60000, Math.min(60000, Number(off[1])));
      continue;
    }
    const tags = [...raw.matchAll(/\[(\d+):([0-5]\d)(?:\.(\d{1,3}))?\]/g)];
    if (tags.length) {
      timed = true;
      const value = raw.replace(/\[\d+:[0-5]\d(?:\.\d{1,3})?\]/g, "").trim();
      for (const t of tags)
        lines.push({
          atMs:
            Number(t[1]) * 60000 +
            Number(t[2]) * 1000 +
            Number((t[3] ?? "0").padEnd(3, "0")),
          text: value,
        });
    } else if (/^\[\d+:/.test(raw))
      throw new AppError(
        "validation",
        "Timestamp LRC không hợp lệ; dùng [mm:ss.xx].",
      );
    else if (!/^\[[a-z]+:/i.test(raw) && raw.trim())
      plain.push({ atMs: null, text: raw.trim() });
  }
  if (!timed && !plain.length)
    throw new AppError("validation", "Tệp lyrics không có dòng hợp lệ.");
  return {
    kind: timed ? "lrc" : "txt",
    lines: timed ? lines.sort((a, b) => a.atMs! - b.atMs!) : plain,
    offsetMs,
  };
}
export function makeLyrics(
  title: string,
  artist: string,
  text: string,
  durationMs: number | null = null,
  source: Lyrics["source"] = "file",
): Lyrics {
  return {
    id: createHash("sha256")
      .update(`${source}|${title}|${artist}|${text}`)
      .digest("hex"),
    title,
    artist,
    durationMs,
    source,
    ...parseLyrics(text),
    importedAt: Date.now(),
  };
}
export function chooseLine(
  l: Lyrics,
  positionMs: number,
  offsetMs: number,
  intervalMs: number,
): number | null {
  const cursor = positionMs + offsetMs + l.offsetMs;
  if (cursor < 0) return null;
  if (l.kind === "txt") return Math.floor(cursor / intervalMs) % l.lines.length;
  let low = 0,
    high = l.lines.length - 1,
    found = -1;
  while (low <= high) {
    const m = (low + high) >> 1;
    if (l.lines[m].atMs! <= cursor) {
      found = m;
      low = m + 1;
    } else high = m - 1;
  }
  return found < 0 ? null : found;
}
const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function matchScore(
  l: Lyrics,
  t: Pick<Track, "title" | "artist" | "durationMs">,
) {
  let score = 0;
  if (normalize(l.title) === normalize(t.title)) score += 0.5;
  if (normalize(l.artist) === normalize(t.artist)) score += 0.3;
  const diff =
    l.durationMs === null ? null : Math.abs(l.durationMs - t.durationMs);
  if (diff !== null) score += diff <= 2000 ? 0.2 : diff <= 5000 ? 0.1 : 0;
  return {
    score: Math.round(score * 100),
    reason:
      diff === null
        ? "Chưa có thời lượng để đối chiếu."
        : `Chênh thời lượng ${(diff / 1000).toFixed(1)} giây.`,
  };
}
export class LyricsService {
  private waitUntil = 0;
  constructor(
    public store: Store,
    private fetcher: Fetcher = fetch,
  ) {}
  import(
    title: string,
    artist: string,
    text: string,
    durationMs: number | null,
  ) {
    const l = makeLyrics(title, artist, text, durationMs);
    this.store.putLyrics(l);
    return l;
  }
  async search(
    title: string,
    artist: string,
    durationMs: number,
    provider: boolean,
  ) {
    const target = { title, artist, durationMs };
    let rows = this.store
      .listLyrics()
      .filter(
        (l) =>
          normalize(l.title).includes(normalize(title)) ||
          normalize(l.artist) === normalize(artist),
      );
    if (provider) {
      const key = `lyrics:${normalize(title)}|${normalize(artist)}`;
      let cached = this.store.cached<Lyrics[]>(key);
      if (!cached) {
        if (this.waitUntil > Date.now())
          throw new AppError(
            "rate-limit",
            "Nhà cung cấp lyrics đang giới hạn tốc độ.",
            this.waitUntil - Date.now(),
            429,
          );
        const url = new URL("https://lrclib.net/api/search");
        url.search = new URLSearchParams({
          track_name: title,
          artist_name: artist,
        }).toString();
        try {
          const r = await requestJson<any>(
            url.toString(),
            {
              headers: {
                "User-Agent":
                  "DiscordLyricsStatus/1.0 (local personal lyrics manager)",
              },
            },
            this.fetcher,
          );
          if (!Array.isArray(r.data))
            throw new AppError("service", "Kết quả lyrics không hợp lệ.");
          cached = [];
          for (const row of r.data.slice(0, 30)) {
            const text = row.syncedLyrics || row.plainLyrics;
            if (
              typeof text !== "string" ||
              text.length > 200000 ||
              typeof row.trackName !== "string" ||
              typeof row.artistName !== "string"
            )
              continue;
            try {
              const l = makeLyrics(
                row.trackName,
                row.artistName,
                text,
                Number.isFinite(row.duration) ? row.duration * 1000 : null,
                "lrclib",
              );
              this.store.putLyrics(l);
              cached.push(l);
            } catch {}
          }
          this.store.cache(key, cached);
          if (r.rateWaitMs) this.waitUntil = Date.now() + r.rateWaitMs;
        } catch (e) {
          if (e instanceof AppError && e.kind === "rate-limit")
            this.waitUntil = Date.now() + e.retryMs;
          throw e;
        }
      }
      rows.push(...cached);
    }
    return [...new Map(rows.map((l) => [l.id, l])).values()]
      .map((lyrics) => ({ lyrics, ...matchScore(lyrics, target) }))
      .sort((a, b) => b.score - a.score);
  }
}
