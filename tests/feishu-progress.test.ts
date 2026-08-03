import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FeishuProgressTracker } from "../src/feishu-progress.js";

describe("FeishuProgressTracker", () => {
  it("reports index, matching, writeback and failure counters", () => {
    const tracker = new FeishuProgressTracker();
    tracker.beginBatch(3);
    tracker.indexLoading("loading");
    tracker.indexPage(500, 1_200);
    tracker.indexReady(1_200, "feishu");
    tracker.messageSucceeded(true);
    tracker.messageSucceeded(false);
    tracker.messageFailed();
    tracker.endBatch();

    const progress = tracker.snapshot();
    assert.equal(progress.status, "completed_with_errors");
    assert.deepEqual(progress.index, {
      status: "ready", source: "feishu", loaded: 1_200, total: 1_200
    });
    assert.deepEqual(progress.messages, {
      total: 3,
      processed: 3,
      matched: 1,
      unmatched: 1,
      writebackSucceeded: 1,
      failed: 1
    });
  });
});
