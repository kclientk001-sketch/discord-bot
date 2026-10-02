import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Secrets } from "./security.js";
import { Vault } from "./auth/vault.js";
import { OAuth } from "./auth/oauth.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
const host = process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 3210),
  origin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const localOnly = ["127.0.0.1", "::1", "localhost"].includes(host);
const parsed = new URL(origin);
const password = process.env.DASHBOARD_PASSWORD ?? "";
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  parsed.origin !== origin ||
  !["http:", "https:"].includes(parsed.protocol) ||
  parsed.username ||
  parsed.password
)
  throw new Error("PORT hoặc PUBLIC_ORIGIN không hợp lệ.");
if (
  !localOnly &&
  (password.length < 12 ||
    parsed.protocol !== "https:" ||
    !process.env.TLS_CERT_FILE ||
    !process.env.TLS_KEY_FILE)
)
  throw new Error(
    "Truy cập LAN cần mật khẩu >=12 ký tự và TLS_CERT_FILE/TLS_KEY_FILE với PUBLIC_ORIGIN HTTPS.",
  );
const vault = new Vault(new Secrets());
await vault.init();
const store = new Store(resolve(process.env.DATA_DIR ?? "data", "app.sqlite"));
const oauth = new OAuth(vault, origin);
const engine = new Engine(store, vault, oauth);
const app = createApp(engine, { origin, password, localOnly });
const server =
  parsed.protocol === "https:"
    ? https(
        {
          cert: readFileSync(process.env.TLS_CERT_FILE!),
          key: readFileSync(process.env.TLS_KEY_FILE!),
        },
        app,
      )
    : http(app);
server.listen(port, host, () =>
  console.log(`Discord Lyrics Status: ${origin}`),
);
await engine.start(process.env.RESTORE_SAVED_SESSIONS !== "0");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await engine.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
