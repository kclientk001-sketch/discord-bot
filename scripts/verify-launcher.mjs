import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// Explicit release verification. It installs into an isolated temporary copy,
// never into the caller's project, and never restores OS credential sessions.
if (process.platform === "win32") {
  console.error(
    "Kiểm tra bootstrap/SIGTERM này dành cho Linux/macOS. Trên Windows dùng start-windows.cmd và hướng dẫn LOCAL-VALIDATION.md.",
  );
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "lyrics-bootstrap-"));
const staging = join(temporary, "du an co khoang trang");
const checks = [];
let failed = false,
  error = null,
  child = null,
  exited = null;
const pass = (name) => {
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
};
try {
  await cp(root, staging, {
    recursive: true,
    filter: (path) => {
      const parts = relative(root, path).split(sep);
      return !parts.some((p) =>
        ["node_modules", "dist", "data", ".env", ".git"].includes(p),
      );
    },
  });
  assert(
    !existsSync(join(staging, "node_modules")) &&
      !existsSync(join(staging, "dist")),
  );
  pass("Bản sao mới không có dependency, dist hoặc phiên người dùng");
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(staging, "scripts/launch.mjs")], {
    cwd: temporary,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      DATA_DIR: join(temporary, "isolated-data"),
      DASHBOARD_PASSWORD: "",
      RESTORE_SAVED_SESSIONS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((r) => child.once("exit", r));
  let stdout = "";
  child.stderr.on("data", () => {});
  await new Promise((yes, no) => {
    const timer = setTimeout(
      () => no(new Error("Cài/build/khởi chạy vượt quá 120 giây.")),
      120000,
    );
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-131072);
      if (stdout.includes("Discord Lyrics Status:")) {
        clearTimeout(timer);
        yes();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      no(new Error("Không mở được process launcher."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      no(new Error(`Launcher dừng trước khi sẵn sàng (mã ${code}).`));
    });
  });
  assert(stdout.includes("Lần đầu chạy: cài dependency"));
  assert(existsSync(join(staging, "node_modules/express/package.json")));
  pass("Launcher tự chạy npm ci theo lockfile");
  assert(stdout.includes("Chưa có bản build"));
  assert(
    existsSync(join(staging, "dist/server/index.js")) &&
      existsSync(join(staging, "dist/web/index.html")),
  );
  pass("Launcher tự build khi thiếu dist");
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert((await response.text()).includes('lang="vi"'));
  pass(
    "HTTP thật hoạt động khi đường dẫn có khoảng trắng và cwd khác thư mục app",
  );
  const session = await fetch(origin + "/api/session");
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const state = await (
    await fetch(origin + "/api/state", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(state.config.dryRun, true);
  assert.equal(state.account.connection, "disconnected");
  assert.equal(state.sync.queue.lastSubmitted, null);
  pass("Khởi động dry run, không nạp credential hoặc gửi status");
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));
  pass("SIGTERM dừng launcher và server sạch");
} catch (e) {
  failed = true;
  error = e instanceof Error ? e.message : "Xác minh launcher thất bại.";
  console.error(error);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(temporary, { recursive: true, force: true });
}
const report = {
  executedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  productionEnvironmentVerified: !failed,
  checks,
  passed: checks.length,
  failed,
  error,
  liveServicesVerified: false,
  windowsWrapperVerified: false,
  browserVisualVerified: false,
};
if (process.argv[2]) {
  const path = resolve(process.argv[2]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}
console.log(`${checks.length}/6 kiểm tra bootstrap đạt.`);
if (failed) process.exitCode = 1;
