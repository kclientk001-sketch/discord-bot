import test from "node:test";
import assert from "node:assert/strict";
import { DiscordPasswordLogin } from "../server/auth/discord-login.js";
import { AppError, Secrets } from "../server/security.js";
import { Vault } from "../server/auth/vault.js";
import { DashboardAuth } from "../server/auth/dashboard.js";
import { fake, json, fixture, user } from "./helpers.js";
import type { DiscordProfile } from "../server/discord/service.js";

const credentials = {
  login: "fixture@example.invalid", password: "FAKE_LOGIN_PASSWORD_ĐỈNH",
  persist: false, acceptedRisk: true,
};
const mfa = { mfa: true, totp: true, ticket: "FAKE_MFA_TICKET_PRIVATE", login_instance_id: "FAKE_LOGIN_INSTANCE" };
const code = "012345";
function setup(responses: (Response | Error)[], connect?: (p: DiscordProfile) => Promise<unknown>) {
  let clock = 1700000000000;
  const calls: { url: string; init: RequestInit }[] = [];
  const profiles: DiscordProfile[] = [];
  const vault = new Vault(new Secrets());
  const login = new DiscordPasswordLogin(vault, connect ?? (async (p) => { profiles.push(p); }), fake((url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    assert(r, "unexpected request"); return r;
  }), () => clock);
  return { login, vault, calls, profiles, advance: (ms = 3001) => { clock += ms; } };
}
test("Password → TOTP → token: identity connection starts only after MFA, ticket remains on server", async () => {
  const f = setup([json(mfa), json({ token: "FAKE_ISSUED_TOKEN" })]);
  const state = await f.login.start("owner", credentials);
  assert.equal(state.stage, "mfa-required");
  assert.equal(f.profiles.length, 0);
  assert(!JSON.stringify(state).includes(mfa.ticket));
  assert(!JSON.stringify(state).includes(mfa.login_instance_id));
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { login: credentials.login, password: credentials.password });
  assert.equal(f.calls[0].url, "https://discord.com/api/v10/auth/login");
  f.advance();
  assert.equal((await f.login.verify("owner", { challengeId: state.challengeId, code })).stage, "connected");
  assert.equal(f.calls[1].url, "https://discord.com/api/v10/auth/mfa/totp");
  assert.deepEqual(JSON.parse(String(f.calls[1].init.body)), { ticket: mfa.ticket, code, login_instance_id: mfa.login_instance_id });
  assert.deepEqual(f.profiles, [{ mode: "user-token", token: "FAKE_ISSUED_TOKEN", persist: false, acceptedRisk: true, loginMethod: "password" }]);
  assert.equal(f.calls[1].init.credentials, "omit");
  assert.equal(f.calls[1].init.redirect, "error");
  assert.deepEqual(f.calls[1].init.headers, { "Content-Type": "application/json" });
  const view = JSON.stringify(f.login.state("owner"));
  for (const value of [credentials.password, code, mfa.ticket, "FAKE_ISSUED_TOKEN"]) assert(!view.includes(value));
});
test("Account without MFA connects after password; no fabricated MFA success", async () => {
  const f = setup([json({ token: "FAKE_NON_MFA_TOKEN" })]);
  assert.equal((await f.login.start("owner", { ...credentials, login: "+84900000000" })).stage, "connected");
  assert.equal(f.calls.length, 1); assert.equal(f.profiles.length, 1);
});
test("Invalid credentials preserve no password for automatic retry", async () => {
  const f = setup([json({ message: credentials.password }, 400)]);
  await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "auth" && !e.message.includes(credentials.password));
  f.advance(600000); f.login.sweep();
  assert.equal(f.calls.length, 1); assert.equal(f.profiles.length, 0);
  assert.equal(f.login.state("owner").stage, "error");
});
test("MFA owner binding, unknown challenge and replay are rejected before upstream request", async () => {
  const f = setup([json(mfa), json({ token: "FAKE_TOKEN" })]);
  const s = await f.login.start("owner", credentials); f.advance();
  assert.equal(f.login.state("other").challengeId, null);
  await assert.rejects(f.login.verify("other", { challengeId: s.challengeId, code }));
  await assert.rejects(f.login.verify("owner", { challengeId: "X".repeat(43), code }));
  assert.equal(f.calls.length, 1);
  await f.login.verify("owner", { challengeId: s.challengeId, code }); f.advance();
  await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }));
  assert.equal(f.calls.length, 2);
});
test("Expired/cancelled MFA tickets cannot be sent", async () => {
  for (const expire of [true, false]) {
    const f = setup([json(mfa)]);
    const s = await f.login.start("owner", credentials); f.advance(expire ? 300001 : 3001);
    if (!expire) f.login.cancel("owner");
    await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }));
    assert.equal(f.login.state("owner").challengeId, null); assert.equal(f.calls.length, 1);
  }
});
test("Wrong OTP remains retryable with a new code; fifth failure destroys the ticket", async () => {
  const f = setup([json(mfa), ...Array.from({ length: 5 }, () => json({ code: 60008, message: code }, 400))]);
  const s = await f.login.start("owner", credentials);
  for (let n = 1; n <= 5; n++) {
    f.advance();
    await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }), (e: AppError) => e.kind === "auth");
    assert.equal(f.login.state("owner").challengeId, n < 5 ? s.challengeId : null);
    if (n < 5) assert.equal(f.login.state("owner").attemptsRemaining, 5 - n);
  }
  f.advance(); await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }));
  assert.equal(f.calls.length, 6);
});
test("Discord invalid MFA ticket/session ends the challenge immediately", async () => {
  for (const invalid of [60006, 60009]) {
    const f = setup([json(mfa), json({ code: invalid }, 400)]);
    const s = await f.login.start("owner", credentials); f.advance();
    await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }), (e: AppError) => e.status === 410);
    assert.equal(f.login.state("owner").challengeId, null);
  }
});
test("CAPTCHA, verification, suspension, disabled/deleted account and required actions stop password auth", async () => {
  for (const [body, status] of [
    [{ captcha_key: ["captcha-required"], captcha_rqtoken: "FAKE_CAPTCHA_SECRET" }, 400],
    [{ code: 70007 }, 400], [{ code: 20013 }, 400], [{ code: 20011 }, 400],
    [{ suspended_user_token: "FAKE_SUSPENDED_TOKEN" }, 403],
    [{ token: "FAKE_RESTRICTED_TOKEN", required_actions: ["update_password"] }, 200],
    [{}, 403],
  ] as [unknown, number][]) {
    const f = setup([json(body, status)]);
    await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "verification");
    assert.equal(f.login.state("owner").stage, "verification-required");
    assert.equal(f.calls.length, 1); assert.equal(f.profiles.length, 0);
  }
});
test("Non-TOTP MFA (SMS/passkey/backup only) is reported, never interpreted as authenticated", async () => {
  const f = setup([json({ ...mfa, totp: false, sms: true, webauthn: "FAKE_CHALLENGE", token: "FAKE_TOKEN" })]);
  await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "verification");
  assert.equal(f.profiles.length, 0); assert.equal(f.login.state("owner").challengeId, null);
});
test("429 honors longest Retry-After; cancelling/another owner cannot reset the cooldown", async () => {
  const f = setup([json({ retry_after: 17 }, 429, { "Retry-After": "21" })]);
  await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "rate-limit" && e.retryMs === 21000);
  f.login.cancel("owner"); f.advance(20000);
  await assert.rejects(f.login.start("other", credentials), (e: AppError) => e.kind === "rate-limit");
  assert.equal(f.calls.length, 1);
});
test("MFA 429 preserves the challenge and requires a manual retry", async () => {
  const f = setup([json(mfa), json({ retry_after: 10 }, 429), json({ token: "FAKE_TOKEN" })]);
  const s = await f.login.start("owner", credentials); f.advance();
  await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }));
  assert.equal(f.login.state("owner").challengeId, s.challengeId);
  await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }));
  assert.equal(f.calls.length, 2); f.advance(10001);
  await f.login.verify("owner", { challengeId: s.challengeId, code });
  assert.equal(f.calls.length, 3);
});
test("A non-JSON 429 still honors Retry-After instead of retrying immediately", async () => {
  const f = setup([new Response("rate limited", { status: 429, headers: { "Retry-After": "18" } })]);
  await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "rate-limit" && e.retryMs === 18000);
  f.advance(17000); await assert.rejects(f.login.start("owner", credentials));
  assert.equal(f.calls.length, 1);
});
test("Network ambiguity at MFA discards challenge and never replays OTP automatically", async () => {
  const f = setup([json(mfa), new Error("FAKE_NETWORK_ERROR")]);
  const s = await f.login.start("owner", credentials); f.advance();
  await assert.rejects(f.login.verify("owner", { challengeId: s.challengeId, code }), (e: AppError) => e.kind === "network");
  f.advance(600000); f.login.sweep(); assert.equal(f.calls.length, 2);
  assert.equal(f.login.state("owner").challengeId, null);
});
test("Input validation: no cookie/token override, no TOTP seed, no secret persistence without keyring", async () => {
  const f = setup([]);
  for (const input of [
    { ...credentials, acceptedRisk: false }, { ...credentials, login: "username" },
    { ...credentials, persist: true }, { ...credentials, cookie: "FAKE_COOKIE" },
    { ...credentials, token: "FAKE_TOKEN" }, { ...credentials, totpSecret: "FAKE_SEED" },
  ]) await assert.rejects(f.login.start("owner", input));
  await assert.rejects(f.login.verify("owner", { challengeId: "A".repeat(43), code: "abcdef" }));
  assert.equal(f.calls.length, 0);
});
test("Concurrent login rejected; cancellation before response prevents connection", async () => {
  let resolve!: (r: Response) => void;
  const f = setup([]);
  const l = new DiscordPasswordLogin(f.vault, async (p) => { f.profiles.push(p); }, fake(() => new Promise<Response>((r) => { resolve = r; })));
  const attempt = l.start("owner", credentials);
  await assert.rejects(l.start("owner", credentials));
  l.cancel("owner"); resolve(json({ token: "FAKE_LATE_TOKEN" }));
  await assert.rejects(attempt); assert.equal(f.profiles.length, 0);
  assert.equal(l.state("owner").stage, "idle");
});
test("No success if identity confirmation fails; no raw upstream error leaks", async () => {
  const f = setup([json({ token: "FAKE_TOKEN" })], async () => { throw new Error(credentials.password); });
  await assert.rejects(f.login.start("owner", credentials), (e: AppError) => e.kind === "service" && !e.message.includes(credentials.password));
  assert.equal(f.login.state("owner").stage, "error");
});
test("Only issued profile token may persist; passwords, codes, ticket and identity are not corrupted", async () => {
  const f = fixture(fake((url) => url.endsWith("/auth/login") ? json({ token: "FAKE_ISSUED_TOKEN" }) : url.endsWith("/settings") ? json({ custom_status: null }) : json(user)));
  try {
    await f.engine.passwordLogin.start("owner", credentials);
    const profile = f.vault.get<DiscordProfile>("discord-profile")!;
    assert.equal(profile.token, "FAKE_ISSUED_TOKEN");
    for (const key of ["password", "login", "code", "ticket"]) assert(!Object.hasOwn(profile, key));
    f.vault.secrets.add("123456", false); // OTP happens to be a prefix of fixture user ID.
    assert.equal(f.engine.snapshot().account.identity?.id, user.id);
    assert.equal(f.engine.snapshot().account.authenticationMethod, "password");
    assert(!JSON.stringify(f.engine.snapshot()).includes("FAKE_ISSUED_TOKEN"));
    assert(!f.vault.secrets.redact(`${credentials.password} ${mfa.ticket} 123456`).includes(credentials.password));
  } finally { await f.engine.close(); }
});
test("Password attempts are bounded across dashboard owners and cancellation", async () => {
  const f = setup(Array.from({ length: 5 }, () => json({}, 400)));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(f.login.start(`owner-${i}`, credentials));
    f.login.cancel(`owner-${i}`); f.advance();
  }
  await assert.rejects(f.login.start("new-owner", credentials), (e: AppError) => e.kind === "rate-limit");
  assert.equal(f.calls.length, 5);
});
test("A loopback server configured with a non-loopback public origin rejects credential input", () => {
  const auth = new DashboardAuth("https://public.example.invalid", "", true, new Secrets());
  assert.throws(() => auth.localInput(), (e: AppError) => e.kind === "unsupported");
});
test("Cancellation during identity verification cannot establish or retry the new account", async () => {
  let entered!: () => void, resolve!: (r: Response) => void;
  const reached = new Promise<void>((r) => { entered = r; });
  let calls = 0;
  const f = fixture(fake((url) => {
    calls++;
    if (url.endsWith("/auth/login")) return json({ token: "FAKE_LATE_IDENTITY_TOKEN" });
    if (url.endsWith("/users/@me")) { entered(); return new Promise<Response>((r) => { resolve = r; }); }
    return json({ custom_status: null });
  }));
  try {
    const attempt = f.engine.passwordLogin.start("owner", credentials);
    await reached; f.engine.passwordLogin.cancel("owner"); resolve(json(user));
    await assert.rejects(attempt);
    assert.equal(f.engine.discord.state.connection, "disconnected");
    assert.equal(f.engine.discord.state.identity, null);
    assert.equal(f.vault.get("discord-profile"), null);
    await f.engine.discord.tick(Date.now() + 600000);
    assert.equal(calls, 2);
  } finally { await f.engine.close(); }
});
