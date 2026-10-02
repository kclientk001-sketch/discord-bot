import express from "express";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import type { Engine } from "./engine.js";
import { DashboardAuth } from "./auth/dashboard.js";
import { AppError, safeError, equalSecret } from "./security.js";
import {
  manualSchema,
  youtubeSchema,
  canonicalMusicUrl,
} from "./music/adapters.js";
import type { Provider } from "./auth/oauth.js";
const profileSchema = z
  .object({
    mode: z.enum(["user-token", "oauth2", "bot"]),
    token: z.string().min(1).max(8192).optional(),
    persist: z.boolean(),
    acceptedRisk: z.boolean().optional(),
  })
  .strict();
export function createApp(
  engine: Engine,
  options: {
    origin: string;
    password?: string;
    localOnly: boolean;
    webDir?: string;
    fixture?: boolean;
  },
) {
  const app = express(),
    auth = new DashboardAuth(
      options.origin,
      options.password ?? "",
      options.localOnly,
      engine.vault.secrets,
    );
  let bridge: {
    key: string;
    origin: string;
    expires: number;
    lastAt: number;
  } | null = null;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    try {
      auth.host(req);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/bridge/playback", (req, res, next) => {
    const origin = req.headers.origin;
    if (
      !options.localOnly ||
      !bridge ||
      bridge.expires < Date.now() ||
      origin !== bridge.origin
    )
      return next(
        new AppError(
          "auth",
          "Bridge chưa ghép hoặc Origin không hợp lệ.",
          0,
          403,
        ),
      );
    res.set({
      "Access-Control-Allow-Origin": bridge.origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.post("/api/bridge/playback", (req, res) => {
    if (
      !bridge ||
      !equalSecret(req.headers.authorization ?? "", `Bearer ${bridge.key}`)
    )
      throw new AppError("auth", "Khóa bridge không hợp lệ.", 0, 401);
    if (Date.now() - bridge.lastAt < 250)
      throw new AppError("rate-limit", "Bridge gửi quá nhanh.", 1000, 429);
    const v = youtubeSchema.parse(req.body);
    engine.youtube.receive(v);
    bridge.lastAt = Date.now();
    res.json({ accepted: true });
  });
  app.use("/api/session", (req, res, next) => {
    try {
      auth.originCheck(req);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/session", (req, res) => {
    const s =
      auth.get(req) ??
      (!options.password && options.localOnly ? auth.login(req, res) : null);
    if (!s) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      csrf: s.csrf,
      localOnly: options.localOnly,
      fixture: options.fixture === true,
    });
  });
  app.post("/api/session", (req, res) => {
    if (!req.is("application/json"))
      throw new AppError("auth", "Chỉ nhận JSON.", 0, 403);
    const v = z
      .object({ password: z.string().max(4096) })
      .strict()
      .parse(req.body);
    engine.vault.secrets.add(v.password);
    const s = auth.login(req, res, v.password);
    res.json({
      authenticated: true,
      csrf: s.csrf,
      localOnly: options.localOnly,
      fixture: options.fixture === true,
    });
  });
  app.use("/api", auth.middleware);
  app.delete("/api/session", (req, res) => {
    engine.passwordLogin.cancel(res.locals.session.id);
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.get("/api/state", (_req, res) => res.json(engine.snapshot()));
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.flushHeaders();
    const s = res.locals.session;
    const emit = () => {
      if (
        s.expires < Date.now() ||
        !auth.get(req) ||
        res.writableLength > 1048576
      ) {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    };
    emit();
    const timer = setInterval(emit, 1000);
    req.on("close", () => clearInterval(timer));
  });
  app.put("/api/config", (req, res) => {
    engine.updateConfig(req.body);
    res.json(engine.snapshot());
  });
  app.post("/api/discord/connect", async (req, res) => {
    auth.localInput();
    engine.passwordLogin.cancel(res.locals.session.id);
    const p = profileSchema.parse(req.body);
    if (p.token) engine.vault.secrets.add(p.token);
    await engine.connect(p);
    res.json(engine.snapshot());
  });
  app.get("/api/discord/login", (_req, res) => {
    auth.localInput();
    res.json(engine.passwordLogin.state(res.locals.session.id));
  });
  app.post("/api/discord/login", async (req, res) => {
    auth.localInput();
    const login = await engine.passwordLogin.start(res.locals.session.id, req.body);
    res.json({ login, dashboard: engine.snapshot() });
  });
  app.post("/api/discord/login/mfa", async (req, res) => {
    auth.localInput();
    const login = await engine.passwordLogin.verify(res.locals.session.id, req.body);
    res.json({ login, dashboard: engine.snapshot() });
  });
  app.delete("/api/discord/login", (_req, res) => {
    auth.localInput();
    engine.passwordLogin.cancel(res.locals.session.id);
    res.json(engine.passwordLogin.state(res.locals.session.id));
  });
  app.post("/api/discord/reconnect", async (_req, res) => {
    engine.passwordLogin.cancel(res.locals.session.id);
    await engine.reconnect();
    res.json(engine.snapshot());
  });
  app.post("/api/discord/disconnect", async (req, res) => {
    engine.passwordLogin.cancel(res.locals.session.id);
    const v = z
      .object({ forget: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    await engine.disconnect(v.forget);
    res.json(engine.snapshot());
  });
  app.post("/api/sync", async (req, res) => {
    const v = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await engine.setEnabled(v.enabled);
    res.json(engine.snapshot());
  });
  app.post("/api/music/manual", (req, res) => {
    engine.manual.set(manualSchema.parse(req.body));
    res.json(engine.snapshot());
  });
  app.post("/api/music/transport", (req, res) => {
    const v = z
      .object({
        playing: z.boolean(),
        positionMs: z.number().finite().nonnegative().max(86400000).optional(),
      })
      .strict()
      .parse(req.body);
    if (engine.config.musicSource !== "manual")
      throw new AppError(
        "unsupported",
        "Điều khiển này chỉ thay đổi timeline thủ công; không điều khiển Spotify hoặc YouTube.",
      );
    engine.manual.transport(v.playing, v.positionMs);
    res.json(engine.snapshot());
  });
  app.post("/api/music/check", async (_req, res) => {
    await engine.spotify.poll(0);
    res.json(engine.snapshot());
  });
  app.post("/api/music/spotify/disconnect", (_req, res) => {
    engine.spotify.disconnect();
    res.json(engine.snapshot());
  });
  app.post("/api/music/resolve", async (req, res) => {
    const { url } = z
      .object({ url: z.string().max(2048) })
      .strict()
      .parse(req.body);
    const canonical = canonicalMusicUrl(url);
    const key = `metadata:${canonical}`;
    let track = engine.store.cached<any>(key);
    if (!track) {
      if (canonical.includes("open.spotify.com"))
        track = await engine.spotify.metadata(canonical);
      else {
        const p = engine.youtube.read();
        if (p.stale || p.track?.url !== canonical)
          throw new AppError(
            "unsupported",
            "Chưa có mẫu phát thực tế từ bridge cho URL này; hãy nhập tên và nghệ sĩ.",
          );
        track = p.track;
      }
      engine.store.cache(key, track);
    }
    res.json({ track, playbackClaimed: false });
  });
  app.get("/api/lyrics", (_req, res) => res.json(engine.store.listLyrics()));
  app.post("/api/lyrics/import", (req, res) => {
    const v = z
      .object({
        title: z.string().trim().min(1).max(256),
        artist: z.string().trim().min(1).max(256),
        text: z.string().min(1).max(200000),
        durationMs: z.number().finite().positive().max(86400000).nullable(),
        bind: z.boolean(),
      })
      .strict()
      .parse(req.body);
    const l = engine.lyrics.import(v.title, v.artist, v.text, v.durationMs);
    if (v.bind && engine.playback().track)
      engine.store.bind(engine.playback().track!.id, l.id);
    res.json({ lyrics: l });
  });
  app.post("/api/lyrics/search", async (req, res) => {
    const v = z
      .object({
        title: z.string().trim().min(1).max(256),
        artist: z.string().trim().min(1).max(256),
        durationMs: z.number().finite().nonnegative().max(86400000),
      })
      .strict()
      .parse(req.body);
    res.json(
      await engine.lyrics.search(
        v.title,
        v.artist,
        v.durationMs,
        engine.config.lrclibEnabled,
      ),
    );
  });
  app.post("/api/lyrics/bind", (req, res) => {
    const v = z
      .object({ lyricsId: z.string().max(128).nullable() })
      .strict()
      .parse(req.body);
    const p = engine.playback();
    if (!p.track)
      throw new AppError("validation", "Chưa có bài hát để gắn lyrics.");
    if (v.lyricsId && !engine.store.getLyrics(v.lyricsId))
      throw new AppError("validation", "Không tìm thấy lyrics đã chọn.");
    engine.store.bind(p.track.id, v.lyricsId);
    res.json(engine.snapshot());
  });
  app.post("/api/bridge/pair", (req, res) => {
    auth.localInput();
    const v = z
      .object({ extensionId: z.string().regex(/^[a-p]{32}$/) })
      .strict()
      .parse(req.body);
    bridge = {
      key: randomBytes(32).toString("base64url"),
      origin: `chrome-extension://${v.extensionId}`,
      expires: Date.now() + 86400000,
      lastAt: 0,
    };
    engine.vault.secrets.add(bridge.key);
    res.json({ key: bridge.key, expiresAt: bridge.expires });
  });
  app.post("/api/oauth/:provider/start", (req, res) => {
    if (options.fixture)
      throw new AppError("unsupported", "Phòng thử cục bộ chỉ dùng đăng nhập mẫu; không mở OAuth dịch vụ thật.", 0, 422);
    auth.localInput();
    const provider = z.enum(["discord", "spotify"]).parse(req.params.provider);
    const v = z
      .object({
        clientId: z.string().trim().min(1).max(256),
        clientSecret: z.string().max(4096).optional(),
        persist: z.boolean(),
      })
      .strict()
      .parse(req.body);
    res.json({ url: engine.oauth.start(provider, v, res.locals.session.id) });
  });
  app.get("/api/oauth/:provider/callback", async (req, res) => {
    try {
      auth.localInput();
      const provider = z
        .enum(["discord", "spotify"])
        .parse(req.params.provider) as Provider;
      const v = z
        .object({ state: z.string().min(1), code: z.string().min(1).max(4096) })
        .parse(req.query);
      const s = await engine.oauth.finish(
        provider,
        v.state,
        v.code,
        res.locals.session.id,
      );
      if (provider === "discord")
        await engine.connect({ mode: "oauth2", persist: s.profile.persist });
      else engine.spotify.activate();
      engine.event(`Đã kết nối OAuth ${provider}.`);
    } catch (e) {
      engine.event(safeError(e).message);
    }
    res.redirect(303, "/");
  });
  const web = options.webDir ?? resolve("dist/web");
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(web, "index.html")),
    );
  }
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const e =
        err instanceof ZodError
          ? new AppError(
              "validation",
              "Dữ liệu không hợp lệ hoặc có trường không được hỗ trợ.",
            )
          : err &&
              typeof err === "object" &&
              "type" in err &&
              err.type === "entity.parse.failed"
            ? new AppError(
                "validation",
                "JSON không hợp lệ; nội dung đã được ẩn.",
              )
            : safeError(err);
      if (e.kind === "rate-limit")
        res.set("Retry-After", String(Math.ceil(e.retryMs / 1000)));
      res
        .status(e.status)
        .json({ error: engine.vault.secrets.redact(e.message), kind: e.kind });
    },
  );
  return app;
}
