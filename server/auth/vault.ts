import { Secrets, AppError } from "../security.js";
interface EntryLike {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword(): void;
}
export class Vault {
  available = false;
  description = "Chỉ giữ bí mật trong RAM; chưa có kho hệ điều hành.";
  private memory = new Map<string, unknown>();
  private factory: ((key: string) => EntryLike) | null = null;
  constructor(public secrets: Secrets) {}
  async init() {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      this.factory = (key) =>
        new Entry("DiscordLyricsStatus", key, {
          linux: { store: "secret-service" },
        });
      const p = this.factory("availability-probe");
      p.setPassword("non-secret-probe");
      p.deletePassword();
      this.available = true;
      this.description =
        "Kho thông tin xác thực hệ điều hành (Secret Service / Keychain / Credential Manager).";
    } catch {
      this.factory = null;
      this.available = false;
      this.description =
        "Kho hệ điều hành không khả dụng; bí mật chỉ ở RAM, không lưu phiên.";
    }
  }
  assertPersistence(persist: boolean) {
    if (persist && !this.available)
      throw new AppError(
        "validation",
        "Không có kho thông tin xác thực hệ điều hành; bỏ chọn lưu phiên.",
      );
  }
  put<T>(key: string, value: T, persist = false) {
    this.assertPersistence(persist);
    this.secrets.register(value);
    if (persist) {
      try {
        this.factory!(key).setPassword(JSON.stringify(value));
      } catch {
        throw new AppError(
          "service",
          "Không lưu được phiên vào kho hệ điều hành.",
        );
      }
    }
    this.memory.set(key, value);
  }
  get<T>(key: string): T | null {
    if (this.memory.has(key)) return this.memory.get(key) as T;
    if (this.factory)
      try {
        const raw = this.factory(key).getPassword();
        if (raw) {
          const value = JSON.parse(raw);
          this.secrets.register(value);
          this.memory.set(key, value);
          return value as T;
        }
      } catch {}
    return null;
  }
  remove(key: string) {
    this.memory.delete(key);
    if (this.factory)
      try {
        this.factory(key).deletePassword();
      } catch {
        throw new AppError(
          "service",
          "Không xóa được phiên đã lưu trong kho hệ điều hành.",
        );
      }
  }
  clearMemory(key: string) {
    this.memory.delete(key);
  }
}
