import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxRepository, MatchStatus } from "../src/database.js";
import { buildCreatorEmailIndex, FeishuCreatorMatcher } from "../src/feishu-creator-matcher.js";
import type { FeishuClient } from "../src/feishu-client.js";
import type { MessageSummary } from "../src/mailbox-service.js";

describe("Feishu creator matching", () => {
  it("extracts email addresses from nested Base fields", () => {
    const index = buildCreatorEmailIndex([{
      record_id: "rec_1",
      fields: { Email: [{ text: "Creator@Example.com" }], note: "backup: other@example.com" }
    }]);
    assert.equal(index.get("creator@example.com"), "rec_1");
    assert.equal(index.get("other@example.com"), "rec_1");
  });

  it("stores matched and unmatched results", async () => {
    const updates: Array<{ id: string; status: MatchStatus; recordId?: string }> = [];
    const repository = {
      updateMessageMatch: async (id: string, status: MatchStatus, recordId?: string) => {
        updates.push({ id, status, ...(recordId ? { recordId } : {}) });
      }
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_creator", fields: { Email: "creator@example.com" }
      }]
    } as unknown as FeishuClient;
    const base = {
      uid: 1, subject: "Re", from: [], to: [], messageId: "m",
      references: [], textPreview: "", classification: "creator_reply" as const,
      matchStatus: "pending" as const
    };
    const messages: MessageSummary[] = [
      { ...base, id: "msg_1", fromAddresses: ["CREATOR@example.com"] },
      { ...base, id: "msg_2", fromAddresses: ["unknown@example.com"] }
    ];
    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages(messages);
    assert.deepEqual(updates, [
      { id: "msg_1", status: "matched", recordId: "rec_creator" },
      { id: "msg_2", status: "unmatched" }
    ]);
  });
});
