import { z } from "zod";
export const configSchema = z
  .object({
    musicSource: z.enum(["manual", "spotify", "youtube-music"]),
    output: z.enum(["preview", "custom-status", "bot-activity"]),
    dryRun: z.boolean(),
    offsetMs: z.number().int().min(-60000).max(60000),
    plainIntervalMs: z.number().int().min(1000).max(300000),
    minUpdateMs: z.number().int().min(15000).max(300000),
    spotifyPollMs: z.number().int().min(5000).max(60000),
    fallback: z.string().max(512),
    restoreOnStop: z.boolean(),
    lrclibEnabled: z.boolean(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const defaults: Config = {
  musicSource: "manual",
  output: "preview",
  dryRun: true,
  offsetMs: 0,
  plainIntervalMs: 6000,
  minUpdateMs: 15000,
  spotifyPollMs: 5000,
  fallback: "{title} — {artist}",
  restoreOnStop: true,
  lrclibEnabled: false,
};
export type MusicSource = Config["musicSource"];
export type DiscordMode = "user-token" | "oauth2" | "bot";
export interface DiscordLoginState {
  stage: "idle" | "authenticating" | "mfa-required" | "verifying" | "connected" | "verification-required" | "error";
  challengeId: string | null;
  expiresAt: number | null;
  attemptsRemaining: number | null;
  retryAt: number | null;
  lastError: string | null;
}
export interface Track {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  url?: string;
}
export interface Playback {
  source: MusicSource;
  track: Track | null;
  positionMs: number;
  playing: boolean;
  observedAt: number;
  rate: number;
  stale: boolean;
}
export interface Lyrics {
  id: string;
  title: string;
  artist: string;
  durationMs: number | null;
  kind: "lrc" | "txt";
  source: "file" | "lrclib";
  lines: { atMs: number | null; text: string }[];
  offsetMs: number;
  importedAt: number;
}
export interface AccountState {
  mode: DiscordMode | null;
  authenticationMethod?: "password" | "token" | "oauth2";
  connection:
    | "disconnected"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "expired"
    | "verification-required"
    | "error";
  identity: {
    id: string;
    name: string;
    username: string;
    avatar: string | null;
    kind: "personal" | "bot";
  } | null;
  connectedAt: number | null;
  lastError: string | null;
  retryAt: number | null;
  customStatusSupported: boolean;
  savedSession: boolean;
  originalStatusKnown: boolean;
}
export interface Submission {
  text: string;
  at: number;
  result: "settings-confirmed" | "gateway-submitted";
  target: Config["output"];
}
export interface QueueState {
  pending: string | null;
  inFlight: string | null;
  waitUntil: number | null;
  lastSubmitted: Submission | null;
  lastConfirmed: Submission | null;
  lastError: string | null;
}
export interface Dashboard {
  now: number;
  startedAt: number;
  config: Config;
  account: AccountState;
  playback: Playback;
  lyrics: Lyrics | null;
  selectedLine: number | null;
  preview: string;
  timelinePositionMs: number;
  sync: {
    enabled: boolean;
    state: "stopped" | "running" | "paused" | "waiting" | "error";
    reason: string;
    queue: QueueState;
  };
  sources: {
    spotify: {
      active: boolean;
      lastError: string | null;
      retryAt: number | null;
    };
    youtube: { lastSeen: number | null; lastError: string | null };
  };
  events: { at: number; message: string }[];
  vault: { available: boolean; description: string };
}
