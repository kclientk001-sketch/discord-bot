import { AppError } from "./security.js";
export type Fetcher = typeof fetch;
export function retryDelay(h: Headers, data: unknown, now = Date.now()) {
  const raw = h.get("retry-after");
  let header = 0;
  if (raw) {
    const n = Number(raw);
    header = Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(raw) - now);
  }
  const json =
    data && typeof data === "object" && "retry_after" in data
      ? Number(data.retry_after) * 1000
      : 0;
  const reset = Number(h.get("x-ratelimit-reset-after") ?? 0) * 1000;
  return Math.max(
    1000,
    Number.isFinite(header) ? header : 0,
    Number.isFinite(json) ? json : 0,
    Number.isFinite(reset) ? reset : 0,
  );
}
export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<{ data: T; rateWaitMs: number }> {
  let r: Response;
  try {
    r = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(10000),
    });
  } catch {
    throw new AppError(
      "network",
      "Không kết nối được dịch vụ; sẽ thử lại với phiên hiện tại.",
      5000,
      503,
    );
  }
  let data: any = null;
  try {
    if (r.status !== 204) data = await r.json();
  } catch {
    if (r.ok)
      throw new AppError(
        "service",
        "Dịch vụ trả dữ liệu không hợp lệ.",
        0,
        502,
      );
  }
  if (
    r.status === 429 &&
    (data?.error?.reason === "QUOTA_EXCEEDED" ||
      data?.reason === "QUOTA_EXCEEDED")
  )
    throw new AppError(
      "quota",
      "Hạn ngạch API đã hết; nguồn dừng. Chờ quota khả dụng rồi kết nối lại.",
      0,
      429,
    );
  if (r.status === 429)
    throw new AppError(
      "rate-limit",
      "Dịch vụ giới hạn tốc độ; đang chờ Retry-After.",
      retryDelay(r.headers, data),
      429,
    );
  if (data?.captcha_key || data?.code === 40002 || data?.code === 40003)
    throw new AppError(
      "verification",
      "Tài khoản cần xác minh trong ứng dụng chính thức.",
      0,
      403,
    );
  if (r.status === 401 || data?.error === "invalid_grant")
    throw new AppError(
      "auth",
      "Phiên không hợp lệ hoặc đã hết hạn; hãy kết nối lại.",
      0,
      401,
    );
  if (r.status === 403)
    throw new AppError(
      "verification",
      "Dịch vụ từ chối quyền truy cập hoặc yêu cầu xác minh.",
      0,
      403,
    );
  if (r.status === 404 || r.status === 405)
    throw new AppError(
      "unsupported",
      "Cơ chế này không được dịch vụ hỗ trợ tại endpoint đã kiểm tra.",
      0,
      422,
    );
  if (!r.ok)
    throw new AppError(
      "service",
      `Dịch vụ trả HTTP ${r.status}; chi tiết phản hồi đã được ẩn.`,
      0,
      502,
    );
  return {
    data: data as T,
    rateWaitMs:
      r.headers.get("x-ratelimit-remaining") === "0"
        ? retryDelay(r.headers, data)
        : 0,
  };
}
