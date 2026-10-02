chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let busy = false,
  lastSent = 0,
  waitUntil = 0;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    const popup = sender.url === chrome.runtime.getURL("popup.html");
    if (message.type === "status" && popup) {
      const state = await chrome.storage.session.get([
        "origin",
        "activeTab",
        "lastAt",
        "lastError",
      ]);
      return { extensionId: chrome.runtime.id, ...state };
    }
    if (message.type === "configure" && popup) {
      const u = new URL(message.origin);
      if (
        u.protocol !== "http:" ||
        u.hostname !== "127.0.0.1" ||
        u.username ||
        u.password ||
        u.origin !== message.origin ||
        !/^[A-Za-z0-9_-]{43}$/.test(message.key)
      )
        throw new Error("Địa chỉ hoặc khóa bridge không hợp lệ.");
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id || !tab.url?.startsWith("https://music.youtube.com/"))
        throw new Error("Hãy mở tab YouTube Music rồi ghép bridge.");
      await chrome.storage.session.set({
        origin: u.origin,
        key: message.key,
        activeTab: tab.id,
        lastError: null,
      });
      return { ok: true };
    }
    if (message.type === "disconnect" && popup) {
      await chrome.storage.session.clear();
      return { ok: true };
    }
    if (
      message.type !== "playback" ||
      !sender.tab?.id ||
      !sender.url?.startsWith("https://music.youtube.com/")
    )
      return { ignored: true };
    const s = await chrome.storage.session.get(["origin", "key", "activeTab"]);
    if (
      !s.key ||
      s.activeTab !== sender.tab.id ||
      busy ||
      Date.now() - lastSent < 300 ||
      Date.now() < waitUntil
    )
      return { ignored: true };
    busy = true;
    lastSent = Date.now();
    try {
      const r = await fetch(`${s.origin}/api/bridge/playback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.key}`,
        },
        body: JSON.stringify({ ...message.payload, tabId: sender.tab.id }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 429) {
        waitUntil =
          Date.now() +
          Math.max(1000, Number(r.headers.get("Retry-After") || 1) * 1000);
        throw new Error("Bridge đang giới hạn tốc độ.");
      }
      if (r.status === 401 || r.status === 403) {
        await chrome.storage.session.remove("key");
        throw new Error("Ghép bridge đã hết hiệu lực; tạo khóa mới.");
      }
      if (!r.ok) throw new Error("Dashboard không nhận mẫu phát.");
      await chrome.storage.session.set({ lastAt: Date.now(), lastError: null });
      return { ok: true };
    } finally {
      busy = false;
    }
  })()
    .then(respond)
    .catch(async (e) => {
      const message =
        e instanceof Error &&
        /^(Địa chỉ|Hãy mở|Bridge|Ghép bridge|Dashboard)/.test(e.message)
          ? e.message
          : "Không kết nối được dashboard cục bộ.";
      await chrome.storage.session.set({ lastError: message });
      respond({ error: message });
    });
  return true;
});
