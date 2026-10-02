import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/launch.mjs", import.meta.url));
test("Launcher --check không khởi chạy server; từ chối credential qua CLI mà không in bí mật", () => {
  const check = spawnSync(process.execPath, [script, "--check"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(check.status, 0, check.stderr);
  const state = JSON.parse(check.stdout);
  assert.equal(state.nodeSupported, true);
  assert.equal(state.ready, true);
  const secret = "FAKE_CLI_SECRET_NOT_REAL";
  const bad = spawnSync(process.execPath, [script, "--token", secret], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(bad.status, 1);
  assert(![bad.stdout, bad.stderr].some((s) => s.includes(secret)));
});

test(
  "Launcher khởi chạy compiled server thật và chuyển SIGTERM để dừng sạch",
  { timeout: 15000, skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "lyrics-launcher "));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        DATA_DIR: dir,
        DASHBOARD_PASSWORD: "",
        RESTORE_SAVED_SESSIONS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exit = new Promise<number | null>((r) => child.once("exit", r));
    try {
      await new Promise<void>((yes, no) => {
        const timer = setTimeout(
          () => no(new Error("Launcher không mở server trong 10 giây.")),
          10000,
        );
        child.stdout!.on("data", (s) => {
          output += s;
          if (output.includes("Discord Lyrics Status:")) {
            clearTimeout(timer);
            yes();
          }
        });
        child.once("error", () => {
          clearTimeout(timer);
          no(new Error("Không khởi chạy được launcher."));
        });
        child.once("exit", () => {
          clearTimeout(timer);
          no(new Error("Launcher dừng trước khi server sẵn sàng."));
        });
      });
      const response = await fetch(origin);
      assert.equal(response.status, 200);
      assert((await response.text()).includes('lang="vi"'));
      const session = await fetch(origin + "/api/session");
      const cookie = session.headers.get("set-cookie")!.split(";")[0];
      const state = await (
        await fetch(origin + "/api/state", { headers: { Cookie: cookie } })
      ).json();
      assert.equal(state.config.dryRun, true);
      assert.equal(state.account.connection, "disconnected");
      child.kill("SIGTERM");
      assert.equal(await exit, 0);
      await assert.rejects(
        fetch(origin, { signal: AbortSignal.timeout(1000) }),
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exit, new Promise((r) => setTimeout(r, 2000))]);
      }
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  },
);
