const byId = (id) => document.getElementById(id);
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  byId("extensionId").value = s.extensionId;
  byId("origin").value = s.origin || "http://127.0.0.1:3210";
  byId("status").textContent =
    s.lastError ||
    (s.lastAt
      ? `Mẫu gần nhất: ${new Date(s.lastAt).toLocaleTimeString("vi-VN")}`
      : "Chưa nhận mẫu phát.");
}
byId("pair").addEventListener("click", async () => {
  const key = byId("key").value;
  byId("key").value = "";
  const r = await chrome.runtime.sendMessage({
    type: "configure",
    origin: byId("origin").value.trim(),
    key,
  });
  byId("status").textContent = r.error || "Đã ghép; đang chờ player phát nhạc.";
});
byId("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  byId("key").value = "";
  byId("status").textContent = "Đã ngắt bridge.";
});
refresh().catch(() => {
  byId("status").textContent = "Không đọc được trạng thái extension.";
});
