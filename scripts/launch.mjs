import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export function supportedNode(version) {
  const match = /^v?24\.(\d+)\.\d+$/.exec(version);
  return !!match && Number(match[1]) >= 15;
}

export function requirements(root, version = process.versions.node) {
  const require = createRequire(join(root, "package.json"));
  const missing = ["express", "discord.js", "zod"].filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  const built =
    existsSync(join(root, "dist/server/index.js")) &&
    existsSync(join(root, "dist/web/index.html"));
  const missingBuild = ["typescript", "vite", "@vitejs/plugin-react"].filter(
    (name) => {
      try {
        require.resolve(name);
        return false;
      } catch {
        return true;
      }
    },
  );
  return {
    node: version,
    nodeSupported: supportedNode(version),
    hasLockfile: existsSync(join(root, "package-lock.json")),
    missing,
    missingBuild,
    built,
    ready: supportedNode(version) && missing.length === 0 && built,
  };
}

function runNpm(args, root) {
  return new Promise((resolvePromise, reject) => {
    const options = { cwd: root, stdio: "inherit" };
    // These arguments are fixed by this file, never taken from credentials or UI.
    const child =
      process.platform === "win32"
        ? spawn(
            process.env.ComSpec || "cmd.exe",
            ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`],
            options,
          )
        : spawn("npm", args, options);
    child.once("error", () =>
      reject(
        new Error("Không chạy được npm. Cài Node.js 24 kèm npm rồi thử lại."),
      ),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(
              "npm chưa hoàn tất. Kiểm tra kết nối mạng và thông báo cài/build phía trên.",
            ),
          ),
    );
  });
}

export async function launch(root, checkOnly = false) {
  const state = requirements(root);
  if (!state.nodeSupported) {
    console.error(
      "Ứng dụng cần Node.js 24 LTS từ 24.15.0. Hãy cài Node 24 rồi mở lại terminal.",
    );
    return 1;
  }
  if (checkOnly) {
    console.log(JSON.stringify(state, null, 2));
    return state.ready ? 0 : 2;
  }
  if (state.missing.length || (!state.built && state.missingBuild.length)) {
    if (!state.hasLockfile) {
      console.error(
        "Thiếu package-lock.json; hãy giải nén lại gói mã nguồn đầy đủ.",
      );
      return 1;
    }
    console.log("Lần đầu chạy: cài dependency đúng theo lockfile bằng npm ci…");
    await runNpm(["ci", "--include=dev", "--no-audit", "--no-fund"], root);
  }
  if (!state.built) {
    console.log("Chưa có bản build; đang build server và giao diện…");
    await runNpm(["run", "build"], root);
  }
  console.log(
    "Đang khởi chạy. Mở địa chỉ server in bên dưới trong trình duyệt.",
  );
  console.log("Trước khi đóng: tắt đồng bộ và chờ yêu cầu khôi phục hoàn tất.");
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "dist/server/index.js"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  const forward = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Không khởi chạy được server."));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check")) {
      console.error(
        "Chỉ hỗ trợ tùy chọn --check; không nhận token hoặc cookie qua dòng lệnh.",
      );
      process.exitCode = 1;
    } else {
      process.exitCode = await launch(root, args.includes("--check"));
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Không khởi chạy được ứng dụng.",
    );
    process.exitCode = 1;
  }
}
