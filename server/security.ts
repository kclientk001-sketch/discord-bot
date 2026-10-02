import { createHash, timingSafeEqual } from "node:crypto";
export type ErrorKind =
  | "network"
  | "auth"
  | "verification"
  | "rate-limit"
  | "quota"
  | "unsupported"
  | "validation"
  | "service";
export class AppError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public retryMs = 0,
    public status = 400,
  ) {
    super(message);
  }
}
export function safeError(e: unknown): AppError {
  return e instanceof AppError
    ? e
    : new AppError(
        "service",
        "Có lỗi nội bộ; không ghi chi tiết nhạy cảm.",
        0,
        500,
      );
}
export class Secrets {
  private values = new Set<string>();
  add(value: unknown) {
    if (typeof value === "string" && value.length) this.values.add(value);
  }
  register(value: unknown) {
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        if (/token|secret|password|cookie|authorization/i.test(k)) this.add(v);
        else this.register(v);
      }
  }
  private replace(s: string) {
    for (const v of this.values) {
      s = s.split(v).join("[ẨN]");
      const escaped = JSON.stringify(v).slice(1, -1);
      if (escaped !== v) s = s.split(escaped).join("[ẨN]");
    }
    return s;
  }
  redact(s: string) {
    return this.replace(s)
      .replace(/\b(?:Bearer|Bot)\s+\S+/gi, "[ẨN]")
      .replace(
        /\b(token|cookie|password|secret|code)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[ẨN]",
      )
      .replace(/https?:\/\/\S+/g, "[URL ẩn]");
  }
  clean<T>(v: T): T {
    const visit = (x: unknown): unknown => {
      if (typeof x === "string") return this.replace(x);
      if (Array.isArray(x)) return x.map(visit);
      if (x && typeof x === "object")
        return Object.fromEntries(
          Object.entries(x).map(([k, w]) => [
            k,
            /^(access_token|refresh_token|token|cookie|password|clientSecret|authorization)$/i.test(
              k,
            )
              ? "[ẨN]"
              : visit(w),
          ]),
        );
      return x;
    };
    return visit(v) as T;
  }
}
export function equalSecret(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function truncateStatus(text: string, max = 128) {
  let out = "";
  const s = text
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  for (const { segment } of new Intl.Segmenter("vi", {
    granularity: "grapheme",
  }).segment(s)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}
