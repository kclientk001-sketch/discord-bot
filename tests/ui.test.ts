import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { fixture, fake, json, user } from "./helpers.js";
import { DiscordPasswordLogin } from "../server/auth/discord-login.js";
import { safeError } from "../server/security.js";
test("React: timeline, token, password/TOTP, sai OTP, đổi phương thức và xóa bí mật sau gửi", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1:3210",
  });
  const props = [
    "window",
    "document",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "location",
    "navigator",
  ];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of props) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (dom.window as any)[name],
    });
  }
  const originalFetch = globalThis.fetch;
  const oldEvent = globalThis.EventSource;
  const discordFetcher = fake((u, i) => {
    if (u.endsWith("/auth/login")) return json({ mfa: true, totp: true, ticket: "FAKE_UI_MFA_TICKET" });
    if (u.endsWith("/auth/mfa/totp")) return JSON.parse(String(i.body)).code === "012345" ? json({ token: "FAKE_UI_ISSUED_TOKEN" }) : json({ code: 60008 }, 400);
    return u.endsWith("/settings") ? json({ custom_status: null }) : json(user);
  });
  const f = fixture(discordFetcher);
  let authClock = Date.now() - 10000;
  f.engine.passwordLogin = new DiscordPasswordLogin(f.vault, (p) => f.engine.connect(p), discordFetcher, () => authClock);
  class FakeEventSource {
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }
    close() {}
  }
  (globalThis as any).EventSource = FakeEventSource;
  globalThis.fetch = fake(async (url, init) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (url === "/api/session")
      return json({ csrf: "FAKE_CSRF", localOnly: true });
    if (url === "/api/discord/login" || url === "/api/discord/login/mfa") {
      try {
        if (init.method === "DELETE") f.engine.passwordLogin.cancel("FAKE_OWNER");
        if (init.method === "POST") {
          if (url.endsWith("/mfa")) await f.engine.passwordLogin.verify("FAKE_OWNER", body);
          else await f.engine.passwordLogin.start("FAKE_OWNER", body);
          return json({ login: f.engine.passwordLogin.state("FAKE_OWNER"), dashboard: f.engine.snapshot() });
        }
        return json(f.engine.passwordLogin.state("FAKE_OWNER"));
      } catch (error) { const e = safeError(error); return json({ error: e.message, kind: e.kind }, e.status); }
    }
    if (url === "/api/config") f.engine.updateConfig(body);
    if (url === "/api/music/manual") f.engine.manual.set(body);
    if (url === "/api/lyrics/import") {
      const l = f.engine.lyrics.import(
        body.title,
        body.artist,
        body.text,
        body.durationMs,
      );
      if (body.bind) f.store.bind(f.engine.playback().track!.id, l.id);
      return json({ lyrics: l });
    }
    if (url === "/api/music/transport")
      f.engine.manual.transport(body.playing, body.positionMs);
    if (url === "/api/sync") await f.engine.setEnabled(body.enabled);
    if (url === "/api/discord/connect") await f.engine.connect(body);
    return json(f.engine.snapshot());
  });
  const { render, screen, fireEvent, waitFor, cleanup } =
    await import("@testing-library/react");
  const { default: App } = await import("../web/app.js");
  try {
    render(createElement(App));
    await screen.findByRole("button", { name: "Chạy thử" });
    fireEvent.click(screen.getByRole("button", { name: "Chạy thử" }));
    await waitFor(() => assert.equal(f.engine.enabled, true));
    await screen.findAllByText("Đêm dịu êm");
    assert.equal(f.engine.snapshot().sync.queue.lastConfirmed, null);
    fireEvent.click(
      screen.getByRole("button", { name: "Nguồn nhạc", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Tạm dừng timeline" }),
    );
    await waitFor(() => assert.equal(f.engine.playback().playing, false));
    fireEvent.change(screen.getByLabelText("Tua timeline thủ công (giây)"), {
      target: { value: "17" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tua", exact: true }));
    await waitFor(() =>
      assert.equal(f.engine.snapshot().timelinePositionMs, 17000),
    );
    assert.equal(f.engine.snapshot().preview, "Một giai điệu đi rất khẽ");
    fireEvent.click(
      screen.getByRole("button", { name: "Lời bài hát", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Nội dung lời bài hát"), {
      target: { value: "Lời TXT một\nLời TXT hai" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Nhập và gắn với bài hiện tại" }),
    );
    await waitFor(() => assert.equal(f.engine.snapshot().lyrics?.kind, "txt"));
    fireEvent.click(
      screen.getByRole("button", { name: "Thiết lập", exact: true }),
    );
    fireEvent.change(
      screen.getByLabelText("Độ lệch lyrics (giây; dương = hiện sớm)"),
      { target: { value: "2" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await waitFor(() => assert.equal(f.engine.config.offsetMs, 2000));
    fireEvent.click(
      screen.getByRole("button", { name: "Tài khoản", exact: true }),
    );
    assert(screen.getByText(/Cookie Discord không được chấp nhận/));
    fireEvent.change(screen.getByLabelText("Phương thức xác thực"), {
      target: { value: "user-token" },
    });
    const credential = "FAKE_UI_USER_SECRET";
    fireEvent.change(
      screen.getByLabelText("User token của tài khoản của bạn"),
      { target: { value: credential } },
    );
    fireEvent.click(screen.getByLabelText(/Đây là tài khoản của tôi/));
    fireEvent.click(
      screen.getByRole("button", { name: "Kết nối", exact: true }),
    );
    await waitFor(() =>
      assert.equal(f.engine.discord.state.connection, "connected"),
    );
    assert.equal(
      (
        screen.getByLabelText(
          "User token của tài khoản của bạn",
        ) as HTMLInputElement
      ).value,
      "",
    );
    assert(!JSON.stringify(f.engine.snapshot()).includes(credential));
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(f.engine.snapshot().sync.queue.lastConfirmed, null);
    fireEvent.change(screen.getByLabelText("Phương thức xác thực"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("Email hoặc số điện thoại Discord (+84…)"), { target: { value: "fixture@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Mật khẩu tài khoản Discord"), { target: { value: "FAKE_UI_DISCORD_PASSWORD" } });
    fireEvent.click(screen.getByRole("button", { name: "Kết nối", exact: true }));
    await screen.findByRole("group", { name: "Xác minh 2FA Discord" });
    assert.equal((screen.getByLabelText("Mật khẩu tài khoản Discord") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Email hoặc số điện thoại Discord (+84…)") as HTMLInputElement).value, "");
    fireEvent.change(screen.getByLabelText("Mã 2FA Discord (6 chữ số)"), { target: { value: "123456" } });
    authClock += 3001;
    fireEvent.click(screen.getByRole("button", { name: "Xác minh 2FA", exact: true }));
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /Mã 2FA/));
    assert.equal((screen.getByLabelText("Mã 2FA Discord (6 chữ số)") as HTMLInputElement).value, "");
    assert.equal(f.engine.passwordLogin.state("FAKE_OWNER").attemptsRemaining, 4);
    authClock += 3001;
    fireEvent.change(screen.getByLabelText("Mã 2FA Discord (6 chữ số)"), { target: { value: "012345" } });
    fireEvent.click(screen.getByRole("button", { name: "Xác minh 2FA", exact: true }));
    await screen.findByText("Mật khẩu / 2FA (thử nghiệm)");
    await waitFor(() => assert.equal(screen.queryByLabelText("Mã 2FA Discord (6 chữ số)"), null));
    assert.equal(f.engine.snapshot().account.identity?.id, user.id);
    assert.equal(dom.window.localStorage.length, 0);
    for (const v of ["FAKE_UI_DISCORD_PASSWORD", "FAKE_UI_MFA_TICKET", "FAKE_UI_ISSUED_TOKEN"]) assert(!dom.window.document.body.textContent?.includes(v));
    fireEvent.change(screen.getByLabelText("Phương thức xác thực"), { target: { value: "user-token" } });
    await screen.findByLabelText("User token của tài khoản của bạn");
    assert.equal(f.engine.passwordLogin.state("FAKE_OWNER").stage, "idle");
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    (globalThis as any).EventSource = oldEvent;
    await f.engine.close();
    dom.window.close();
    for (const name of props) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
