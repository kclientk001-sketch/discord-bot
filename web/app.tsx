import React, { useState, useEffect, type ReactNode } from "react";
import {
  defaults,
  type Config,
  type Dashboard,
  type DiscordMode,
  type Lyrics,
  type Track,
} from "../shared";
const tabs = [
  "Tổng quan",
  "Tài khoản",
  "Nguồn nhạc",
  "Lời bài hát",
  "Thiết lập",
] as const;
const names: Record<string, string> = {
  disconnected: "Chưa kết nối",
  connecting: "Đang xác thực",
  connected: "Đã kết nối",
  reconnecting: "Đang kết nối lại",
  expired: "Phiên hết hiệu lực",
  "verification-required": "Cần xác minh",
  error: "Lỗi",
  stopped: "Đã tắt",
  running: "Đang chạy",
  paused: "Tạm dừng",
  waiting: "Đang chờ",
  manual: "Thủ công",
  spotify: "Spotify",
  "youtube-music": "YouTube Music",
  "user-token": "User token (thử nghiệm)",
  oauth2: "OAuth2 identify",
  bot: "Bot token",
};
const fmt = (ms: number) => {
  const n = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const when = (n: number | null | undefined) =>
  n ? new Date(n).toLocaleTimeString("vi-VN") : "Chưa có";
const demoText =
  "[ti:Đêm dịu êm]\n[ar:Bản mẫu của ứng dụng]\n[00:00.00]Gió ghé qua ô cửa nhỏ\n[00:08.00]Phố lên đèn, trời vừa xanh\n[00:16.00]Một giai điệu đi rất khẽ\n[00:24.00]Giữ bình yên ở bên mình\n[00:32.00]Nghe thời gian trôi dịu dàng\n[00:40.00]Và ngày mai lại bắt đầu";
function Card({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={"card" + (wide ? " wide" : "")}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Badge({ value }: { value: string }) {
  return <span className={"badge " + value}>{names[value] ?? value}</span>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Check({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
export default function App() {
  const [session, setSession] = useState<{
      csrf: string;
      localOnly: boolean;
    } | null>(null),
    [boot, setBoot] = useState(true),
    [password, setPassword] = useState(""),
    [data, setData] = useState<Dashboard | null>(null),
    [tab, setTab] = useState<(typeof tabs)[number]>("Tổng quan"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState(false);
  const [mode, setMode] = useState<DiscordMode>("oauth2"),
    [token, setToken] = useState(""),
    [risk, setRisk] = useState(false),
    [remember, setRemember] = useState(false),
    [clientId, setClientId] = useState(""),
    [clientSecret, setClientSecret] = useState(""),
    [spotifyId, setSpotifyId] = useState(""),
    [authUrl, setAuthUrl] = useState("");
  const [title, setTitle] = useState(""),
    [artist, setArtist] = useState(""),
    [duration, setDuration] = useState(180),
    [url, setUrl] = useState(""),
    [seek, setSeek] = useState(0),
    [lyricsText, setLyricsText] = useState(""),
    [results, setResults] = useState<
      { lyrics: Lyrics; score: number; reason: string }[]
    >([]),
    [extensionId, setExtensionId] = useState(""),
    [bridgeKey, setBridgeKey] = useState("");
  const [draft, setDraft] = useState<Config>({ ...defaults });
  async function api<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-csrf-token": session?.csrf ?? "" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await r.json();
    if (!r.ok) {
      if (r.status === 401 && path === "/api/state") setSession(null);
      throw new Error(result.error ?? "Yêu cầu không thành công.");
    }
    return result as T;
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi khi gửi yêu cầu.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/session", { credentials: "same-origin" })
      .then(async (r) => {
        const s = await r.json();
        if (active && r.ok) setSession(s);
      })
      .catch(() => {
        if (active) setError("Không kết nối được dashboard.");
      })
      .finally(() => {
        if (active) setBoot(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    fetch("/api/state", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Không đọc được dashboard.");
        const d = await r.json();
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const s = new EventSource("/api/events");
    s.onopen = () => setStream(true);
    s.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (active) {
          setData(d);
          setStream(true);
        }
      } catch {
        setError("Dữ liệu cập nhật không hợp lệ.");
      }
    };
    s.onerror = () => setStream(false);
    return () => {
      active = false;
      s.close();
    };
  }, [session]);
  const cfgKey = data ? JSON.stringify(data.config) : "";
  useEffect(() => {
    if (data) setDraft({ ...data.config });
  }, [cfgKey]);
  async function config(c: Config) {
    const d = await api<Dashboard>("/api/config", c, "PUT");
    setData(d);
  }
  async function sync(enabled: boolean) {
    setData(await api<Dashboard>("/api/sync", { enabled }));
  }
  async function demo() {
    await config({
      ...data!.config,
      musicSource: "manual",
      output: "preview",
      dryRun: true,
    });
    await api("/api/music/manual", {
      title: "Đêm dịu êm",
      artist: "Bản mẫu của ứng dụng",
      durationMs: 48000,
    });
    await api("/api/lyrics/import", {
      title: "Đêm dịu êm",
      artist: "Bản mẫu của ứng dụng",
      durationMs: 48000,
      text: demoText,
      bind: true,
    });
    setData(
      await api<Dashboard>("/api/music/transport", {
        playing: true,
        positionMs: 0,
      }),
    );
    await sync(true);
    setNotice("Đang chạy timeline mẫu; ứng dụng không phát âm thanh.");
  }
  if (boot)
    return (
      <div className="center">
        <div className="login card">
          <h1>Discord Lyrics Status</h1>
          <p>Đang mở dashboard…</p>
        </div>
      </div>
    );
  if (!session)
    return (
      <div className="center">
        <form
          className="login card"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const entered = password;
              setPassword("");
              setSession(await api("/api/session", { password: entered }));
            });
          }}
        >
          <span className="brand-icon">♫</span>
          <h1>Discord Lyrics Status</h1>
          <p>Đăng nhập bảng điều khiển</p>
          <Field label="Mật khẩu dashboard">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <button disabled={busy}>Đăng nhập</button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </div>
    );
  if (!data)
    return (
      <div className="center">
        <p>Đang đọc trạng thái… {error}</p>
      </div>
    );
  const d = data,
    p = d.playback,
    a = d.account,
    q = d.sync.queue,
    local = session.localOnly;
  const lyricsTitle = title || p.track?.title || "",
    lyricsArtist = artist || p.track?.artist || "";
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">♫</span>
          <div>
            <strong>Lyrics Status</strong>
            <small>Discord • Bảng điều khiển</small>
          </div>
        </div>
        <nav>
          {tabs.map((x, i) => (
            <button
              key={x}
              className={tab === x ? "nav active" : "nav"}
              onClick={() => {
                setTab(x);
                setError("");
                setNotice("");
              }}
            >
              <span aria-hidden="true">{["◈", "◉", "♫", "≡", "⚙"][i]}</span>
              {x}
            </button>
          ))}
        </nav>
        <div className="side-note">
          <span className="dot" /> {local ? "Phiên cục bộ" : "Phiên qua mạng"}
          <p>
            Bí mật chỉ nhập cục bộ.
            <br />
            Không lưu token vào trình duyệt.
          </p>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">DISCORD LYRICS STATUS</span>
            <h1>{tab}</h1>
          </div>
          <div className="header-status">
            <span className={"dot " + (stream ? "" : "offline")} />
            {stream ? "Dashboard đang cập nhật" : "Dashboard mất kết nối"}
          </div>
        </header>
        {!stream && (
          <div className="banner">
            Luồng dashboard đang kết nối lại. Trạng thái Discord bên dưới là mẫu
            nhận gần nhất.
          </div>
        )}
        {error && (
          <div role="alert" className="banner error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="banner good">
            {notice}
          </div>
        )}
        <div className="toolbar">
          <Badge value={d.sync.state} />
          <p>{d.sync.reason}</p>
          <button
            className={d.sync.enabled ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => void act(() => sync(!d.sync.enabled))}
          >
            {d.sync.enabled ? "Tắt đồng bộ" : "Bật đồng bộ"}
          </button>
        </div>
        {tab === "Tổng quan" && (
          <>
            <div className="demo-banner">
              <div>
                <strong>Thử giao diện và dòng lyrics</strong>
                <p>
                  Timeline mẫu với lời do ứng dụng tạo; không giả lập đăng nhập
                  Discord.
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy || d.sync.enabled}
                onClick={() => void act(demo)}
              >
                Chạy thử
              </button>
            </div>
            <div className="grid">
              <Card title="Status Account">
                <div className="account-row">
                  {a.identity?.avatar ? (
                    <img
                      className="avatar"
                      src={a.identity.avatar}
                      alt="Avatar tài khoản Discord"
                    />
                  ) : (
                    <div className="avatar placeholder">
                      {a.identity?.name.slice(0, 1) ?? "?"}
                    </div>
                  )}
                  <div>
                    <h3>{a.identity?.name ?? "Chưa có tài khoản"}</h3>
                    <p>
                      {a.identity?.username ?? "Kết nối để xác minh danh tính"}
                    </p>
                  </div>
                  <Badge value={a.connection} />
                </div>
                <dl>
                  <dt>ID</dt>
                  <dd className="mono">{a.identity?.id ?? "—"}</dd>
                  <dt>Loại tài khoản</dt>
                  <dd>
                    {a.identity?.kind === "bot"
                      ? "Bot riêng"
                      : a.identity
                        ? "Tài khoản cá nhân"
                        : "Chưa xác minh"}
                  </dd>
                  <dt>Xác thực</dt>
                  <dd>{a.mode ? names[a.mode] : "—"}</dd>
                  <dt>Thời gian kết nối</dt>
                  <dd>{a.connectedAt ? fmt(d.now - a.connectedAt) : "—"}</dd>
                  <dt>Ứng dụng hoạt động</dt>
                  <dd>{fmt(d.now - d.startedAt)}</dd>
                  <dt>Lỗi gần nhất</dt>
                  <dd className={a.lastError ? "error" : ""}>
                    {a.lastError ?? "Chưa có"}
                  </dd>
                </dl>
                <div className="buttons">
                  <button
                    className="secondary"
                    onClick={() => setTab("Tài khoản")}
                  >
                    Quản lý tài khoản
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setData(await api("/api/discord/reconnect", {})),
                      )
                    }
                  >
                    Kết nối lại
                  </button>
                  <button
                    className="ghost"
                    disabled={busy || a.connection === "disconnected"}
                    onClick={() =>
                      void act(async () =>
                        setData(
                          await api("/api/discord/disconnect", {
                            forget: false,
                          }),
                        ),
                      )
                    }
                  >
                    Ngắt kết nối
                  </button>
                </div>
              </Card>
              <Card title="Nguồn nhạc">
                <div className="song">
                  <div className="cover" aria-hidden="true">
                    ♫
                  </div>
                  <div>
                    <span className="eyebrow">{names[p.source]}</span>
                    <h3>{p.track?.title ?? "Chưa có bài đang phát"}</h3>
                    <p>{p.track?.artist ?? "Chọn nguồn nhạc để bắt đầu"}</p>
                  </div>
                </div>
                <progress
                  value={d.timelinePositionMs}
                  max={p.track?.durationMs || 1}
                  aria-label="Tiến độ phát"
                />
                <div className="time-row">
                  <span>{fmt(d.timelinePositionMs)}</span>
                  <span>{fmt(p.track?.durationMs ?? 0)}</span>
                </div>
                <p className="muted">
                  {p.stale
                    ? "Dữ liệu nguồn phát đã cũ"
                    : p.playing
                      ? "Đang phát"
                      : "Tạm dừng"}
                  {p.source === "manual"
                    ? " • Chỉ là timeline thủ công, không phát nhạc."
                    : ""}
                </p>
                <div className="buttons">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setData(await api("/api/music/check", {})),
                      )
                    }
                  >
                    Kiểm tra nguồn nhạc
                  </button>
                  <button
                    className="ghost"
                    onClick={() => setTab("Nguồn nhạc")}
                  >
                    Đổi nguồn
                  </button>
                </div>
              </Card>
              <Card title="Lời bài hát">
                <div className="lyrics-current">
                  {d.lyrics && d.selectedLine !== null
                    ? d.lyrics.lines[d.selectedLine].text || "(Dòng trống)"
                    : "Chưa chọn được dòng lyrics"}
                </div>
                <dl>
                  <dt>Nguồn lyrics</dt>
                  <dd>
                    {d.lyrics
                      ? d.lyrics.source === "file"
                        ? "Tệp của bạn"
                        : "LRCLIB"
                      : "Chưa có • dùng mẫu dự phòng"}
                  </dd>
                  <dt>Đồng bộ</dt>
                  <dd>
                    {d.lyrics?.kind === "lrc"
                      ? "Timestamp LRC"
                      : d.lyrics?.kind === "txt"
                        ? "Luân phiên theo khoảng thời gian (không chính xác)"
                        : "—"}
                  </dd>
                  <dt>Độ lệch</dt>
                  <dd>
                    {d.config.offsetMs / 1000} giây
                    {d.lyrics?.offsetMs
                      ? ` + LRC ${d.lyrics.offsetMs / 1000} giây`
                      : ""}
                  </dd>
                </dl>
                <button
                  className="secondary"
                  onClick={() => setTab("Lời bài hát")}
                >
                  Chọn / sửa lyrics
                </button>
              </Card>
              <Card title="Xem trước trạng thái">
                <span className="eyebrow">BẢN XEM TRƯỚC CỤC BỘ</span>
                <div className="preview">
                  <span className="dot" />
                  <p>{d.preview || "(Trạng thái trống)"}</p>
                </div>
                <p className="muted">
                  {d.preview.length}/128 đơn vị UTF-16 • giữ nguyên grapheme
                  Unicode.
                </p>
                <p>
                  Đây là bản xem trước, không chứng minh trạng thái đã hiển thị
                  trong Discord.
                </p>
                <button className="ghost" onClick={() => setTab("Thiết lập")}>
                  Chỉnh chế độ gửi
                </button>
              </Card>
              <Card title="Yêu cầu và xác nhận" wide>
                <div className="queue-grid">
                  <div>
                    <span className="eyebrow">ĐANG CHỜ</span>
                    <p>
                      {q.pending === null
                        ? "Không có"
                        : q.pending || "(Trạng thái trống)"}
                    </p>
                    <small>
                      {q.waitUntil
                        ? `Sớm nhất ${when(q.waitUntil)}`
                        : "Hàng đợi giữ dòng mới nhất"}
                    </small>
                  </div>
                  <div>
                    <span className="eyebrow">ĐANG GỬI</span>
                    <p>
                      {q.inFlight === null
                        ? "Không có"
                        : q.inFlight || "(Trạng thái trống)"}
                    </p>
                    <small>Yêu cầu đã gửi không thể thu hồi</small>
                  </div>
                  <div>
                    <span className="eyebrow">GỬI GẦN NHẤT</span>
                    <p>
                      {q.lastSubmitted
                        ? q.lastSubmitted.text || "(Trạng thái trống)"
                        : "Chưa gửi"}
                    </p>
                    <small>
                      {when(q.lastSubmitted?.at)}
                      {q.lastSubmitted?.result === "gateway-submitted"
                        ? " • Gateway, không có ACK cho presence"
                        : ""}
                    </small>
                  </div>
                  <div>
                    <span className="eyebrow">DỊCH VỤ XÁC NHẬN</span>
                    <p>
                      {q.lastConfirmed
                        ? q.lastConfirmed.text || "(Trạng thái trống)"
                        : "Chưa xác nhận"}
                    </p>
                    <small>
                      {when(q.lastConfirmed?.at)} • Phản hồi settings, chưa quan
                      sát client
                    </small>
                  </div>
                </div>
                {q.lastError && <p className="error">{q.lastError}</p>}
              </Card>
              <Card title="Hoạt động gần đây" wide>
                {d.events.length ? (
                  <ul className="events">
                    {d.events.map((e, i) => (
                      <li key={i}>
                        <time>{when(e.at)}</time>
                        <span>{e.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">
                    Chưa có sự kiện. Không ghi thông tin xác thực vào nhật ký.
                  </p>
                )}
              </Card>
            </div>
          </>
        )}
        {tab === "Tài khoản" && (
          <div className="grid">
            <Card title="Kết nối Discord">
              <p>
                Discord cấm tự động hóa tài khoản cá nhân (self-bot), có thể
                khóa tài khoản. Chế độ user token dùng endpoint legacy thử
                nghiệm; OAuth2 identify chỉ đọc danh tính.
              </p>
              {!local && (
                <p className="banner">
                  Thông tin xác thực chỉ nhập khi server chạy cục bộ. Phiên đã
                  lưu trong kho OS có thể kết nối lại.
                </p>
              )}
              <Field label="Phương thức xác thực">
                <select
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as DiscordMode);
                    setToken("");
                    setAuthUrl("");
                  }}
                >
                  <option value="oauth2">
                    OAuth2 chính thức • đọc danh tính
                  </option>
                  <option value="user-token">
                    User token • Custom Status thử nghiệm
                  </option>
                  <option value="bot">
                    Bot token • Activity của bot riêng
                  </option>
                </select>
              </Field>
              {mode === "oauth2" ? (
                <>
                  <Field label="Discord Client ID">
                    <input
                      value={clientId}
                      disabled={!local}
                      onChange={(e) => setClientId(e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Discord Client Secret">
                    <input
                      type="password"
                      value={clientSecret}
                      disabled={!local}
                      onChange={(e) => setClientSecret(e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="muted">
                    Redirect: {location.origin}/api/oauth/discord/callback.
                    Scope: identify. Không có quyền đổi Custom Status.
                  </p>
                </>
              ) : (
                <>
                  <Field
                    label={
                      mode === "bot"
                        ? "Bot token"
                        : "User token của tài khoản của bạn"
                    }
                  >
                    <input
                      type="password"
                      value={token}
                      disabled={!local}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  {mode === "user-token" && (
                    <Check
                      label="Đây là tài khoản của tôi; tôi hiểu giới hạn self-bot và endpoint legacy có thể không còn hoạt động."
                      checked={risk}
                      onChange={setRisk}
                    />
                  )}
                  <p className="muted">
                    Không tự tìm token từ Discord, cookie hoặc trình duyệt.
                    Token không đi vào URL, log hoặc localStorage.
                  </p>
                </>
              )}
              <Check
                label="Lưu phiên vào kho thông tin xác thực của hệ điều hành"
                checked={remember}
                onChange={setRemember}
                disabled={!d.vault.available}
              />
              <p className="muted">{d.vault.description}</p>
              <div className="buttons">
                <button
                  disabled={busy || !local || (mode === "user-token" && !risk)}
                  onClick={() =>
                    void act(async () => {
                      if (mode === "oauth2") {
                        const secret = clientSecret;
                        setClientSecret("");
                        const r = await api<{ url: string }>(
                          "/api/oauth/discord/start",
                          { clientId, clientSecret: secret, persist: remember },
                        );
                        setAuthUrl(r.url);
                      } else {
                        const credential = token;
                        setToken("");
                        setData(
                          await api("/api/discord/connect", {
                            mode,
                            token: credential,
                            persist: remember,
                            acceptedRisk: risk,
                          }),
                        );
                      }
                    })
                  }
                >
                  Kết nối
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setData(await api("/api/discord/reconnect", {})),
                    )
                  }
                >
                  Kết nối lại
                </button>
              </div>
              {authUrl && (
                <a
                  className="oauth-link"
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Mở trang cấp quyền chính thức ↗
                </a>
              )}
              <hr />
              <p>
                Cookie Discord không được chấp nhận thay token. Cookie HttpOnly
                của dashboard là phiên riêng của ứng dụng này.
              </p>
            </Card>
            <Card title="Phiên hiện tại">
              <Badge value={a.connection} />
              <dl>
                <dt>Tài khoản</dt>
                <dd>{a.identity?.name ?? "Chưa xác minh"}</dd>
                <dt>ID</dt>
                <dd>{a.identity?.id ?? "—"}</dd>
                <dt>Loại</dt>
                <dd>
                  {a.identity?.kind === "bot"
                    ? "Bot"
                    : "Cá nhân / chưa xác minh"}
                </dd>
                <dt>Custom Status legacy</dt>
                <dd>
                  {a.customStatusSupported
                    ? "Endpoint có phản hồi phù hợp"
                    : "Chưa có khả năng gửi"}
                </dd>
                <dt>Trạng thái ban đầu</dt>
                <dd>
                  {a.originalStatusKnown ? "Đã chụp vào RAM" : "Chưa chụp"}
                </dd>
                <dt>Thử lại</dt>
                <dd>{when(a.retryAt)}</dd>
              </dl>
              {a.lastError && <p className="error">{a.lastError}</p>}
              <div className="buttons">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setData(
                        await api("/api/discord/disconnect", { forget: false }),
                      ),
                    )
                  }
                >
                  Ngắt kết nối
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setData(
                        await api("/api/discord/disconnect", { forget: true }),
                      ),
                    )
                  }
                >
                  Ngắt và xóa phiên lưu
                </button>
              </div>
              <p className="muted">
                Bỏ chọn lưu phiên không xóa phiên đã lưu trước đó; dùng nút xóa
                phiên. Phiên hết hiệu lực hoặc cần xác minh sẽ dừng tự kết nối
                lại.
              </p>
            </Card>
          </div>
        )}
        {tab === "Nguồn nhạc" && (
          <div className="grid">
            <Card title="Chọn nguồn phát">
              <Field label="Nguồn nhạc">
                <select
                  value={d.config.musicSource}
                  disabled={busy}
                  onChange={(e) =>
                    void act(() =>
                      config({
                        ...d.config,
                        musicSource: e.target.value as Config["musicSource"],
                      }),
                    )
                  }
                >
                  <option value="manual">Timeline thủ công</option>
                  <option value="spotify">Spotify OAuth2</option>
                  <option value="youtube-music">YouTube Music bridge</option>
                </select>
              </Field>
              <p>
                Metadata URL không cho biết bài đang nghe. Nguồn lyrics được
                quản lý riêng.
              </p>
              <dl>
                <dt>Bài hát</dt>
                <dd>{p.track?.title ?? "Chưa có"}</dd>
                <dt>Nghệ sĩ</dt>
                <dd>{p.track?.artist ?? "—"}</dd>
                <dt>Tiến độ</dt>
                <dd>
                  {fmt(d.timelinePositionMs)} / {fmt(p.track?.durationMs ?? 0)}
                </dd>
              </dl>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setData(await api("/api/music/check", {})),
                  )
                }
              >
                Kiểm tra nguồn nhạc
              </button>
            </Card>
            <Card title="Spotify">
              <Field label="Spotify Client ID">
                <input
                  value={spotifyId}
                  onChange={(e) => setSpotifyId(e.target.value)}
                  disabled={!local}
                  autoComplete="off"
                />
              </Field>
              <p className="muted">
                PKCE • scope user-read-currently-playing. Redirect:{" "}
                {location.origin}/api/oauth/spotify/callback. Spotify yêu cầu
                loopback IP; đọc READ­ME về giới hạn Development Mode.
              </p>
              <div className="buttons">
                <button
                  disabled={busy || !local}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ url: string }>(
                        "/api/oauth/spotify/start",
                        { clientId: spotifyId, persist: remember },
                      );
                      setAuthUrl(r.url);
                    })
                  }
                >
                  Kết nối Spotify
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setData(await api("/api/music/spotify/disconnect", {})),
                    )
                  }
                >
                  Ngắt Spotify
                </button>
              </div>
              {authUrl.includes("accounts.spotify.com") && (
                <a
                  className="oauth-link"
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Cấp quyền Spotify ↗
                </a>
              )}
              <p className={d.sources.spotify.lastError ? "error" : "muted"}>
                {d.sources.spotify.lastError ??
                  (d.sources.spotify.active
                    ? "Phiên Spotify đang hoạt động."
                    : "Chưa kết nối Spotify.")}
              </p>
            </Card>
            <Card title="Nhập bài hát / URL">
              <Field label="Tên bài hát">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Nghệ sĩ">
                <input
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                />
              </Field>
              <Field label="Thời lượng (giây)">
                <input
                  type="number"
                  min="1"
                  max="86400"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </Field>
              <Field label="URL Spotify / YouTube (tùy chọn)">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <div className="buttons">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await config({ ...d.config, musicSource: "manual" });
                      setData(
                        await api("/api/music/manual", {
                          title,
                          artist,
                          durationMs: duration * 1000,
                          ...(url ? { url } : {}),
                        }),
                      );
                    })
                  }
                >
                  Dùng timeline thủ công
                </button>
                <button
                  className="secondary"
                  disabled={busy || !url}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ track: Track }>(
                        "/api/music/resolve",
                        { url },
                      );
                      setTitle(r.track.title);
                      setArtist(r.track.artist);
                      setDuration(r.track.durationMs / 1000);
                      setNotice(
                        "Đã đọc metadata có cache; không xác nhận đây là bài đang phát.",
                      );
                    })
                  }
                >
                  Đọc metadata URL
                </button>
              </div>
              <hr />
              <Field label="Tua timeline thủ công (giây)">
                <input
                  type="number"
                  min="0"
                  max={
                    p.track?.durationMs
                      ? Math.floor(p.track.durationMs / 1000)
                      : 86400
                  }
                  value={seek}
                  onChange={(e) => setSeek(Number(e.target.value))}
                />
              </Field>
              <div className="buttons">
                <button
                  className="secondary"
                  disabled={busy || p.source !== "manual" || !p.track}
                  onClick={() =>
                    void act(async () =>
                      setData(
                        await api("/api/music/transport", {
                          playing: !p.playing,
                        }),
                      ),
                    )
                  }
                >
                  {p.playing ? "Tạm dừng timeline" : "Chạy timeline"}
                </button>
                <button
                  className="ghost"
                  disabled={busy || p.source !== "manual" || !p.track}
                  onClick={() =>
                    void act(async () =>
                      setData(
                        await api("/api/music/transport", {
                          playing: p.playing,
                          positionMs: seek * 1000,
                        }),
                      ),
                    )
                  }
                >
                  Tua
                </button>
              </div>
              <p className="muted">
                Không phát âm thanh hoặc điều khiển player thật.
              </p>
            </Card>
            <Card title="YouTube Music bridge">
              <ol>
                <li>
                  Nạp thư mục extension/ytm bằng “Load unpacked” trong Chrome /
                  Edge.
                </li>
                <li>
                  Lấy Extension ID trong popup, nhập bên dưới rồi tạo khóa.
                </li>
                <li>
                  Dán khóa vào popup, mở tab music.youtube.com, bật theo dõi tab
                  đang nghe.
                </li>
              </ol>
              <Field label="Extension ID">
                <input
                  value={extensionId}
                  onChange={(e) => setExtensionId(e.target.value)}
                  autoComplete="off"
                  disabled={!local}
                />
              </Field>
              <button
                disabled={busy || !local}
                onClick={() =>
                  void act(async () => {
                    const r = await api<{ key: string }>("/api/bridge/pair", {
                      extensionId,
                    });
                    setBridgeKey(r.key);
                  })
                }
              >
                Tạo khóa ghép bridge
              </button>
              {bridgeKey && (
                <>
                  <Field label="Khóa bridge (chỉ hiện tại đây)">
                    <input
                      type="password"
                      value={bridgeKey}
                      readOnly
                      autoComplete="off"
                    />
                  </Field>
                  <button
                    className="ghost"
                    onClick={() =>
                      void act(async () => {
                        await navigator.clipboard.writeText(bridgeKey);
                        setNotice("Đã sao chép khóa bridge.");
                      })
                    }
                  >
                    Sao chép khóa
                  </button>
                  <button className="ghost" onClick={() => setBridgeKey("")}>
                    Ẩn và xóa khỏi giao diện
                  </button>
                </>
              )}
              <p className="muted">
                Khóa bridge riêng, không phải token Discord. Giữ trong
                RAM/session extension, hết hạn sau 24 giờ; ghép lại khi khởi
                động lại. Bridge chỉ hỗ trợ server HTTP loopback.
              </p>
              <dl>
                <dt>Mẫu nhận gần nhất</dt>
                <dd>{when(d.sources.youtube.lastSeen)}</dd>
              </dl>
              <p>
                Đọc currentTime, paused, duration và playbackRate của player
                thật; ngừng tin dữ liệu sau 8 giây không có mẫu. Không đọc
                cookie hoặc tài khoản.
              </p>
            </Card>
          </div>
        )}
        {tab === "Lời bài hát" && (
          <div className="grid">
            <Card title="Lyrics của bạn">
              <p>
                Nhận LRC / TXT UTF-8 tối đa 200 KB. Chỉ dùng lời bạn có quyền
                truy cập và sử dụng.
              </p>
              <Field label="Tên bài để đối chiếu">
                <input
                  value={lyricsTitle}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Nghệ sĩ để đối chiếu">
                <input
                  value={lyricsArtist}
                  onChange={(e) => setArtist(e.target.value)}
                />
              </Field>
              <Field label="Tệp LRC / TXT">
                <input
                  type="file"
                  accept=".lrc,.txt,text/plain"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void act(async () => {
                        if (file.size > 200000)
                          throw new Error("Tệp vượt 200 KB.");
                        setLyricsText(await file.text());
                      });
                  }}
                />
              </Field>
              <Field label="Nội dung lời bài hát">
                <textarea
                  rows={11}
                  value={lyricsText}
                  onChange={(e) => setLyricsText(e.target.value)}
                  placeholder="[00:08.00]Dòng lời bài hát của bạn"
                />
              </Field>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/api/lyrics/import", {
                      title: lyricsTitle,
                      artist: lyricsArtist,
                      durationMs: p.track?.durationMs ?? duration * 1000,
                      text: lyricsText,
                      bind: true,
                    });
                    setData(await api("/api/state"));
                    setNotice(
                      p.track
                        ? "Đã nhập và gắn lyrics với bài hiện tại."
                        : "Đã nhập lyrics; chọn bài để gắn.",
                    );
                  })
                }
              >
                Nhập và gắn với bài hiện tại
              </button>
            </Card>
            <Card title="Tìm và sửa bài khớp">
              <p>
                Đối chiếu tên, nghệ sĩ và thời lượng; bạn chọn kết quả để gắn.
                Không tự coi kết quả đầu là đúng.
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setResults(
                      await api("/api/lyrics/search", {
                        title: lyricsTitle,
                        artist: lyricsArtist,
                        durationMs: p.track?.durationMs ?? duration * 1000,
                      }),
                    ),
                  )
                }
              >
                Tìm lyrics
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const rows = await api<Lyrics[]>("/api/lyrics");
                    setResults(
                      rows.map((lyrics) => ({
                        lyrics,
                        score: 0,
                        reason: "Tệp trong thư viện cục bộ.",
                      })),
                    );
                  })
                }
              >
                Xem tệp đã nhập
              </button>
              <p className="muted">
                {d.config.lrclibEnabled
                  ? "Có tìm LRCLIB công khai (cache 24 giờ). Quyền API không đồng nghĩa quyền tác giả."
                  : "Đang tìm tệp cục bộ. Bật LRCLIB ở Thiết lập nếu có quyền phù hợp."}
              </p>
              <div className="matches">
                {results.map((r) => (
                  <article key={r.lyrics.id}>
                    <strong>{r.lyrics.title}</strong>
                    <p>
                      {r.lyrics.artist} •{" "}
                      {r.lyrics.durationMs
                        ? fmt(r.lyrics.durationMs)
                        : "Chưa có thời lượng"}
                    </p>
                    <small>
                      {r.score ? `${r.score}% • ` : ""}
                      {r.reason} • {r.lyrics.kind.toUpperCase()}
                    </small>
                    <button
                      className="secondary"
                      disabled={busy || !p.track}
                      onClick={() =>
                        void act(async () =>
                          setData(
                            await api("/api/lyrics/bind", {
                              lyricsId: r.lyrics.id,
                            }),
                          ),
                        )
                      }
                    >
                      Dùng lyrics này
                    </button>
                  </article>
                ))}
              </div>
              {d.lyrics && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setData(
                        await api("/api/lyrics/bind", { lyricsId: null }),
                      ),
                    )
                  }
                >
                  Gỡ lyrics khớp nhầm
                </button>
              )}
            </Card>
            <Card title="Dòng lyrics đang chọn" wide>
              {d.lyrics?.kind === "txt" && (
                <p className="banner">
                  TXT luân phiên theo khoảng cấu hình, không đồng bộ chính xác
                  với bài hát.
                </p>
              )}
              {d.lyrics ? (
                <div className="lyrics-list">
                  {d.lyrics.lines.map((line, i) => (
                    <div
                      className={d.selectedLine === i ? "selected" : ""}
                      key={i}
                    >
                      <time>{line.atMs === null ? "TXT" : fmt(line.atMs)}</time>
                      <span>{line.text || "(Dòng trống)"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>Chưa gắn lyrics. Bản xem trước dùng mẫu dự phòng.</p>
              )}
            </Card>
          </div>
        )}
        {tab === "Thiết lập" && (
          <div className="grid">
            <Card title="Đồng bộ và giới hạn">
              <Field label="Đích cập nhật">
                <select
                  value={draft.output}
                  disabled={d.sync.enabled}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      output: e.target.value as Config["output"],
                    })
                  }
                >
                  <option value="preview">Xem trước cục bộ</option>
                  <option value="custom-status">
                    Custom Status cá nhân • legacy thử nghiệm
                  </option>
                  <option value="bot-activity">
                    Listening Activity của bot riêng
                  </option>
                </select>
              </Field>
              <Check
                label="Chạy thử: chỉ xem trước, không gửi dịch vụ"
                checked={draft.dryRun}
                disabled={d.sync.enabled}
                onChange={(v) => setDraft({ ...draft, dryRun: v })}
              />
              <Field label="Độ lệch lyrics (giây; dương = hiện sớm)">
                <input
                  type="number"
                  min="-60"
                  max="60"
                  step="0.1"
                  value={draft.offsetMs / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      offsetMs: Math.round(Number(e.target.value) * 1000),
                    })
                  }
                />
              </Field>
              <Field label="Luân phiên TXT (giây)">
                <input
                  type="number"
                  min="1"
                  max="300"
                  value={draft.plainIntervalMs / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      plainIntervalMs: Number(e.target.value) * 1000,
                    })
                  }
                />
              </Field>
              <Field label="Khoảng gửi tối thiểu (giây)">
                <input
                  type="number"
                  min="15"
                  max="300"
                  value={draft.minUpdateMs / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      minUpdateMs: Number(e.target.value) * 1000,
                    })
                  }
                />
              </Field>
              <Field label="Chu kỳ đọc Spotify (giây)">
                <input
                  type="number"
                  min="5"
                  max="60"
                  value={draft.spotifyPollMs / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      spotifyPollMs: Number(e.target.value) * 1000,
                    })
                  }
                />
              </Field>
              <Field label="Mẫu dự phòng">
                <input
                  value={draft.fallback}
                  onChange={(e) =>
                    setDraft({ ...draft, fallback: e.target.value })
                  }
                />
              </Field>
              <p className="muted">
                Biến: {"{title}"} và {"{artist}"}. Trạng thái cắt an toàn ở 128
                đơn vị UTF-16. Rate limit thực tế luôn được ưu tiên.
              </p>
              <Check
                label="Khôi phục Custom Status ban đầu khi tắt đồng bộ"
                checked={draft.restoreOnStop}
                disabled={d.sync.enabled}
                onChange={(v) => setDraft({ ...draft, restoreOnStop: v })}
              />
              <Check
                label="Cho phép tìm LRCLIB; tôi có quyền sử dụng lyrics phù hợp"
                checked={draft.lrclibEnabled}
                onChange={(v) => setDraft({ ...draft, lrclibEnabled: v })}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await config(draft);
                    setNotice("Đã lưu cấu hình không bí mật.");
                  })
                }
              >
                Lưu cấu hình
              </button>
            </Card>
            <Card title="Hiểu đúng loại trạng thái">
              <h3>Custom Status</h3>
              <p>
                Dòng văn bản / emoji cá nhân. Adapter legacy chỉ cập nhật trường
                custom_status, không thay đổi Online / Idle / DND / Invisible.
              </p>
              <h3>Online / Idle / DND / Invisible</h3>
              <p>
                Trạng thái hiện diện riêng. Ứng dụng không điều khiển các trạng
                thái này cho tài khoản cá nhân.
              </p>
              <h3>Activity / Rich Presence</h3>
              <p>
                Thông tin hoạt động riêng. Chế độ bot gửi Listening Activity cho
                bot và đặt bot online; không thay Custom Status của bạn.
              </p>
              <hr />
              <h3>Khôi phục và đóng ứng dụng</h3>
              <p>
                Tắt đồng bộ, chờ hàng đợi khôi phục xong rồi đóng server.
                Snapshot trạng thái gốc chỉ ở RAM; đóng cưỡng bức hoặc phiên hết
                hiệu lực có thể không khôi phục được. Không có bảo đảm khôi phục
                khi Ctrl+C.
              </p>
              <p className="muted">
                Cài đặt lưu phiên và nhập bí mật chỉ có trong tab Tài khoản tại
                server cục bộ. Khi khởi động lại, ứng dụng luôn bật chạy thử để
                tránh tự gửi ngoài ý muốn.
              </p>
              <button
                className="ghost"
                onClick={() =>
                  void act(async () => {
                    await api("/api/session", {}, "DELETE");
                    setSession(null);
                    setData(null);
                  })
                }
              >
                Đăng xuất dashboard
              </button>
            </Card>
          </div>
        )}
        <footer>
          Discord Lyrics Status • Cập nhật {when(d.now)} • Không đọc được trạng
          thái hiển thị thực tế trong Discord client.
        </footer>
      </main>
    </div>
  );
}
