import type { MailboxRepository } from "./database.js";
import { FeishuClient, type FeishuBaseRecord } from "./feishu-client.js";
import type { CreatorMatcher, MessageSummary } from "./mailbox-service.js";

const EMAIL_PATTERN_SOURCE = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,63}";

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
    private readonly repository: MailboxRepository
  ) {}

  async matchMessages(messages: MessageSummary[]): Promise<void> {
    const index = await this.getEmailIndex();
    const orderedMessages = [...messages].sort((left, right) =>
      Date.parse(left.receivedAt ?? "") - Date.parse(right.receivedAt ?? "")
    );
    for (const message of orderedMessages) {
      const matchedRecord = message.fromAddresses
        .map((email) => index.get(email.toLowerCase()))
        .find(Boolean);
      if (matchedRecord) {
        const fields = baseFieldsForMessage(message, matchedRecord);
        await this.feishuClient.updateBaseRecord(
          matchedRecord.record_id,
          fields
        );
        Object.assign(matchedRecord.fields, fields);
        await this.repository.updateMessageMatch(
          message.id,
          "matched",
          matchedRecord.record_id
        );
        message.matchStatus = "matched";
        message.matchedRecordId = matchedRecord.record_id;
      } else {
        await this.repository.updateMessageMatch(message.id, "unmatched");
        message.matchStatus = "unmatched";
      }
    }
  }

  private async getEmailIndex(): Promise<Map<string, FeishuBaseRecord>> {
    const now = Date.now();
    if (this.cachedIndex && this.cachedIndex.expiresAt > now) {
      return this.cachedIndex.value;
    }
    if (this.indexRequest) return this.indexRequest;
    this.indexRequest = this.feishuClient
      .listAllBaseRecords()
      .then((records) => {
        const value = buildCreatorRecordIndex(records);
        this.cachedIndex = { value, expiresAt: Date.now() + 10 * 60_000 };
        return value;
      })
      .finally(() => {
        this.indexRequest = undefined;
      });
    return this.indexRequest;
  }
}
