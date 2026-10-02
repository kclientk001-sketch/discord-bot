import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configSchema, defaults, type Config, type Lyrics } from "../shared.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lyrics(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bindings(track TEXT PRIMARY KEY,lyrics TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,json TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
  }
  config(): Config {
    const r = this.db.prepare("SELECT json FROM config WHERE id=1").get() as
      { json: string } | undefined;
    try {
      return {
        ...configSchema.parse(r ? JSON.parse(r.json) : defaults),
        dryRun: true,
      };
    } catch {
      return { ...defaults };
    }
  }
  saveConfig(c: Config) {
    const checked = configSchema.parse(c);
    this.db
      .prepare("INSERT OR REPLACE INTO config VALUES(1,?)")
      .run(JSON.stringify(checked));
  }
  putLyrics(l: Lyrics) {
    this.db
      .prepare("INSERT OR REPLACE INTO lyrics VALUES(?,?)")
      .run(l.id, JSON.stringify(l));
  }
  getLyrics(id: string): Lyrics | null {
    const r = this.db.prepare("SELECT json FROM lyrics WHERE id=?").get(id) as
      { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  listLyrics(): Lyrics[] {
    return (
      this.db
        .prepare("SELECT json FROM lyrics ORDER BY rowid DESC LIMIT 100")
        .all() as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  bind(track: string, id: string | null) {
    if (id) {
      if (!this.getLyrics(id)) throw new Error("lyrics missing");
      this.db
        .prepare("INSERT OR REPLACE INTO bindings VALUES(?,?)")
        .run(track, id);
    } else this.db.prepare("DELETE FROM bindings WHERE track=?").run(track);
  }
  forTrack(id: string) {
    const r = this.db
      .prepare("SELECT lyrics FROM bindings WHERE track=?")
      .get(id) as { lyrics: string } | undefined;
    return r ? this.getLyrics(r.lyrics) : null;
  }
  cached<T>(key: string, now = Date.now()): T | null {
    const r = this.db
      .prepare("SELECT json FROM cache WHERE key=? AND expires>?")
      .get(key, now) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  cache(key: string, value: unknown, ttl = 86400000) {
    this.db.prepare("DELETE FROM cache WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)")
      .run(key, JSON.stringify(value), Date.now() + ttl);
  }
  close() {
    this.db.close();
  }
}
