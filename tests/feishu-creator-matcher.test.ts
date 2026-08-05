import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxRepository, MatchStatus } from "../src/database.js";
import {
  baseFieldsForMessage,
  buildCreatorEmailIndex,
  extractHistoricalCreatorIds,
  extractSubjectCreatorIds,
  FeishuCreatorMatcher,
  replyAggregateFields,
  replyDetailLine
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
      loadFeishuEmailIndex: async () => ({ entries: [] }),
      replaceFeishuEmailIndex: async () => undefined,
      loadFeishuCreatorIdIndex: async () => [],
      replaceFeishuCreatorIdIndex: async () => undefined,
      updateFeishuIndexRecord: async () => undefined,
      updateMessageMatch: async (id: string, status: MatchStatus, recordId?: string) => {
        updates.push({ id, status, ...(recordId ? { recordId } : {}) });
      },
      getUnmatchedRecordId: async () => undefined,
      setUnmatchedRecordId: async () => undefined
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_creator", fields: { Email: "creator@example.com" }
      }],
      updateBaseRecord: async (recordId: string, fields: Record<string, unknown>) => {
        baseUpdates.push({ recordId, fields });
      },
      isUnmatchedTableConfigured: () => false
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

  it("extracts the original outreach creator ID from quoted history", () => {
    assert.deepEqual(
      extractHistoricalCreatorIds(
        "Hi Shark, thanks!\n\n> Hi @creator_handle,\n> Hope you're doing well."
      ),
      ["shark", "creator_handle"]
    );
  });

  it("extracts @creator IDs from the subject without treating email domains as IDs", () => {
    assert.deepEqual(
      extractSubjectCreatorIds(
        "Re: Paid partnership with @Creator.Handle — creator@example.com"
      ),
      ["creator.handle"]
    );
  });

  it("falls back to the subject @creator ID before historical content", async () => {
    const updates: Array<{ status: MatchStatus; recordId?: string; reason?: string }> = [];
    const baseUpdates: Array<Record<string, unknown>> = [];
    const repository = {
      loadFeishuEmailIndex: async () => ({ entries: [] }),
      replaceFeishuEmailIndex: async () => undefined,
      loadFeishuCreatorIdIndex: async () => [],
      replaceFeishuCreatorIdIndex: async () => undefined,
      updateFeishuIndexRecord: async () => undefined,
      updateMessageMatch: async (
        _id: string,
        status: MatchStatus,
        recordId?: string,
        reason?: string
      ) => updates.push({ status, ...(recordId ? { recordId } : {}), ...(reason ? { reason } : {}) }),
      getUnmatchedRecordId: async () => undefined,
      setUnmatchedRecordId: async () => undefined
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_subject",
        fields: { "达人ID": "creator_handle", "达人邮箱": "old@example.com" }
      }],
      updateBaseRecord: async (_recordId: string, fields: Record<string, unknown>) => {
        baseUpdates.push(fields);
      },
      isUnmatchedTableConfigured: () => false
    } as unknown as FeishuClient;

    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages([{
      id: "subject-message", uid: 9,
      subject: "Re: Paid Creator Partnership with @creator_handle",
      from: [], fromAddresses: ["new-manager@agency.com"], to: [],
      messageId: "m9", references: [], textPreview: "Thanks for reaching out.",
      classification: "creator_reply", matchStatus: "pending",
      receivedAt: "2026-08-04T12:00:00.000Z"
    }]);

    assert.deepEqual(updates, [{
      status: "matched", recordId: "rec_subject", reason: "subject_creator_id"
    }]);
    assert.equal(baseUpdates[0]?.["最近发件邮箱"], "new-manager@agency.com");
  });

  it("does not match automatic replies even when the subject contains @creator ID", async () => {
    const updates: unknown[] = [];
    const baseUpdates: unknown[] = [];
    const repository = {
      updateMessageMatch: async (...args: unknown[]) => { updates.push(args); }
    } as unknown as MailboxRepository;
    const feishuClient = {
      updateBaseRecord: async (...args: unknown[]) => { baseUpdates.push(args); }
    } as unknown as FeishuClient;

    const message: MessageSummary = {
      id: "automatic-message", uid: 10,
      subject: "Automatic reply: Paid Partnership with @creator_handle",
      from: [], fromAddresses: ["auto@example.com"], to: [],
      messageId: "m10", references: [], textPreview: "Out of office",
      classification: "automatic_reply", matchStatus: "pending"
    };

    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages([message]);

    assert.deepEqual(updates, []);
    assert.deepEqual(baseUpdates, []);
    assert.equal(message.matchStatus, "pending");
  });

  it("falls back to a unique historical creator ID and records the new sender", async () => {
    const updates: Array<{ status: MatchStatus; recordId?: string; reason?: string }> = [];
    const baseUpdates: Array<Record<string, unknown>> = [];
    const repository = {
      loadFeishuEmailIndex: async () => ({ entries: [] }),
      replaceFeishuEmailIndex: async () => undefined,
      loadFeishuCreatorIdIndex: async () => [],
      replaceFeishuCreatorIdIndex: async () => undefined,
      updateFeishuIndexRecord: async () => undefined,
      updateMessageMatch: async (
        _id: string,
        status: MatchStatus,
        recordId?: string,
        reason?: string
      ) => updates.push({ status, ...(recordId ? { recordId } : {}), ...(reason ? { reason } : {}) }),
      getUnmatchedRecordId: async () => undefined,
      setUnmatchedRecordId: async () => undefined
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_history",
        fields: { "达人ID": "creator_handle", "达人邮箱": "old@example.com" }
      }],
      updateBaseRecord: async (_recordId: string, fields: Record<string, unknown>) => {
        baseUpdates.push(fields);
      },
      isUnmatchedTableConfigured: () => false
    } as unknown as FeishuClient;
    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages([{
      id: "history-message", uid: 2, subject: "Re", from: [],
      fromAddresses: ["manager@agency.com"], to: [], messageId: "m2",
      references: [],
      textPreview: "Hi Shark,\nThanks.\n\n> Hi creator_handle,\n> Hope you're well.",
      classification: "creator_reply", matchStatus: "pending",
      receivedAt: "2026-08-04T12:00:00.000Z"
    }]);
    assert.deepEqual(updates, [{
      status: "matched", recordId: "rec_history", reason: "history_creator_id"
    }]);
    assert.equal(baseUpdates[0]?.["最近发件邮箱"], "manager@agency.com");
  });

  it("creates one unmatched queue row and stores its Feishu record ID", async () => {
    let storedQueueId: string | undefined;
    let createdFields: Record<string, unknown> | undefined;
    const repository = {
      loadFeishuEmailIndex: async () => ({ entries: [] }),
      replaceFeishuEmailIndex: async () => undefined,
      loadFeishuCreatorIdIndex: async () => [],
      replaceFeishuCreatorIdIndex: async () => undefined,
      updateMessageMatch: async () => undefined,
      getUnmatchedRecordId: async () => undefined,
      setUnmatchedRecordId: async (_messageId: string, recordId: string) => {
        storedQueueId = recordId;
      }
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [],
      isUnmatchedTableConfigured: () => true,
      createUnmatchedRecord: async (fields: Record<string, unknown>) => {
        createdFields = fields;
        return "rec_queue";
      }
    } as unknown as FeishuClient;

    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages([{
      id: "unmatched-message", uid: 3, subject: "Re: campaign",
      from: ["Agent <agent@example.com>"],
      fromAddresses: ["agent@example.com"], to: [], messageId: "m3",
      references: [], textPreview: "Thanks for reaching out.",
      classification: "creator_reply", matchStatus: "pending",
      receivedAt: "2026-08-04T12:00:00.000Z",
      mailboxEmail: "bd@example.com", project: "Tripo"
    }]);

    assert.equal(storedQueueId, "rec_queue");
    assert.equal(createdFields?.["待匹配邮件ID"], "unmatched-message");
    assert.equal(createdFields?.["处理状态"], "待处理");
    assert.equal(createdFields?.["未匹配原因"], "标题和历史邮件中未找到达人ID");
    assert.equal(createdFields?.["收件邮箱"], "bd@example.com");
    assert.equal(createdFields?.["项目"], "Tripo");
  });

  it("marks an existing unmatched queue row resolved after matching", async () => {
    let resolvedFields: Record<string, unknown> | undefined;
    const repository = {
      loadFeishuEmailIndex: async () => ({ entries: [] }),
      replaceFeishuEmailIndex: async () => undefined,
      loadFeishuCreatorIdIndex: async () => [],
      replaceFeishuCreatorIdIndex: async () => undefined,
      updateFeishuIndexRecord: async () => undefined,
      updateMessageMatch: async () => undefined,
      getUnmatchedRecordId: async () => "rec_queue",
      setUnmatchedRecordId: async () => undefined
    } as unknown as MailboxRepository;
    const feishuClient = {
      listAllBaseRecords: async () => [{
        record_id: "rec_creator", fields: { "达人邮箱": "creator@example.com" }
      }],
      updateBaseRecord: async () => undefined,
      isUnmatchedTableConfigured: () => true,
      updateUnmatchedRecord: async (
        _recordId: string,
        fields: Record<string, unknown>
      ) => { resolvedFields = fields; }
    } as unknown as FeishuClient;

    await new FeishuCreatorMatcher(feishuClient, repository).matchMessages([{
      id: "resolved-message", uid: 4, subject: "Re", from: [],
      fromAddresses: ["creator@example.com"], to: [], messageId: "m4",
      references: [], textPreview: "", classification: "creator_reply",
      matchStatus: "pending"
    }]);

    assert.equal(resolvedFields?.["处理状态"], "已匹配");
    assert.equal(resolvedFields?.["最终匹配记录ID"], "rec_creator");
    assert.equal(typeof resolvedFields?.["解决时间"], "number");
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

  it("formats exact reply counts and real received times for the same Base row", () => {
    const first = new Date("2026-08-01T06:32:00.000Z");
    const latest = new Date("2026-08-03T01:15:00.000Z");
    const line = replyDetailLine({
      id: "msg-detail", uid: 1, subject: "Re: Collaboration",
      from: [], fromAddresses: ["creator@example.com"], to: [],
      messageId: "mail-detail", references: [], textPreview: "",
      classification: "creator_reply", matchStatus: "matched",
      receivedAt: first.toISOString()
    });
    const fields = replyAggregateFields({
      count: 2,
      firstReceivedAt: first,
      latestReceivedAt: latest,
      detailLines: [line, "2026-08-03 09:15（北京时间）｜creator@example.com｜Re: Collaboration"]
    });
    assert.equal(fields["累计回复邮件数"], 2);
    assert.equal(fields["首次回复时间"], first.getTime());
    assert.equal(fields["最近回复时间"], latest.getTime());
    assert.match(String(fields["回复邮件明细"]), /2026-08-01 14:32（北京时间）/u);
  });
});
