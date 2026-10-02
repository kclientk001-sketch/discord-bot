import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createApp } from "../server/app.js";
import { fixture, fake, json, user, userProfile } from "./helpers.js";
async function harness(
  password = "",
  localOnly = true,
  fetcher = fake(() => json(user)),
) {
  const f = fixture(fetcher);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;
  server.on("request", createApp(f.engine, { origin, password, localOnly }));
  let cookie = "",
    csrf = "";
  const send = async (
    path: string,
    body?: unknown,
    options: {
      method?: string;
      origin?: string;
      csrf?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(origin + path, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "x-csrf-token": options.csrf ?? csrf,
            }),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...options.headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const login = async () => {
    const r = await send("/api/session", password ? { password } : undefined);
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    const s = await r.json();
    csrf = s.csrf;
    return r;
  };
  return {
    ...f,
    send,
    login,
    origin,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await f.engine.close();
    },
  };
}
test("Phiên HttpOnly SameSite Lax, Host/Origin/CSRF chặn truy cập sai", async () => {
  const h = await harness();
  try {
    assert.equal((await h.send("/api/state")).status, 401);
    const r = await h.login();
    assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(r.headers.get("set-cookie") ?? "", /SameSite=Lax/);
    assert.equal((await h.send("/api/state")).status, 200);
    assert.equal(
      (await h.send("/api/sync", { enabled: true }, { csrf: "wrong" })).status,
      403,
    );
    assert.equal(
      (await h.send("/api/state", undefined, { origin: "https://evil.test" }))
        .status,
      403,
    );
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        h.origin + "/api/session",
        { headers: { Host: "evil.test" } },
        (r) => {
          r.resume();
          resolve(r.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await h.close();
  }
});
test("LAN có mật khẩu và không cho nhập token/ghép bridge", async () => {
  const h = await harness("FAKE_DASHBOARD_PASSWORD", false);
  try {
    assert.equal((await h.send("/api/session")).status, 401);
    await h.login();
    assert.equal((await h.send("/api/state")).status, 200);
    assert.equal(
      (await h.send("/api/discord/connect", userProfile)).status,
      422,
    );
    assert.equal(
      (await h.send("/api/bridge/pair", { extensionId: "a".repeat(32) }))
        .status,
      422,
    );
  } finally {
    await h.close();
  }
});
test("Đăng nhập sai quá 5 lần được giới hạn tốc độ", async () => {
  const h = await harness("FAKE_DASHBOARD_PASSWORD", false);
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await h.send("/api/session", { password: "FAKE_WRONG" })).status,
        401,
      );
    assert.equal(
      (await h.send("/api/session", { password: "FAKE_WRONG" })).status,
      429,
    );
  } finally {
    await h.close();
  }
});
test("Token sai không xuất hiện trong lỗi, SSE, snapshot, SQLite hoặc console", async () => {
  const lines: string[] = [];
  const old = { log: console.log, error: console.error, warn: console.warn };
  for (const key of ["log", "error", "warn"] as const)
    console[key] = (...args) => {
      lines.push(args.join(" "));
    };
  const h = await harness(
    "",
    true,
    fake(() => json({ message: userProfile.token }, 401)),
  );
  try {
    await h.login();
    const r = await h.send("/api/discord/connect", userProfile);
    const error = await r.text();
    assert.equal(r.status, 401);
    const state = await (await h.send("/api/state")).text();
    const db = JSON.stringify(
      Object.fromEntries(
        ["config", "lyrics", "bindings", "cache"].map((table) => [
          table,
          h.store.db.prepare(`SELECT * FROM ${table}`).all(),
        ]),
      ),
    );
    const stream = await h.send("/api/events");
    const reader = stream.body!.getReader();
    const part = await reader.read();
    const sse = new TextDecoder().decode(part.value);
    await reader.cancel();
    assert(
      ![error, state, sse, db, lines.join(" ")].some((s) =>
        s.includes(userProfile.token),
      ),
    );
  } finally {
    Object.assign(console, old);
    await h.close();
  }
});
test("Cookie không được nhận thay token; lưu phiên không có keyring bị từ chối", async () => {
  let calls = 0;
  const h = await harness(
    "",
    true,
    fake(() => {
      calls++;
      return json(user);
    }),
  );
  try {
    await h.login();
    assert.equal(
      (
        await h.send("/api/discord/connect", {
          mode: "user-token",
          cookie: "FAKE_COOKIE",
          persist: false,
          acceptedRisk: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (await h.send("/api/discord/connect", { ...userProfile, persist: true }))
        .status,
      400,
    );
    assert.equal(calls, 0);
  } finally {
    await h.close();
  }
});
test("API lyrics thủ công xử lý LRC, seek, pause, đổi bài và fallback", async () => {
  const h = await harness();
  try {
    await h.login();
    await h.send("/api/music/manual", {
      title: "Bài một",
      artist: "Nghệ sĩ",
      durationMs: 120000,
    });
    await h.send("/api/lyrics/import", {
      title: "Bài một",
      artist: "Nghệ sĩ",
      durationMs: 120000,
      text: "[00:00]Đầu\n[00:05]Sau",
      bind: true,
    });
    await h.send("/api/music/transport", { playing: false, positionMs: 6000 });
    let state = await (await h.send("/api/state")).json();
    assert.equal(state.preview, "Sau");
    await h.send("/api/music/transport", { playing: false, positionMs: 1000 });
    state = await (await h.send("/api/state")).json();
    assert.equal(state.preview, "Đầu");
    await h.send("/api/music/manual", {
      title: "Bài khác",
      artist: "Người khác",
      durationMs: 120000,
    });
    state = await (await h.send("/api/state")).json();
    assert.equal(state.lyrics, null);
    assert.equal(state.preview, "Bài khác — Người khác");
  } finally {
    await h.close();
  }
});
test("Config chứa secret và JSON lỗi không được phản chiếu hoặc lưu", async () => {
  const h = await harness();
  try {
    await h.login();
    let r = await h.send(
      "/api/config",
      { ...h.engine.config, token: "FAKE_SECRET_INPUT" },
      { method: "PUT" },
    );
    assert.equal(r.status, 400);
    assert(!(await r.text()).includes("FAKE_SECRET_INPUT"));
    r = await h.send("/api/sync", '{"token":"FAKE_SECRET_INPUT"');
    assert.equal(r.status, 400);
    assert(!(await r.text()).includes("FAKE_SECRET_INPUT"));
    assert(!JSON.stringify(h.engine.snapshot()).includes("FAKE_SECRET_INPUT"));
  } finally {
    await h.close();
  }
});
test("Bridge cần Origin và khóa đúng; URL metadata có cache không giả phiên phát", async () => {
  const h = await harness();
  try {
    await h.login();
    const id = "b".repeat(32);
    const pair = await (
      await h.send("/api/bridge/pair", { extensionId: id })
    ).json();
    const payload = {
      tabId: 1,
      title: "Bài YouTube",
      artist: "Nghệ sĩ",
      durationMs: 120000,
      positionMs: 5000,
      playing: true,
      rate: 1,
      url: "https://music.youtube.com/watch?v=abcdefghijk",
      observedAt: Date.now(),
    };
    const endpoint = h.origin + "/api/bridge/playback";
    let r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Origin: `chrome-extension://${id}`,
        Authorization: `Bearer ${pair.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 200);
    r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Origin: "https://evil.test",
        Authorization: `Bearer ${pair.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 403);
    const resolved = await (
      await h.send("/api/music/resolve", { url: payload.url })
    ).json();
    assert.equal(resolved.playbackClaimed, false);
    assert.equal(resolved.track.title, payload.title);
    const state = await (await h.send("/api/state")).text();
    assert(!state.includes(pair.key));
    assert.equal(JSON.parse(state).playback.source, "manual");
    assert.equal(
      (await h.send("/api/music/resolve", { url: "https://evil.test" })).status,
      400,
    );
  } finally {
    await h.close();
  }
});
test("SSE thật gửi snapshot đã làm sạch và không báo gửi khi chỉ xem trước", async () => {
  const h = await harness();
  try {
    await h.login();
    const r = await h.send("/api/events");
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = r.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert(text.startsWith("data: "));
    const state = JSON.parse(text.slice(6).trim());
    assert.equal(state.sync.queue.lastConfirmed, null);
    assert.equal(state.config.dryRun, true);
    assert(!text.includes("FAKE_"));
    await reader.cancel();
  } finally {
    await h.close();
  }
});
