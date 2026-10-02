import test from "node:test";
import assert from "node:assert/strict";
import {
  Secrets,
  truncateStatus,
  AppError,
  equalSecret,
} from "../server/security.js";
import { retryDelay, requestJson } from "../server/http.js";
import {
  parseLyrics,
  makeLyrics,
  chooseLine,
  matchScore,
} from "../server/lyrics/service.js";
import {
  ManualAdapter,
  YouTubeAdapter,
  canonicalMusicUrl,
  position,
} from "../server/music/adapters.js";
import { LatestQueue } from "../server/sync/queue.js";
import { defaults } from "../shared.js";
import { Store } from "../server/store.js";
import { fake, json } from "./helpers.js";
test("Unicode NFC, tiếng Việt và emoji không bị cắt giữa grapheme", () => {
  assert.equal(truncateStatus("a\u0301"), "á");
  assert.equal(truncateStatus("x".repeat(127) + "👨‍👩‍👧‍👦"), "x".repeat(127));
  assert.equal(truncateStatus("🙂".repeat(65)).length, 128);
  assert.equal(truncateStatus("a\nb"), "a b");
});
test("Bí mật được ẩn trong log, object, escaped JSON; avatar công khai được giữ", () => {
  const s = new Secrets();
  s.add('FAKE"SECRET');
  const log = s.redact(
    'token=abc Bearer xyz https://example.test/a?token=bad FAKE"SECRET',
  );
  assert(!log.includes("xyz"));
  assert(!log.includes("token=abc"));
  assert(!log.includes("example.test"));
  const avatar = "https://cdn.discordapp.com/avatars/123456/abc.png";
  const c = s.clean({ avatar, value: 'FAKE"SECRET', token: "other" });
  assert.equal(c.avatar, avatar);
  assert.equal(c.value, "[ẨN]");
  assert.equal(c.token, "[ẨN]");
  assert(!s.redact(JSON.stringify({ v: 'FAKE"SECRET' })).includes("SECRET"));
});
test("So sánh bí mật không lộ độ dài", () => {
  assert(equalSecret("same", "same"));
  assert(!equalSecret("a", "longer"));
});
test("LRC nhiều tag, BOM, CRLF, offset và dòng trống", () => {
  const p = parseLyrics(
    "\uFEFF[offset:120]\r\n[00:03.5][00:01.50]Xin chào\r\n[00:04.00]",
  );
  assert.equal(p.kind, "lrc");
  assert.equal(p.offsetMs, 120);
  assert.deepEqual(p.lines, [
    { atMs: 1500, text: "Xin chào" },
    { atMs: 3500, text: "Xin chào" },
    { atMs: 4000, text: "" },
  ]);
});
test("LRC timestamp sai bị từ chối", () => {
  assert.throws(() => parseLyrics("[00:99.12]sai"), AppError);
  assert.throws(() => parseLyrics(""), AppError);
});
test("LRC trước dòng đầu, seek lùi và độ lệch dương/âm", () => {
  const l = makeLyrics("a", "b", "[00:01]Một\n[00:05]Hai");
  assert.equal(chooseLine(l, 0, 0, 6000), null);
  assert.equal(chooseLine(l, 5000, 0, 6000), 1);
  assert.equal(chooseLine(l, 2000, 0, 6000), 0);
  assert.equal(chooseLine(l, 0, 1000, 6000), 0);
  assert.equal(chooseLine(l, 5000, -1000, 6000), 0);
});
test("TXT luân phiên theo cursor, không giả timestamp", () => {
  const l = makeLyrics("a", "b", "Một\nHai");
  assert.equal(l.kind, "txt");
  assert.equal(chooseLine(l, 6000, 0, 6000), 1);
  assert.equal(chooseLine(l, 12000, 0, 6000), 0);
  assert(l.lines.every((x) => x.atMs === null));
});
test("Đối chiếu tên nghệ sĩ tiếng Việt và thời lượng", () => {
  const l = makeLyrics("Đêm dịu êm", "Nghệ sĩ", "Dòng", 120000);
  assert.equal(
    matchScore(l, {
      title: "Dem diu em",
      artist: "Nghe si",
      durationMs: 121000,
    }).score,
    100,
  );
  assert.equal(
    matchScore(l, { title: "Khác", artist: "Khác", durationMs: 140000 }).score,
    0,
  );
});
test("Timeline pause/resume/tua giữ đúng vị trí và chặn cuối bài", () => {
  const a = new ManualAdapter();
  a.set({ title: "a", artist: "b", durationMs: 10000 }, 0);
  a.transport(true, 0, 1000);
  assert.equal(position(a.read(4000), 4000), 3000);
  a.transport(false, undefined, 4000);
  assert.equal(position(a.read(9000), 9000), 3000);
  a.transport(true, 7000, 9000);
  assert.equal(position(a.read(11000), 11000), 9000);
  a.transport(false, 1000, 11000);
  assert.equal(position(a.read(), 11000), 1000);
});
test("Dữ liệu stale không tiếp tục extrapolate", () => {
  assert.equal(
    position(
      {
        source: "spotify",
        track: null,
        positionMs: 1000,
        playing: true,
        observedAt: 0,
        rate: 2,
        stale: true,
      },
      5000,
    ),
    1000,
  );
});
test("URL canonical loại tracking, từ chối thông tin xác thực và URL tùy ý", () => {
  assert.equal(
    canonicalMusicUrl("https://youtu.be/abcdefghijk?secret=bad"),
    "https://music.youtube.com/watch?v=abcdefghijk",
  );
  assert.equal(
    canonicalMusicUrl(
      "https://open.spotify.com/track/abcdefghijklmnopqrstuv?si=bad",
    ),
    "https://open.spotify.com/track/abcdefghijklmnopqrstuv",
  );
  assert.throws(() =>
    canonicalMusicUrl(
      "https://user:pass@music.youtube.com/watch?v=abcdefghijk",
    ),
  );
  assert.throws(() =>
    canonicalMusicUrl("https://example.test/watch?v=abcdefghijk"),
  );
});
test("YouTube bridge chọn phiên phát thật và đánh dấu stale sau 8 giây", () => {
  const y = new YouTubeAdapter();
  const p = {
    tabId: 1,
    title: "a",
    artist: "b",
    durationMs: 10000,
    positionMs: 2000,
    playing: true,
    rate: 1,
    url: "https://music.youtube.com/watch?v=abcdefghijk",
    observedAt: 10000,
  };
  y.receive(p, 10000);
  y.receive({ ...p, tabId: 2, title: "khác", playing: false }, 11000);
  assert.equal(y.read(11000).track?.title, "a");
  assert.equal(y.read(19000).stale, true);
  assert.throws(() => y.receive({ ...p, observedAt: 0 }, 20000));
});
test("Retry-After chọn thời gian dài nhất từ header/JSON/reset", () => {
  assert.equal(
    retryDelay(
      new Headers({ "retry-after": "2", "x-ratelimit-reset-after": "4" }),
      { retry_after: 3 },
    ),
    4000,
  );
  assert.equal(
    retryDelay(
      new Headers({ "retry-after": new Date(20000).toUTCString() }),
      null,
      10000,
    ),
    10000,
  );
});
test("429 không phản chiếu body và request network được phân loại", async () => {
  await assert.rejects(
    requestJson(
      "https://example.test",
      {},
      fake(() => json({ retry_after: 2, message: "SECRET" }, 429)),
    ),
    (e) =>
      e instanceof AppError &&
      e.kind === "rate-limit" &&
      e.retryMs === 2000 &&
      !e.message.includes("SECRET"),
  );
  await assert.rejects(
    requestJson(
      "https://example.test",
      {},
      fake(() => {
        throw new Error("SECRET");
      }),
    ),
    (e) => e instanceof AppError && e.kind === "network",
  );
});
function queue(sender?: (text: string) => Promise<any>) {
  let now = 0;
  const sent: string[] = [];
  const q = new LatestQueue(
    async (j) => {
      sent.push(j.text);
      return sender
        ? sender(j.text)
        : {
            submission: {
              text: j.text,
              at: now,
              result: "settings-confirmed",
              target: j.output,
            },
            rateWaitMs: 0,
          };
    },
    () => 15000,
    () => {},
    () => now,
  );
  return {
    q,
    sent,
    time: (n: number) => {
      now = n;
    },
  };
}
test("Hàng đợi gộp dòng mới nhất và tôn trọng khoảng gửi", async () => {
  const { q, sent, time } = queue();
  q.offer({ text: "A", output: "custom-status" });
  await q.flush();
  q.offer({ text: "B", output: "custom-status" });
  q.offer({ text: "C", output: "custom-status" });
  await q.flush();
  assert.deepEqual(sent, ["A"]);
  time(15000);
  await q.flush();
  assert.deepEqual(sent, ["A", "C"]);
  assert.equal(q.state.lastConfirmed?.text, "C");
});
test("Tua về dòng đã gửi bỏ dòng cũ đang chờ", async () => {
  const { q, sent, time } = queue();
  q.offer({ text: "A", output: "custom-status" });
  await q.flush();
  q.offer({ text: "B", output: "custom-status" });
  q.offer({ text: "A", output: "custom-status" });
  time(15000);
  await q.flush();
  assert.deepEqual(sent, ["A"]);
  assert.equal(q.state.pending, null);
});
test("429 giữ dòng mới nhất; không retry dòng cũ khi đã bị thay", async () => {
  let reject!: (e: unknown) => void;
  let first = true;
  const { q, sent, time } = queue(async (text) => {
    if (first) {
      first = false;
      await new Promise((_r, rej) => {
        reject = rej;
      });
    }
    return {
      submission: {
        text,
        at: 0,
        result: "settings-confirmed",
        target: "custom-status",
      },
      rateWaitMs: 0,
    };
  });
  q.offer({ text: "A", output: "custom-status" });
  const running = q.flush();
  q.offer({ text: "B", output: "custom-status" });
  reject(new AppError("rate-limit", "wait", 20000, 429));
  await running;
  time(15000);
  await q.flush();
  assert.deepEqual(sent, ["A"]);
  time(20000);
  await q.flush();
  assert.deepEqual(sent, ["A", "B"]);
});
test("Tắt khi request đang chạy không làm request lỗi sống lại", async () => {
  let reject!: (e: unknown) => void;
  const { q } = queue(async () => {
    await new Promise((_r, rej) => {
      reject = rej;
    });
  });
  q.offer({ text: "A", output: "custom-status" });
  const run = q.flush();
  q.clear();
  reject(new AppError("network", "offline", 5000));
  await run;
  assert.equal(q.state.pending, null);
});
test("Gateway submitted không bị báo service confirmed", async () => {
  const { q } = queue(async (text) => ({
    submission: {
      text,
      at: 0,
      result: "gateway-submitted",
      target: "bot-activity",
    },
    rateWaitMs: 0,
  }));
  q.offer({ text: "A", output: "bot-activity" });
  await q.flush();
  assert.equal(q.state.lastSubmitted?.text, "A");
  assert.equal(q.state.lastConfirmed, null);
});
test("SQLite chỉ lưu config/lyrics/cache, restart cưỡng chế chạy thử", () => {
  const s = new Store(":memory:");
  s.saveConfig({ ...defaults, dryRun: false });
  assert.equal(s.config().dryRun, true);
  assert.throws(() => s.saveConfig({ ...defaults, token: "BAD" } as any));
  const l = makeLyrics("a", "b", "lời");
  s.putLyrics(l);
  s.bind("track", l.id);
  assert.equal(s.forTrack("track")?.id, l.id);
  s.cache("test", { value: 1 });
  assert.deepEqual(s.cached("test"), { value: 1 });
  s.close();
});
