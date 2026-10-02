import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const child = spawn(process.execPath, ["scripts/login-lab.mjs"], { env: { ...process.env, LOGIN_LAB_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let output = "", cookie = "", csrf = "";
const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, passed: true }); console.log("PASS", name); };
const wait = () => new Promise((r) => setTimeout(r, 3100));
const input = { login: "fixture@example.invalid", password: "FAKE_LAB_PASSWORD", acceptedRisk: true, persist: false };
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture server startup timeout")), 15000);
    child.on("error", reject); child.once("exit", (c) => { if (c !== null) reject(new Error("Fixture server exited")); });
    child.stdout.on("data", (b) => { output += b; const m = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
    child.stderr.on("data", (b) => { output += b; });
  });
  const send = (path, body) => fetch(origin + path, { method: body ? "POST" : "GET", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json", "x-csrf-token": csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const sessionResponse = await send("/api/session"); cookie = sessionResponse.headers.get("set-cookie").split(";")[0]; const session = await sessionResponse.json(); csrf = session.csrf;
  check("Compiled fixture server issues dashboard session with fixture label", () => assert.equal(session.fixture, true));
  const html = await (await fetch(origin)).text();
  check("Compiled React assets served by real Express", () => assert.match(html, /<script[^>]+src=/));
  let r = await send("/api/discord/login", { ...input, password: "FAKE_WRONG" });
  check("Wrong password rejected without account connection", () => assert.equal(r.status, 401));
  await wait(); r = await send("/api/discord/login", input); const begin = await r.json();
  check("Correct fixture password requests MFA without claiming identity", () => { assert.equal(r.status, 200); assert.equal(begin.login.stage, "mfa-required"); assert.equal(begin.dashboard.account.identity, null); });
  await wait(); r = await send("/api/discord/login/mfa", { challengeId: begin.login.challengeId, code: "000000" });
  check("Wrong MFA code rejected by compiled flow", () => assert.equal(r.status, 401));
  const waiting = await (await send("/api/discord/login")).json();
  check("Wrong MFA reduces remaining attempts and keeps opaque local challenge", () => { assert.equal(waiting.attemptsRemaining, 4); assert.equal(waiting.challengeId, begin.login.challengeId); assert(!JSON.stringify(waiting).includes("FAKE_LOCAL_LAB_TICKET")); });
  await wait(); r = await send("/api/discord/login/mfa", { challengeId: begin.login.challengeId, code: "012345" }); const finish = await r.json();
  check("Correct MFA confirms only the fixture identity", () => { assert.equal(r.status, 200); assert.equal(finish.login.stage, "connected"); assert.equal(finish.dashboard.account.identity.name, "Tài khoản mẫu cục bộ"); });
  check("No real Custom Status capability or fabricated service confirmation", () => { assert.equal(finish.dashboard.account.customStatusSupported, false); assert.equal(finish.dashboard.sync.queue.lastConfirmed, null); });
  check("No password/OTP/ticket/token in dashboard response or startup log", () => { const s = JSON.stringify([begin, waiting, finish]) + output; for (const v of [input.password, "012345", "FAKE_LOCAL_LAB_TICKET", "FAKE_LOCAL_LAB_TOKEN_NOT_REAL"]) assert(!s.includes(v)); });
  const report = { version: "1.1.0", executedAt: new Date().toISOString(), checks, passed: checks.length, liveDiscordVerified: false, scope: "Compiled local server + React assets; Discord stub; no browser render claim" };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  console.log(`${checks.length}/${checks.length} login smoke checks passed.`);
} finally {
  if (child.exitCode === null) { const done = new Promise((r) => child.once("exit", r)); child.kill("SIGTERM"); await done; }
}
