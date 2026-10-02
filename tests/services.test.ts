import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../server/security.js";
import { SpotifyAdapter } from "../server/music/adapters.js";
import { LyricsService } from "../server/lyrics/service.js";
import { makeLyrics } from "../server/lyrics/service.js";
import { defaults } from "../shared.js";
import {
  fixture,
  fake,
  json,
  user,
  userProfile,
  seedSpotify,
  track,
} from "./helpers.js";
test("Spotify QUOTA_EXCEEDED dừng nguồn, không retry như rate limit ngắn", async () => {
  let calls = 0;
  const f = fixture();
  seedSpotify(f.vault);
  const s = new SpotifyAdapter(
    f.oauth,
    fake(() => {
      calls++;
      return json({ error: { status: 429, reason: "QUOTA_EXCEEDED" } }, 429);
    }),
  );
  s.activate();
  const now = Date.now();
  await s.poll(5000, now);
  await s.poll(5000, now + 100000);
  assert.equal(calls, 1);
  assert.equal(s.active, false);
  assert.equal(s.retryAt, null);
  assert.match(s.lastError ?? "", /Hạn ngạch/);
  await f.engine.close();
});
test("Refresh invalid_grant xóa phiên, dừng retry và yêu cầu OAuth lại", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json({ error: "invalid_grant" }, 400);
    }),
  );
  seedSpotify(f.vault);
  const s = f.vault.get<any>("oauth-spotify");
  s.expiresAt = 0;
  f.vault.put("oauth-spotify", s);
  await assert.rejects(f.oauth.session("spotify"), AppError);
  assert.equal(f.oauth.saved("spotify"), false);
  await assert.rejects(f.oauth.session("spotify"), AppError);
  assert.equal(calls, 1);
  await f.engine.close();
});
test("Discord tuân thủ Retry-After ngay cả khi bấm kết nối lại", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json({ retry_after: 30 }, 429);
    }),
  );
  await assert.rejects(f.engine.connect(userProfile));
  await assert.rejects(f.engine.reconnect());
  assert.equal(calls, 1);
  assert(f.engine.discord.state.retryAt! > Date.now());
  await f.engine.close();
});
test("Sai thông tin xác thực làm expired và dừng tự retry", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json({ message: "FAKE_USER_SECRET_NOT_REAL" }, 401);
    }),
  );
  await assert.rejects(f.engine.connect(userProfile));
  assert.equal(f.engine.discord.state.connection, "expired");
  await f.engine.discord.tick(Date.now() + 600000);
  assert.equal(calls, 1);
  assert(!JSON.stringify(f.engine.snapshot()).includes(userProfile.token));
  await f.engine.close();
});
test("Captcha / xác minh dừng tự reconnect", async () => {
  const f = fixture(fake(() => json({ captcha_key: ["required"] }, 400)));
  await assert.rejects(f.engine.connect(userProfile));
  assert.equal(f.engine.discord.state.connection, "verification-required");
  assert.equal(f.engine.discord.state.retryAt, null);
  await f.engine.close();
});
test("User token cần xác nhận sở hữu; lưu phiên không fallback plaintext", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json(user);
    }),
  );
  await assert.rejects(
    f.engine.connect({ ...userProfile, acceptedRisk: false }),
    AppError,
  );
  await assert.rejects(
    f.engine.connect({ ...userProfile, persist: true }),
    AppError,
  );
  assert.equal(calls, 0);
  await f.engine.close();
});
test("GET danh tính và PATCH chỉ custom_status; khôi phục emoji", async () => {
  const writes: any[] = [];
  const original = {
    text: "Trạng thái gốc",
    emoji_name: "🌱",
    expires_at: null,
  };
  const f = fixture(
    fake((url, init) => {
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        userProfile.token,
      );
      if (url.endsWith("/settings")) {
        if (init.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          return json(body);
        }
        return json({ custom_status: original });
      }
      return json(user);
    }),
  );
  await f.engine.connect(userProfile);
  assert.equal(f.engine.discord.state.identity?.name, user.global_name);
  await f.engine.discord.captureOriginal();
  const r = await f.engine.discord.send("Xin chào", "custom-status");
  assert.equal(r.submission.result, "settings-confirmed");
  await f.engine.discord.send("Trạng thái gốc", "custom-status", true);
  assert.deepEqual(writes, [
    { custom_status: { text: "Xin chào", expires_at: null } },
    { custom_status: original },
  ]);
  assert(!Object.hasOwn(writes[0], "status"));
  await f.engine.close();
});
test("Phản hồi không xác nhận dòng không báo thành công", async () => {
  const f = fixture(
    fake((u, i) =>
      u.endsWith("/settings")
        ? json({ custom_status: i.method === "PATCH" ? { text: "Sai" } : null })
        : json(user),
    ),
  );
  await f.engine.connect(userProfile);
  await assert.rejects(
    f.engine.discord.send("Đúng", "custom-status"),
    /không xác nhận/,
  );
  await f.engine.close();
});
test("Endpoint legacy không còn hỗ trợ vẫn giữ danh tính, vô hiệu hóa gửi", async () => {
  const f = fixture(
    fake((u) => (u.endsWith("/settings") ? json({}, 404) : json(user))),
  );
  await f.engine.connect(userProfile);
  assert.equal(f.engine.discord.state.connection, "connected");
  assert.equal(f.engine.discord.state.customStatusSupported, false);
  assert.equal(f.engine.discord.state.identity?.id, user.id);
  await assert.rejects(f.engine.discord.send("x", "custom-status"), AppError);
  await f.engine.close();
});
test("Mất mạng backoff, reconnect và dừng khi phiên không còn hợp lệ", async () => {
  let n = 0;
  const f = fixture(
    fake((u) => {
      if (n === 0) {
        n++;
        throw new Error("offline");
      }
      return json({}, 401);
    }),
  );
  await assert.rejects(f.engine.connect(userProfile));
  assert.equal(f.engine.discord.state.connection, "reconnecting");
  assert(f.engine.discord.state.retryAt! > Date.now());
  await f.engine.discord.tick(Date.now() + 70000);
  assert.equal(f.engine.discord.state.connection, "expired");
  await f.engine.close();
});
test("OAuth identify dùng Bearer và không được phép ghi Custom Status", async () => {
  const f = fixture(
    fake((_u, i) => {
      assert.equal(
        new Headers(i.headers).get("Authorization"),
        "Bearer FAKE_DISCORD_ACCESS",
      );
      return json(user);
    }),
  );
  f.vault.put("oauth-discord", {
    profile: {
      clientId: "fake",
      clientSecret: "FAKE_CLIENT_SECRET",
      persist: false,
    },
    access_token: "FAKE_DISCORD_ACCESS",
    scope: "identify",
    expiresAt: Date.now() + 3600000,
  });
  await f.engine.connect({ mode: "oauth2", persist: false });
  await assert.rejects(f.engine.discord.send("x", "custom-status"), AppError);
  await f.engine.close();
});
test("Bot token không bị coi là tài khoản cá nhân", async () => {
  const f = fixture(fake(() => json({ ...user, bot: true })));
  await assert.rejects(f.engine.connect(userProfile), /Loại token/);
  await f.engine.close();
});
test("Spotify PKCE scope tối thiểu, state ràng buộc phiên và dùng một lần", async () => {
  let bodies: string[] = [];
  const f = fixture(
    fake((_u, i) => {
      bodies.push(String(i.body));
      return json({
        access_token: "FAKE_OAUTH_ACCESS",
        refresh_token: "FAKE_REFRESH",
        expires_in: 3600,
        scope: "user-read-currently-playing",
      });
    }),
  );
  const url = new URL(
    f.oauth.start("spotify", { clientId: "fake", persist: false }, "owner"),
  );
  assert.equal(url.searchParams.get("scope"), "user-read-currently-playing");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert(!url.search.includes("SECRET"));
  const state = url.searchParams.get("state")!;
  await f.oauth.finish("spotify", state, "FAKE_CODE", "owner");
  assert(new URLSearchParams(bodies[0]).get("code_verifier")?.length);
  await assert.rejects(
    f.oauth.finish("spotify", state, "FAKE_CODE", "owner"),
    AppError,
  );
  const bad = new URL(
    f.oauth.start("spotify", { clientId: "fake", persist: false }, "owner"),
  );
  await assert.rejects(
    f.oauth.finish(
      "spotify",
      bad.searchParams.get("state")!,
      "FAKE_CODE",
      "other",
    ),
    AppError,
  );
  assert.equal(bodies.length, 1);
  await f.engine.close();
});
test("OAuth refresh gộp request, giữ refresh token nếu provider không trả mới", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json({
        access_token: "FAKE_NEW_ACCESS",
        expires_in: 3600,
        scope: "user-read-currently-playing",
      });
    }),
  );
  seedSpotify(f.vault);
  const s = f.vault.get<any>("oauth-spotify");
  s.expiresAt = 0;
  f.vault.put("oauth-spotify", s);
  const [a, b] = await Promise.all([
    f.oauth.session("spotify"),
    f.oauth.session("spotify"),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.access_token, b.access_token);
  assert.equal(a.refresh_token, "FAKE_SPOTIFY_REFRESH");
  await f.engine.close();
});
test("Spotify đọc pause/resume/seek/đổi bài/204 từ phiên thực tế", async () => {
  let sample: any = {
    item: track("A"),
    currently_playing_type: "track",
    progress_ms: 2000,
    is_playing: true,
  };
  const f = fixture(
    fake(() => (sample === null ? json(null, 204) : json(sample))),
  );
  seedSpotify(f.vault);
  const s = new SpotifyAdapter(
    f.oauth,
    fake(() => (sample === null ? json(null, 204) : json(sample))),
  );
  s.activate();
  let now = Date.now();
  await s.poll(0, now);
  assert.equal(s.read(now).track?.id, "spotify:A");
  sample = { ...sample, progress_ms: 4000, is_playing: false };
  await s.poll(0, now + 5000);
  assert.equal(s.read(now + 5000).playing, false);
  sample = { ...sample, progress_ms: 1000, is_playing: true };
  await s.poll(0, now + 10000);
  assert.equal(s.read(now + 10000).positionMs, 1000);
  sample = { ...sample, item: track("B", "Bài khác") };
  await s.poll(0, now + 15000);
  assert.equal(s.read(now + 15000).track?.id, "spotify:B");
  sample = null;
  await s.poll(0, now + 20000);
  assert.equal(s.read(now + 20000).track, null);
  await f.engine.close();
});
test("Spotify 429 đóng băng timeline và chờ cooldown", async () => {
  let calls = 0;
  const f = fixture();
  seedSpotify(f.vault);
  const s = new SpotifyAdapter(
    f.oauth,
    fake(() => {
      calls++;
      return calls === 1
        ? json({
            item: track(),
            currently_playing_type: "track",
            progress_ms: 2000,
            is_playing: true,
          })
        : json({ retry_after: 20 }, 429);
    }),
  );
  s.activate();
  const now = Date.now();
  await s.poll(0, now);
  await s.poll(0, now + 5000);
  assert.equal(s.read(now + 6000).stale, true);
  await s.poll(0, now + 10000);
  assert.equal(calls, 2);
  assert.equal(s.retryAt, now + 25000);
  await f.engine.close();
});
test("Đọc Spotify metadata không thay phiên phát", async () => {
  const f = fixture(fake(() => json(track("abcdefghijklmnopqrstuv"))));
  seedSpotify(f.vault);
  const t = await f.engine.spotify.metadata(
    "https://open.spotify.com/track/abcdefghijklmnopqrstuv",
  );
  assert.equal(t.title, "Bài thử");
  assert.equal(f.engine.spotify.read().track, null);
  await f.engine.close();
});
test("Lyrics provider cache và gắn kết quả do người dùng chọn", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json([
        {
          trackName: "Bài thử",
          artistName: "Nghệ sĩ thử",
          duration: 120,
          syncedLyrics: "[00:00]Một dòng",
        },
      ]);
    }),
  );
  const service = new LyricsService(
    f.store,
    fake(() => {
      calls++;
      return json([
        {
          trackName: "Bài thử",
          artistName: "Nghệ sĩ thử",
          duration: 120,
          plainLyrics: "Một dòng",
        },
      ]);
    }),
  );
  const r = await service.search("Bài thử", "Nghệ sĩ thử", 120000, true);
  await service.search("Bài thử", "Nghệ sĩ thử", 120000, true);
  assert.equal(calls, 1);
  assert.equal(f.store.forTrack("spotify:A"), null);
  f.store.bind("spotify:A", r[0].lyrics.id);
  assert.equal(f.store.forTrack("spotify:A")?.source, "lrclib");
  await f.engine.close();
});
test("Engine chạy thử, pause/tua/đổi bài và thiếu lyrics không gửi", async () => {
  let calls = 0;
  const f = fixture(
    fake(() => {
      calls++;
      return json({});
    }),
  );
  f.engine.manual.set({
    title: "Bài một",
    artist: "Nghệ sĩ",
    durationMs: 120000,
  });
  const l = makeLyrics(
    "Bài một",
    "Nghệ sĩ",
    "[00:00]Dòng một\n[00:05]Dòng hai",
  );
  f.store.putLyrics(l);
  f.store.bind(f.engine.manual.read().track!.id, l.id);
  await f.engine.setEnabled(true);
  f.engine.manual.transport(true, 6000);
  f.engine.tick();
  assert.equal(f.engine.snapshot().preview, "Dòng hai");
  f.engine.manual.transport(false, 1000);
  f.engine.tick();
  assert.equal(f.engine.snapshot().preview, "Dòng một");
  assert.equal(f.engine.snapshot().sync.state, "paused");
  f.engine.manual.set({
    title: "Bài khác",
    artist: "Người khác",
    durationMs: 120000,
  });
  f.engine.tick();
  assert.equal(f.engine.snapshot().preview, "Bài khác — Người khác");
  assert.equal(calls, 0);
  await f.engine.close();
});
test("Engine khôi phục qua hàng đợi, không xóa restore khi bấm ngắt", async () => {
  const writes: any[] = [];
  const f = fixture(
    fake((u, i) => {
      if (u.endsWith("/settings")) {
        if (i.method === "PATCH") {
          const b = JSON.parse(String(i.body));
          writes.push(b);
          return json(b);
        }
        return json({
          custom_status: { text: "Gốc", emoji_name: "🌱", expires_at: null },
        });
      }
      return json(user);
    }),
  );
  await f.engine.connect(userProfile);
  f.engine.updateConfig({
    ...defaults,
    output: "custom-status",
    dryRun: false,
  });
  f.engine.manual.set({ title: "Tên", artist: "Nghệ sĩ", durationMs: 120000 });
  f.engine.manual.transport(true, 0);
  await f.engine.setEnabled(true);
  f.engine.tick();
  await f.engine.queue.settle();
  assert.equal(writes.length, 1);
  await f.engine.setEnabled(false);
  assert.equal(f.engine.queue.state.pending, "Gốc");
  await assert.rejects(f.engine.disconnect(), /khôi phục/);
  assert.equal(f.engine.queue.state.pending, "Gốc");
  assert.equal(writes.length, 1);
  f.engine.updateConfig({ ...f.engine.config, restoreOnStop: false });
  await f.engine.disconnect();
  assert.equal(f.engine.discord.state.connection, "disconnected");
  await f.engine.close();
});
test("Hết hiệu lực trong heartbeat dừng đồng bộ", async () => {
  let fail = false;
  const f = fixture(
    fake((u) =>
      fail
        ? json({}, 401)
        : u.endsWith("/settings")
          ? json({ custom_status: null })
          : json(user),
    ),
  );
  await f.engine.connect(userProfile);
  f.engine.updateConfig({
    ...defaults,
    output: "custom-status",
    dryRun: false,
    restoreOnStop: false,
  });
  await f.engine.setEnabled(true);
  fail = true;
  await f.engine.discord.tick(Date.now() + 70000);
  f.engine.tick();
  assert.equal(f.engine.enabled, false);
  assert.equal(f.engine.discord.state.connection, "expired");
  await f.engine.close();
});
