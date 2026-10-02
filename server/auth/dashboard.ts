import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { AppError, equalSecret, Secrets } from "../security.js";
export interface DashboardSession {
  id: string;
  csrf: string;
  expires: number;
}
export class DashboardAuth {
  private sessions = new Map<string, DashboardSession>();
  private failures = new Map<string, { count: number; until: number }>();
  constructor(
    public origin: string,
    private password: string,
    public localOnly: boolean,
    private secrets: Secrets,
  ) {
    secrets.add(password);
  }
  private issue(res: Response) {
    const s = {
      id: randomBytes(32).toString("base64url"),
      csrf: randomBytes(32).toString("base64url"),
      expires: Date.now() + 43200000,
    };
    this.sessions.set(s.id, s);
    this.secrets.add(s.id);
    res.cookie("dls_session", s.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(this.origin).protocol === "https:",
      maxAge: 43200000,
      path: "/",
    });
    return s;
  }
  get(req: Request) {
    const id =
      req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("dls_session="))
        ?.slice("dls_session=".length) ?? "";
    const s = this.sessions.get(id);
    if (s && s.expires > Date.now()) return s;
    if (s) this.sessions.delete(id);
    return null;
  }
  login(req: Request, res: Response, password?: string) {
    const existing = this.get(req);
    if (existing) return existing;
    if (!this.password && this.localOnly) return this.issue(res);
    const key = req.socket.remoteAddress ?? "unknown",
      now = Date.now(),
      f = this.failures.get(key);
    if (f && f.until > now && f.count >= 5)
      throw new AppError(
        "rate-limit",
        "Quá nhiều lần đăng nhập sai; chờ 60 giây.",
        f.until - now,
        429,
      );
    if (!password || !equalSecret(password, this.password)) {
      const count = f && f.until > now ? f.count + 1 : 1;
      if (this.failures.size > 1000) this.failures.clear();
      this.failures.set(key, { count, until: now + 60000 });
      throw new AppError("auth", "Mật khẩu dashboard không đúng.", 0, 401);
    }
    this.failures.delete(key);
    return this.issue(res);
  }
  logout(req: Request, res: Response) {
    const s = this.get(req);
    if (s) this.sessions.delete(s.id);
    res.clearCookie("dls_session", { path: "/" });
  }
  host(req: Request) {
    if (req.headers.host !== new URL(this.origin).host)
      throw new AppError("auth", "Host không được phép.", 0, 403);
  }
  originCheck(req: Request) {
    const callback =
      req.method === "GET" &&
      /^\/api\/oauth\/(discord|spotify)\/callback$/.test(req.path);
    if (!callback && req.headers.origin && req.headers.origin !== this.origin)
      throw new AppError("auth", "Origin không được phép.", 0, 403);
    if (!callback && req.headers["sec-fetch-site"] === "cross-site")
      throw new AppError("auth", "Yêu cầu khác trang bị từ chối.", 0, 403);
  }
  middleware = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.originCheck(req);
      const s = this.get(req);
      if (!s) throw new AppError("auth", "Cần đăng nhập dashboard.", 0, 401);
      res.locals.session = s;
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        if (
          req.headers["x-csrf-token"] !== s.csrf ||
          !req.is("application/json")
        )
          throw new AppError("auth", "Yêu cầu thiếu CSRF hoặc JSON.", 0, 403);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
  localInput() {
    if (!this.localOnly || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(this.origin).hostname))
      throw new AppError(
        "unsupported",
        "Nhập thông tin xác thực và ghép bridge chỉ được mở khi server chạy cục bộ.",
        0,
        422,
      );
  }
}
