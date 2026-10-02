import type { Config, QueueState } from "../../shared.js";
import type { SendResult } from "../discord/service.js";
import { safeError } from "../security.js";
export interface Job {
  text: string;
  output: Config["output"];
  restore?: boolean;
}
export class LatestQueue {
  private pending: Job | null = null;
  private active: Promise<void> | null = null;
  private lastKey = "";
  private lastAt = -Infinity;
  private notBefore = 0;
  private generation = 0;
  state: QueueState = {
    pending: null,
    inFlight: null,
    waitUntil: null,
    lastSubmitted: null,
    lastConfirmed: null,
    lastError: null,
  };
  constructor(
    private sender: (job: Job) => Promise<SendResult>,
    private interval: () => number,
    private terminal: (e: unknown) => void = () => {},
    private clock = Date.now,
  ) {}
  offer(job: Job) {
    const key = JSON.stringify(job);
    if (!this.active && key === this.lastKey) {
      this.pending = null;
      this.state.pending = null;
      this.state.waitUntil = null;
      return;
    }
    this.pending = job;
    this.state.pending = job.text;
    this.state.waitUntil = Math.max(
      this.notBefore,
      this.lastAt + this.interval(),
      this.clock(),
    );
  }
  clear(reset = false) {
    this.generation++;
    this.pending = null;
    this.state.pending = null;
    this.state.waitUntil = null;
    if (reset) {
      this.lastKey = "";
      this.state.lastError = null;
    }
  }
  resetTarget() {
    this.clear(true);
    this.state.lastSubmitted = null;
    this.state.lastConfirmed = null;
  }
  async flush() {
    if (this.active || !this.pending) return;
    const now = this.clock();
    const wait = Math.max(this.notBefore, this.lastAt + this.interval());
    if (now < wait) {
      this.state.waitUntil = wait;
      return;
    }
    const job = this.pending,
      gen = this.generation;
    this.pending = null;
    this.state.pending = null;
    this.state.inFlight = job.text;
    this.lastAt = now;
    this.active = (async () => {
      try {
        const result = await this.sender(job);
        this.lastKey = JSON.stringify(job);
        this.notBefore = this.clock() + result.rateWaitMs;
        this.state.lastSubmitted = result.submission;
        if (result.submission.result === "settings-confirmed")
          this.state.lastConfirmed = result.submission;
        this.state.lastError = null;
      } catch (raw) {
        const e = safeError(raw);
        this.state.lastError = e.message;
        if (["network", "rate-limit"].includes(e.kind)) {
          this.notBefore = this.clock() + Math.max(1000, e.retryMs);
          if (gen === this.generation && !this.pending) {
            this.pending = job;
            this.state.pending = job.text;
          }
        } else {
          this.pending = null;
          this.state.pending = null;
          this.terminal(e);
        }
      } finally {
        this.state.inFlight = null;
        this.active = null;
        this.state.waitUntil = this.pending
          ? Math.max(this.notBefore, this.lastAt + this.interval())
          : null;
      }
    })();
    await this.active;
  }
  async settle() {
    await this.active;
  }
}
