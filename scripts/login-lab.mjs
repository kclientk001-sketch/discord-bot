// Runs the compiled Express/React app with a closed, memory-only Discord stub.
// This file is never loaded by npm start; no remote fetch or OS vault is used.
import { createServer } from "node:http";
import { Store } from "../dist/server/store.js";
import { Secrets } from "../dist/server/security.js";
import { Vault } from "../dist/server/auth/vault.js";
import { OAuth } from "../dist/server/auth/oauth.js";
import { Engine } from "../dist/server/engine.js";
import { createApp } from "../dist/server/app.js";
const reply = (data, status = 200) => Response.json(data, { status });
const fixtureToken = "FAKE_LOCAL_LAB_TOKEN_NOT_REAL", ticket = "FAKE_LOCAL_LAB_TICKET";
const stub = async (url, init = {}) => {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  if (url === "https://discord.com/api/v10/auth/login") {
    if (body.login !== "fixture@example.invalid" || body.password !== "FAKE_LAB_PASSWORD")
      return reply({ message: "Fixture credentials rejected" }, 400);
    return reply({ mfa: true, totp: true, ticket, login_instance_id: "FAKE_LOCAL_INSTANCE" });
  }
  if (url === "https://discord.com/api/v10/auth/mfa/totp")
    return body.ticket === ticket && body.code === "012345"
      ? reply({ token: fixtureToken }) : reply({ code: 60008 }, 400);
  if (url === "https://discord.com/api/v10/users/@me")
    return new Headers(init.headers).get("Authorization") === fixtureToken
      ? reply({ id: "888877776666555544", username: "du_lieu_mau", global_name: "Tài khoản mẫu cục bộ", bot: false })
      : reply({}, 401);
  // Deliberately deny all status writes/provider calls. No fallback to fetch.
  return reply({}, 404);
};
const port = Number(process.env.LOGIN_LAB_PORT ?? 3211);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("LOGIN_LAB_PORT không hợp lệ.");
const server = createServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const store = new Store(":memory:"), vault = new Vault(new Secrets());
const oauth = new OAuth(vault, origin, stub), engine = new Engine(store, vault, oauth, stub);
server.on("request", createApp(engine, { origin, localOnly: true, fixture: true }));
await engine.start(false);
console.log(`Phòng thử đăng nhập cục bộ (chỉ dữ liệu giả): ${origin}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await engine.close(); server.closeAllConnections(); server.close(() => process.exit(0));
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
