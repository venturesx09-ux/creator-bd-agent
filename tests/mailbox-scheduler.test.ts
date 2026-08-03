import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailboxSyncScheduler } from "../src/mailbox-scheduler.js";
import type { MailboxServiceLike } from "../src/mailbox-service.js";

describe("MailboxSyncScheduler", () => {
  it("prevents overlapping sync runs", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const service = {
      syncAllEnabled: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { attempted: 1, succeeded: 1, failed: 0 };
      }
    } as MailboxServiceLike;
    const logger = { info: () => undefined, error: () => undefined };
    const scheduler = new MailboxSyncScheduler(service, 10, logger);
    const first = scheduler.run();
    await scheduler.run();
    assert.equal(calls, 1);
    release?.();
    await first;
  });
});
