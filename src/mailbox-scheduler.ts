import type { MailboxServiceLike } from "./mailbox-service.js";

type Logger = Pick<Console, "info" | "error">;

export class MailboxSyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly service: MailboxServiceLike,
    private readonly intervalMinutes: number,
    private readonly logger: Logger = console
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.run(),
      this.intervalMinutes * 60 * 1_000
    );
    this.timer.unref();
    this.logger.info(JSON.stringify({
      event: "mailbox_scheduler_started",
      intervalMinutes: this.intervalMinutes
    }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<void> {
    if (this.running) {
      this.logger.info(JSON.stringify({ event: "mailbox_sync_skipped", reason: "already_running" }));
      return;
    }
    this.running = true;
    try {
      const result = await this.service.syncAllEnabled();
      this.logger.info(JSON.stringify({ event: "mailbox_sync_completed", ...result }));
    } catch {
      this.logger.error(JSON.stringify({ event: "mailbox_sync_failed", message: "Internal error" }));
    } finally {
      this.running = false;
    }
  }
}
