import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxRepository, MatchStatus } from "../src/database.js";
import {
  baseFieldsForMessage,
  buildCreatorEmailIndex,
  FeishuCreatorMatcher
} from "../src/feishu-creator-matcher.js";
import type { FeishuClient } from "../src/feishu-client.js";
import type { MessageSummary } from "../src/mailbox-service.js";

describe("Feishu creator matching", () => {
  it("extracts email addresses from nested Base fields", () => {
    const index = buildCreatorEmailIndex([{
      record_id: "rec_1",
      fields: {
        Email: [{ text: "Creator@Example.com" }],
        note: { a: { b: { c: { d: { e: { value: "backup: other@example.com" } } } } } }
      }
    }]);
    assert.equal(index.get("creator@example.com"), "rec_1");
    assert.equal(index.get("other@example.com"), "rec_1");
  });

  it("stores matched and unmatched results", async () => {
    const updates: Array<{ id: string; status: MatchStatus; recordId?: string }> = [];
    const baseUpdates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
    const repository = {
      updateMessageMatch: async (id: string, status: MatchStatus, recordId?: string) => {
        updates.push({ id, status, ...(recordId ? { recordId } : {}) });
      }
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_creator", fields: { Email: "creator@example.com" }
      }],
      updateBaseRecord: async (recordId: string, fields: Record<string, unknown>) => {
        baseUpdates.push({ recordId, fields });
      }
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
    assert.deepEqual(baseUpdates, [{
      recordId: "rec_creator",
      fields: {
        "邮件同步状态": "已同步",
        "邮件分类": "达人回复",
        "合作阶段": "已回复"
      }
    }]);
  });

  it("does not downgrade an advanced cooperation stage", () => {
    const fields = baseFieldsForMessage({
      id: "msg", uid: 1, subject: "Re", from: [],
      fromAddresses: ["creator@example.com"], to: [], messageId: "m",
      references: [], textPreview: "", classification: "creator_reply",
      matchStatus: "pending", receivedAt: "2026-08-04T12:00:00.000Z"
    }, {
      record_id: "rec",
      fields: { "合作阶段": "议价中" }
    });
    assert.equal("合作阶段" in fields, false);
    assert.equal(fields["最近发件邮箱"], "creator@example.com");
    assert.equal(fields["最后联系时间"], Date.parse("2026-08-04T12:00:00.000Z"));
  });
});
