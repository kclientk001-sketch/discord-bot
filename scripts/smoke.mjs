import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";
const tmp = await mkdtemp(join(tmpdir(), "lyrics-smoke-"));
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/server/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    DATA_DIR: tmp,
    DASHBOARD_PASSWORD: "",
    RESTORE_SAVED_SESSIONS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "",
  cookie = "",
  csrf = "";
const checks = [];
let failed = false;
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, passed: true });
      console.log(`PASS ${name}`);
    });
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "x-csrf-token": csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(r.ok, `HTTP ${r.status} ${path}`);
  return r;
}
try {
  await new Promise((yes, no) => {
    const timer = setTimeout(
      () => no(new Error("Server không khởi động trong 10 giây.")),
      10000,
    );
    child.stdout.on("data", (s) => {
      stdout += s;
      if (stdout.includes("Discord Lyrics Status:")) {
        clearTimeout(timer);
        yes();
      }
    });
    child.stderr.on("data", (s) => {
      stderr += s;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      no(new Error(`Server dừng: ${code}`));
    });
  });
  let html;
  await check("Trang HTML tiếng Việt và header bảo vệ", async () => {
    const r = await api("/");
    html = await r.text();
    assert(html.includes('lang="vi"'));
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert(
      r.headers.get("content-security-policy")?.includes("script-src 'self'"),
    );
  });
  await check("JavaScript bản build phục vụ được", async () => {
    const path = html.match(/src="([^"]+\.js)"/)[1];
    assert((await (await api(path)).text()).length > 1000);
  });
  await check("CSS bản build phục vụ được", async () => {
    const path = html.match(/href="([^"]+\.css)"/)[1];
    assert((await (await api(path)).text()).length > 1000);
  });
  await check("Phiên dashboard HttpOnly", async () => {
    const r = await api("/api/session");
    assert(r.headers.get("set-cookie")?.includes("HttpOnly"));
    cookie = r.headers.get("set-cookie").split(";")[0];
    csrf = (await r.json()).csrf;
  });
  await check("Khởi động an toàn ở chế độ chạy thử", async () => {
    const s = await (await api("/api/state")).json();
    assert.equal(s.config.dryRun, true);
    assert.equal(s.account.connection, "disconnected");
    assert.equal(s.sync.enabled, false);
  });
  await check("Nhập bài hát bằng API thật", async () => {
    const s = await (
      await api("/api/music/manual", {
        title: "Bài smoke",
        artist: "Nghệ sĩ smoke",
        durationMs: 120000,
      })
    ).json();
    assert.equal(s.playback.track.title, "Bài smoke");
  });
  await check("Nhập và gắn LRC", async () => {
    await api("/api/lyrics/import", {
      title: "Bài smoke",
      artist: "Nghệ sĩ smoke",
      durationMs: 120000,
      text: "[00:00]Dòng đầu\n[00:05]Dòng sau",
      bind: true,
    });
    const s = await (await api("/api/state")).json();
    assert.equal(s.preview, "Dòng đầu");
  });
  await check("Pause cố định timeline", async () => {
    await api("/api/music/transport", { playing: false, positionMs: 6000 });
    const s = await (await api("/api/state")).json();
    assert.equal(s.timelinePositionMs, 6000);
    assert.equal(s.preview, "Dòng sau");
  });
  await check("Tua lùi chọn lại dòng LRC", async () => {
    const s = await (
      await api("/api/music/transport", { playing: false, positionMs: 1000 })
    ).json();
    assert.equal(s.preview, "Dòng đầu");
    assert.equal(s.timelinePositionMs, 1000);
  });
  await check("Đổi bài thiếu lyrics dùng fallback", async () => {
    const s = await (
      await api("/api/music/manual", {
        title: "Bài mới",
        artist: "Nghệ sĩ mới",
        durationMs: 120000,
      })
    ).json();
    assert.equal(s.lyrics, null);
    assert.equal(s.preview, "Bài mới — Nghệ sĩ mới");
  });
  await check("SSE thật phân biệt preview và xác nhận", async () => {
    const r = await api("/api/events");
    const reader = r.body.getReader();
    const chunk = await reader.read();
    const s = JSON.parse(new TextDecoder().decode(chunk.value).slice(6).trim());
    assert.equal(s.sync.queue.lastConfirmed, null);
    assert.equal(s.config.dryRun, true);
    await reader.cancel();
  });
  await check("Bật / tắt chạy thử không tạo gửi dịch vụ", async () => {
    await api("/api/sync", { enabled: true });
    const s = await (await api("/api/sync", { enabled: false })).json();
    assert.equal(s.sync.enabled, false);
    assert.equal(s.sync.queue.lastSubmitted, null);
  });
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.message : "Smoke test lỗi.");
  if (stderr) console.error(stderr.slice(0, 1500));
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(tmp, { recursive: true, force: true });
}
const report = {
  executedAt: new Date().toISOString(),
  node: process.version,
  checks,
  passed: checks.filter((c) => c.passed).length,
  failed,
  liveServicesVerified: false,
  browserVisualVerified: false,
};
if (process.argv[2]) {
  const path = resolve(process.argv[2]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}
console.log(`${report.passed}/12 smoke checks đạt.`);
if (failed) process.exitCode = 1;
