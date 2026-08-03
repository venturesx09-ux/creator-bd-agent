import { createHash } from "node:crypto";
import type {
  FeishuEmailIndexEntry,
  MailboxRepository
} from "./database.js";
import { FeishuClient, type FeishuBaseRecord } from "./feishu-client.js";
import { FeishuProgressTracker } from "./feishu-progress.js";
import type { CreatorMatcher, MessageSummary } from "./mailbox-service.js";

const EMAIL_PATTERN_SOURCE = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,63}";
const INDEX_FRESHNESS_MS = 30 * 60_000;

function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function buildCreatorEmailIndex(
  records: FeishuBaseRecord[]
): Map<string, string> {
  return new Map(
    [...buildCreatorRecordIndex(records)].map(([email, record]) => [
      email,
      record.record_id
    ])
  );
}

function buildCreatorRecordIndex(
  records: FeishuBaseRecord[]
): Map<string, FeishuBaseRecord> {
  const recordIndex = new Map<string, FeishuBaseRecord>();
  for (const record of records) {
    const serializedFields = JSON.stringify(record.fields);
    const emails = serializedFields.match(
      new RegExp(EMAIL_PATTERN_SOURCE, "giu")
    ) ?? [];
    for (const email of new Set(emails.map((value) => value.toLowerCase()))) {
      if (!recordIndex.has(email)) recordIndex.set(email, record);
    }
  }
  return recordIndex;
}

function persistentEntries(records: FeishuBaseRecord[]): FeishuEmailIndexEntry[] {
  return [...buildCreatorRecordIndex(records)].map(([email, record]) => {
    const lastContactAt = currentTimestamp(record.fields["最后联系时间"]);
    return {
      emailHash: emailHash(email),
      recordId: record.record_id,
      cooperationStage: currentStage(record.fields),
      ...(lastContactAt !== undefined ? { lastContactAt } : {})
    };
  });
}

function indexFromPersistentEntries(
  entries: FeishuEmailIndexEntry[]
): Map<string, FeishuBaseRecord> {
  return new Map(entries.map((entry) => [
    entry.emailHash,
    {
      record_id: entry.recordId,
      fields: {
        "合作阶段": entry.cooperationStage,
        ...(entry.lastContactAt !== undefined
          ? { "最后联系时间": entry.lastContactAt }
          : {})
      }
    }
  ]));
}

const PRE_REPLY_STAGES = new Set(["", "待触达", "已触达"]);

function classificationLabel(value: MessageSummary["classification"]): string {
  return {
    creator_reply: "达人回复",
    automatic_reply: "自动回复",
    delivery_failure: "退信",
    bulk_notification: "批量通知",
    unknown: "未知"
  }[value];
}

function currentStage(fields: Record<string, unknown>): string {
  const value = fields["合作阶段"];
  return typeof value === "string" ? value.trim() : "";
}

function currentTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function baseFieldsForMessage(
  message: MessageSummary,
  record: FeishuBaseRecord
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "邮件同步状态": "已同步",
    "邮件分类": classificationLabel(message.classification)
  };
  const receivedAt = message.receivedAt
    ? Date.parse(message.receivedAt)
    : Number.NaN;
  const storedTimestamp = currentTimestamp(record.fields["最后联系时间"]);
  if (
    Number.isFinite(receivedAt) &&
    (storedTimestamp === undefined || receivedAt >= storedTimestamp)
  ) {
    fields["最后联系时间"] = receivedAt;
    fields["最近发件邮箱"] = message.fromAddresses[0] ?? "";
  }
  if (
    message.classification === "creator_reply" &&
    PRE_REPLY_STAGES.has(currentStage(record.fields))
  ) {
    fields["合作阶段"] = "已回复";
  }
  return fields;
}

export class FeishuCreatorMatcher implements CreatorMatcher {
  private cachedIndex:
    | { value: Map<string, FeishuBaseRecord>; expiresAt: number }
    | undefined;
  private indexRequest: Promise<Map<string, FeishuBaseRecord>> | undefined;

  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly repository: MailboxRepository,
    private readonly progress = new FeishuProgressTracker()
  ) {}

  async matchMessages(messages: MessageSummary[]): Promise<void> {
    this.progress.beginBatch(messages.length);
    let index: Map<string, FeishuBaseRecord>;
    try {
      index = await this.getEmailIndex();
    } catch (error) {
      this.progress.indexFailed();
      this.progress.failBatch("飞书索引加载失败");
      throw error;
    }
    const orderedMessages = [...messages].sort((left, right) =>
      Date.parse(left.receivedAt ?? "") - Date.parse(right.receivedAt ?? "")
    );
    for (const message of orderedMessages) {
      try {
        const matchedRecord = message.fromAddresses
          .map((email) => index.get(emailHash(email)))
          .find(Boolean);
        if (matchedRecord) {
          const fields = baseFieldsForMessage(message, matchedRecord);
          await this.feishuClient.updateBaseRecord(
            matchedRecord.record_id,
            fields
          );
          Object.assign(matchedRecord.fields, fields);
          await this.repository.updateFeishuIndexRecord(
            matchedRecord.record_id,
            currentStage(matchedRecord.fields),
            currentTimestamp(matchedRecord.fields["最后联系时间"])
          );
          await this.repository.updateMessageMatch(
            message.id,
            "matched",
            matchedRecord.record_id
          );
          message.matchStatus = "matched";
          message.matchedRecordId = matchedRecord.record_id;
          this.progress.messageSucceeded(true);
        } else {
          await this.repository.updateMessageMatch(message.id, "unmatched");
          message.matchStatus = "unmatched";
          this.progress.messageSucceeded(false);
        }
      } catch (error) {
        this.progress.messageFailed();
        console.error(JSON.stringify({
          event: "feishu_message_writeback_failed",
          messageId: message.id,
          message: error instanceof Error ? error.message : "Internal error"
        }));
      }
    }
    this.progress.endBatch();
  }

  private async getEmailIndex(): Promise<Map<string, FeishuBaseRecord>> {
    const now = Date.now();
    if (this.cachedIndex && this.cachedIndex.expiresAt > now) {
      return this.cachedIndex.value;
    }
    if (this.indexRequest) return this.indexRequest;
    this.indexRequest = this.loadOrRefreshIndex().finally(() => {
      this.indexRequest = undefined;
    });
    return this.indexRequest;
  }

  private async loadOrRefreshIndex(): Promise<Map<string, FeishuBaseRecord>> {
    const stored = await this.repository.loadFeishuEmailIndex();
    if (stored.entries.length) {
      const value = indexFromPersistentEntries(stored.entries);
      this.progress.indexReady(stored.entries.length, "database");
      const age = stored.refreshedAt
        ? Date.now() - stored.refreshedAt.getTime()
        : Number.POSITIVE_INFINITY;
      this.cachedIndex = {
        value,
        expiresAt: Date.now() + (age < INDEX_FRESHNESS_MS
          ? INDEX_FRESHNESS_MS - age
          : 5 * 60_000)
      };
      if (age >= INDEX_FRESHNESS_MS) {
        void this.refreshIndex("refreshing").catch((error: unknown) => {
          this.progress.indexFailed();
          console.error(JSON.stringify({
            event: "feishu_index_refresh_failed",
            message: error instanceof Error ? error.message : "Internal error"
          }));
        });
      }
      return value;
    }
    return this.refreshIndex("loading");
  }

  private async refreshIndex(
    status: "loading" | "refreshing"
  ): Promise<Map<string, FeishuBaseRecord>> {
    this.progress.indexLoading(status);
    const records = await this.feishuClient.listAllBaseRecords((value) => {
      this.progress.indexPage(value.loaded, value.total);
    });
    const entries = persistentEntries(records);
    await this.repository.replaceFeishuEmailIndex(entries);
    const value = indexFromPersistentEntries(entries);
    this.cachedIndex = { value, expiresAt: Date.now() + INDEX_FRESHNESS_MS };
    this.progress.indexReady(entries.length, "feishu");
    return value;
  }
}
