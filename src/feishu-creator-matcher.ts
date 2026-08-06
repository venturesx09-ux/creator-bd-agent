import { createHash } from "node:crypto";
import type {
  CreatorReplyAggregate,
  FeishuCreatorIdIndexEntry,
  FeishuEmailIndexEntry,
  MatchReason,
  MailboxRepository
} from "./database.js";
import { FeishuClient, type FeishuBaseRecord } from "./feishu-client.js";
import { FeishuProgressTracker } from "./feishu-progress.js";
import { quoteText } from "./email-analysis-processor.js";
import type { CreatorMatcher, MessageSummary } from "./mailbox-service.js";

const EMAIL_PATTERN_SOURCE = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,63}";
const INDEX_FRESHNESS_MS = 30 * 60_000;
const MISS_REFRESH_INTERVAL_MS = 5 * 60_000;
const CREATOR_ID_FIELD_PATTERN = /(?:达人.*(?:id|账号)|(?:creator|influencer).*(?:id|handle|account)|(?:^|[^a-z])handle|社媒账号)/iu;
const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  "admin", "agent", "booking", "business", "collab", "collaboration", "contact",
  "hello", "hi", "info", "inquiries", "inquiry", "mail", "management",
  "manager", "marketing", "office", "partnerships", "support", "team"
]);
const RESERVED_CREATOR_IDS = new Set(["http", "https", "www"]);

function valueHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

type CreatorIndexes = {
  emails: Map<string, FeishuBaseRecord>;
  creatorIds: Map<string, FeishuBaseRecord | null>;
};

export function normalizeCreatorId(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/^@/u, "")
    .replace(/[,，!！:：;；]+$/u, "")
    .toLowerCase();
  return /^[\p{L}\p{N}._-]{1,100}$/u.test(normalized)
    ? normalized
    : undefined;
}

export function extractCreatorIdsFromBaseText(value: string): string[] {
  const output = new Set<string>();
  const add = (candidate: string): void => {
    const normalized = normalizeCreatorId(candidate);
    if (normalized && !RESERVED_CREATOR_IDS.has(normalized)) {
      output.add(normalized);
    }
  };
  add(value);
  for (const part of value.split(/[,，;；|\n\r]+/u)) add(part);
  for (const match of value.matchAll(
    /(?:instagram\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com)\/(?:@)?([\p{L}\p{N}._-]{1,100})/giu
  )) {
    add(match[1] ?? "");
  }
  for (const match of value.matchAll(
    /(?:达人(?:id|账号)|creator(?:\s+id)?|influencer(?:\s+id)?|handle|instagram|tiktok|ig)\s*[:：=]\s*@?([\p{L}\p{N}._-]{1,100})/giu
  )) {
    add(match[1] ?? "");
  }
  for (const match of value.matchAll(
    /(?:^|[^\p{L}\p{N}._%+-])@([\p{L}\p{N}._-]{1,100})/gu
  )) {
    add(match[1] ?? "");
  }
  return [...output];
}

export function extractHistoricalCreatorIds(text: string): string[] {
  const output = new Set<string>();
  const pattern = /(?:^|\n)\s*(?:>+\s*)?(?:hi|hello|hey|dear)\s+(@?[\p{L}\p{N}._-]{1,100})\s*[,，!！]/giu;
  for (const match of text.matchAll(pattern)) {
    const normalized = normalizeCreatorId(match[1] ?? "");
    if (normalized) output.add(normalized);
  }
  return [...output];
}

export function extractSubjectCreatorIds(subject: string): string[] {
  const output = new Set<string>();
  const pattern = /(?:^|[\s([{"'“‘《<:：,，])@([\p{L}\p{N}._-]{1,100})/gu;
  for (const match of subject.matchAll(pattern)) {
    const candidate = (match[1] ?? "").replace(/[.，,!！?？:：;；)\]}>”’]+$/u, "");
    const normalized = normalizeCreatorId(candidate);
    if (normalized) output.add(normalized);
  }
  return [...output];
}

function textValues(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => textValues(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap((item) => textValues(item, depth + 1));
  }
  return [];
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
      emailHash: valueHash(email),
      recordId: record.record_id,
      cooperationStage: currentStage(record.fields),
      ...(lastContactAt !== undefined ? { lastContactAt } : {})
    };
  });
}

function persistentCreatorIdEntries(
  records: FeishuBaseRecord[]
): FeishuCreatorIdIndexEntry[] {
  const grouped = new Map<string, FeishuBaseRecord[]>();
  for (const record of records) {
    const creatorIds = new Set(
      Object.entries(record.fields)
        .filter(([fieldName]) =>
          fieldName === "达人ID" || CREATOR_ID_FIELD_PATTERN.test(fieldName)
        )
        .flatMap(([, fieldValue]) => textValues(fieldValue))
        .flatMap((value) => extractCreatorIdsFromBaseText(value))
    );
    for (const creatorId of creatorIds) {
      const existing = grouped.get(creatorId) ?? [];
      existing.push(record);
      grouped.set(creatorId, existing);
    }
  }
  return [...grouped].map(([creatorId, matches]) => {
    const uniqueRecords = [...new Map(
      matches.map((record) => [record.record_id, record])
    ).values()];
    const record = uniqueRecords[0];
    const ambiguous = uniqueRecords.length !== 1 || !record;
    const lastContactAt = record
      ? currentTimestamp(record.fields["最后联系时间"])
      : undefined;
    return {
      creatorIdHash: valueHash(creatorId),
      ...(!ambiguous && record ? { recordId: record.record_id } : {}),
      ambiguous,
      cooperationStage: record ? currentStage(record.fields) : "",
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

function creatorIdIndexFromPersistentEntries(
  entries: FeishuCreatorIdIndexEntry[]
): Map<string, FeishuBaseRecord | null> {
  return new Map(entries.map((entry) => [
    entry.creatorIdHash,
    entry.ambiguous || !entry.recordId
      ? null
      : {
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

function unmatchedReasonLabel(value: MatchReason): string {
  return {
    email_exact: "需要人工判断",
    sender_local_part: "需要人工判断",
    subject_creator_id: "需要人工判断",
    history_creator_id: "需要人工判断",
    history_creator_id_missing: "标题和历史邮件中未找到达人ID",
    creator_id_not_found: "标题或历史达人ID在飞书中不存在",
    creator_id_ambiguous: "达人ID重复"
  }[value];
}

function senderLocalCreatorIds(message: MessageSummary): string[] {
  const output = new Set<string>();
  for (const email of message.fromAddresses) {
    const localPart = email.split("@", 1)[0]?.toLowerCase();
    if (!localPart || GENERIC_EMAIL_LOCAL_PARTS.has(localPart)) continue;
    const normalized = normalizeCreatorId(localPart);
    if (normalized) output.add(normalized);
  }
  return [...output];
}

function unmatchedFieldsForMessage(
  message: MessageSummary,
  reason: MatchReason
): Record<string, unknown> {
  const receivedAt = message.receivedAt
    ? Date.parse(message.receivedAt)
    : Number.NaN;
  const fields: Record<string, unknown> = {
    "待匹配邮件ID": message.id,
    "发件人名称": message.from.join(", ").slice(0, 500),
    "发件邮箱": message.fromAddresses[0] ?? "",
    "邮件主题": message.subject.slice(0, 500),
    "邮件分类": classificationLabel(message.classification),
    "未匹配原因": unmatchedReasonLabel(reason),
    "历史识别达人ID": [...new Set([
      ...extractSubjectCreatorIds(message.subject),
      ...extractHistoricalCreatorIds(message.textPreview)
    ])].join(", "),
    "邮件预览": message.textPreview.slice(0, 2_000),
    "处理状态": "待处理"
  };
  if (Number.isFinite(receivedAt)) fields["收件时间"] = receivedAt;
  if (message.project) fields["项目"] = message.project;
  if (message.mailboxEmail) fields["收件邮箱"] = message.mailboxEmail;
  if (message.analysis) {
    fields["AI中文摘要"] = message.analysis.summaryZh;
    fields["报价"] = quoteText(message.analysis);
  }
  return fields;
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

const MAX_REPLY_DETAIL_CHARACTERS = 50_000;

function beijingTime(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return "时间未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function replyDetailLine(message: MessageSummary): string {
  const sender = (message.fromAddresses[0] ?? message.from[0] ?? "发件人未知")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 320);
  const subject = message.subject.replace(/\s+/gu, " ").trim().slice(0, 500);
  return `${beijingTime(message.receivedAt)}（北京时间）｜${sender}｜${subject || "(无主题)"}`;
}

export function replyAggregateFields(
  aggregate: CreatorReplyAggregate
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "累计回复邮件数": aggregate.count
  };
  if (aggregate.firstReceivedAt) {
    fields["首次回复时间"] = aggregate.firstReceivedAt.getTime();
  }
  if (aggregate.latestReceivedAt) {
    fields["最近回复时间"] = aggregate.latestReceivedAt.getTime();
  }
  const allDetails = aggregate.detailLines.join("\n");
  fields["回复邮件明细"] = allDetails.length <= MAX_REPLY_DETAIL_CHARACTERS
    ? allDetails
    : `较早记录因字段长度限制已省略；累计数量仍为准确值。\n${allDetails.slice(-MAX_REPLY_DETAIL_CHARACTERS)}`;
  return fields;
}

function resolveMessageRecord(
  message: MessageSummary,
  indexes: CreatorIndexes
): {
  record?: FeishuBaseRecord;
  reason: MatchReason;
  creatorId?: string;
} {
  const emailRecord = message.fromAddresses
    .map((email) => indexes.emails.get(valueHash(email)))
    .find(Boolean);
  if (emailRecord) return { record: emailRecord, reason: "email_exact" };

  const senderCreatorIds = senderLocalCreatorIds(message);
  const senderResolution = resolveCreatorIds(senderCreatorIds, indexes);
  if (senderResolution.record) {
    return {
      record: senderResolution.record,
      reason: "sender_local_part",
      ...(senderResolution.creatorId
        ? { creatorId: senderResolution.creatorId }
        : {})
    };
  }
  if (senderResolution.ambiguous) {
    return { reason: "creator_id_ambiguous" };
  }

  const subjectCreatorIds = extractSubjectCreatorIds(message.subject);
  const subjectResolution = resolveCreatorIds(subjectCreatorIds, indexes);
  if (subjectResolution.record) {
    return {
      record: subjectResolution.record,
      reason: "subject_creator_id",
      ...(subjectResolution.creatorId
        ? { creatorId: subjectResolution.creatorId }
        : {})
    };
  }
  if (subjectResolution.ambiguous) {
    return { reason: "creator_id_ambiguous" };
  }

  const creatorIds = extractHistoricalCreatorIds(message.textPreview);
  if (!creatorIds.length) {
    return {
      reason: subjectCreatorIds.length || senderCreatorIds.length
        ? "creator_id_not_found"
        : "history_creator_id_missing"
    };
  }

  const historyResolution = resolveCreatorIds(creatorIds, indexes);
  if (historyResolution.record) {
    return {
      record: historyResolution.record,
      reason: "history_creator_id",
      ...(historyResolution.creatorId
        ? { creatorId: historyResolution.creatorId }
        : {})
    };
  }
  if (historyResolution.ambiguous) {
    return { reason: "creator_id_ambiguous" };
  }
  return { reason: "creator_id_not_found" };
}

function resolveCreatorIds(
  creatorIds: string[],
  indexes: CreatorIndexes
): { record?: FeishuBaseRecord; creatorId?: string; ambiguous: boolean } {
  let ambiguous = false;
  const matches = new Map<string, FeishuBaseRecord>();
  for (const creatorId of creatorIds) {
    const value = indexes.creatorIds.get(valueHash(creatorId));
    if (value === null) {
      ambiguous = true;
    } else if (value) {
      matches.set(value.record_id, value);
    }
  }
  if (matches.size === 1 && !ambiguous) {
    const record = matches.values().next().value as FeishuBaseRecord;
    const creatorId = creatorIds.find((candidate) =>
      indexes.creatorIds.get(valueHash(candidate))?.record_id === record.record_id
    );
    return {
      record,
      ...(creatorId ? { creatorId } : {}),
      ambiguous: false
    };
  }
  return { ambiguous: matches.size > 1 || ambiguous };
}

export class FeishuCreatorMatcher implements CreatorMatcher {
  private cachedIndex:
    | { value: CreatorIndexes; expiresAt: number }
    | undefined;
  private indexRequest: Promise<CreatorIndexes> | undefined;
  private lastFullIndexRefreshAt = 0;

  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly repository: MailboxRepository,
    private readonly progress = new FeishuProgressTracker()
  ) {}

  async matchMessages(messages: MessageSummary[]): Promise<void> {
    const candidateMessages = messages.filter(
      (message) => message.classification === "creator_reply"
    );
    this.progress.beginBatch(candidateMessages.length);
    if (!candidateMessages.length) {
      this.progress.endBatch();
      return;
    }
    let indexes: CreatorIndexes;
    try {
      indexes = await this.getIndexes();
    } catch (error) {
      this.progress.indexFailed();
      this.progress.failBatch("飞书索引加载失败");
      throw error;
    }
    const orderedMessages = [...candidateMessages].sort((left, right) =>
      Date.parse(left.receivedAt ?? "") - Date.parse(right.receivedAt ?? "")
    );
    for (const message of orderedMessages) {
      try {
        let resolution = resolveMessageRecord(message, indexes);
        if (
          !resolution.record &&
          resolution.reason !== "creator_id_ambiguous" &&
          Date.now() - this.lastFullIndexRefreshAt >= MISS_REFRESH_INTERVAL_MS
        ) {
          indexes = await this.forceRefreshIndexAfterMiss();
          resolution = resolveMessageRecord(message, indexes);
        }
        const matchedRecord = resolution.record;
        if (matchedRecord) {
          let aggregateFields: Record<string, unknown> = {};
          if (this.repository.recordCreatorReplyEvent) {
            const receivedAt = message.receivedAt
              ? new Date(message.receivedAt)
              : undefined;
            const aggregate = await this.repository.recordCreatorReplyEvent({
              messageId: message.id,
              recordId: matchedRecord.record_id,
              ...(receivedAt && !Number.isNaN(receivedAt.getTime())
                ? { receivedAt }
                : {}),
              detailLine: replyDetailLine(message)
            });
            aggregateFields = replyAggregateFields(aggregate);
          }
          const fields = {
            ...baseFieldsForMessage(message, matchedRecord),
            ...aggregateFields
          };
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
            matchedRecord.record_id,
            resolution.reason
          );
          await this.repository.markMessageReplyAggregateSynced?.(message.id);
          message.matchStatus = "matched";
          message.matchedRecordId = matchedRecord.record_id;
          message.matchReason = resolution.reason;
          message.replyAggregateSyncStatus = "synced";
          await this.resolveUnmatchedQueueRecord(
            message,
            matchedRecord.record_id,
            resolution.creatorId
          );
          this.progress.messageSucceeded(true);
        } else {
          await this.repository.updateMessageMatch(
            message.id,
            "unmatched",
            undefined,
            resolution.reason
          );
          message.matchStatus = "unmatched";
          message.matchReason = resolution.reason;
          await this.syncUnmatchedQueueRecord(message, resolution.reason);
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

  private async syncUnmatchedQueueRecord(
    message: MessageSummary,
    reason: MatchReason
  ): Promise<void> {
    if (!this.feishuClient.isUnmatchedTableConfigured()) return;
    try {
      const fields = unmatchedFieldsForMessage(message, reason);
      const existingRecordId = await this.repository.getUnmatchedRecordId(
        message.id
      );
      if (existingRecordId) {
        await this.feishuClient.updateUnmatchedRecord(existingRecordId, fields);
        return;
      }
      const recordId = await this.feishuClient.createUnmatchedRecord(fields);
      await this.repository.setUnmatchedRecordId(message.id, recordId);
    } catch (error) {
      console.error(JSON.stringify({
        event: "feishu_unmatched_queue_sync_failed",
        messageId: message.id,
        message: error instanceof Error ? error.message : "Internal error"
      }));
    }
  }

  private async resolveUnmatchedQueueRecord(
    message: MessageSummary,
    matchedRecordId: string,
    creatorId?: string
  ): Promise<void> {
    if (!this.feishuClient.isUnmatchedTableConfigured()) return;
    try {
      const queueRecordId = await this.repository.getUnmatchedRecordId(message.id);
      if (!queueRecordId) return;
      await this.feishuClient.updateUnmatchedRecord(queueRecordId, {
        "处理状态": "已匹配",
        ...(creatorId ? { "最终匹配达人ID": creatorId } : {}),
        "最终匹配记录ID": matchedRecordId,
        "解决时间": Date.now()
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "feishu_unmatched_queue_resolve_failed",
        messageId: message.id,
        message: error instanceof Error ? error.message : "Internal error"
      }));
    }
  }

  requestIndexRefresh(): { status: "started" | "already_running" } {
    if (this.indexRequest) return { status: "already_running" };
    this.indexRequest = this.refreshIndex("refreshing").finally(() => {
      this.indexRequest = undefined;
    });
    void this.indexRequest.catch((error: unknown) => {
      this.progress.indexFailed();
      console.error(JSON.stringify({
        event: "feishu_index_refresh_failed",
        message: error instanceof Error ? error.message : "Internal error"
      }));
    });
    return { status: "started" };
  }

  private async forceRefreshIndexAfterMiss(): Promise<CreatorIndexes> {
    if (this.indexRequest) return this.indexRequest;
    this.indexRequest = this.refreshIndex("refreshing").finally(() => {
      this.indexRequest = undefined;
    });
    return this.indexRequest;
  }

  private async getIndexes(): Promise<CreatorIndexes> {
    const now = Date.now();
    if (this.cachedIndex && this.cachedIndex.expiresAt > now) {
      this.progress.indexReady(this.cachedIndex.value.emails.size, "database");
      return this.cachedIndex.value;
    }
    if (this.indexRequest) return this.indexRequest;
    this.indexRequest = this.loadOrRefreshIndex().finally(() => {
      this.indexRequest = undefined;
    });
    return this.indexRequest;
  }

  private async loadOrRefreshIndex(): Promise<CreatorIndexes> {
    const [storedEmails, storedCreatorIds] = await Promise.all([
      this.repository.loadFeishuEmailIndex(),
      this.repository.loadFeishuCreatorIdIndex()
    ]);
    if (storedEmails.entries.length && storedCreatorIds.length) {
      const value: CreatorIndexes = {
        emails: indexFromPersistentEntries(storedEmails.entries),
        creatorIds: creatorIdIndexFromPersistentEntries(storedCreatorIds)
      };
      this.progress.indexReady(storedEmails.entries.length, "database");
      const age = storedEmails.refreshedAt
        ? Date.now() - storedEmails.refreshedAt.getTime()
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
  ): Promise<CreatorIndexes> {
    this.progress.indexLoading(status);
    const records = await this.feishuClient.listAllBaseRecords((value) => {
      this.progress.indexPage(value.loaded, value.total);
    });
    const emailEntries = persistentEntries(records);
    const creatorIdEntries = persistentCreatorIdEntries(records);
    await Promise.all([
      this.repository.replaceFeishuEmailIndex(emailEntries),
      this.repository.replaceFeishuCreatorIdIndex(creatorIdEntries)
    ]);
    const value: CreatorIndexes = {
      emails: indexFromPersistentEntries(emailEntries),
      creatorIds: creatorIdIndexFromPersistentEntries(creatorIdEntries)
    };
    this.cachedIndex = { value, expiresAt: Date.now() + INDEX_FRESHNESS_MS };
    this.lastFullIndexRefreshAt = Date.now();
    this.progress.indexReady(records.length, "feishu");
    return value;
  }
}
