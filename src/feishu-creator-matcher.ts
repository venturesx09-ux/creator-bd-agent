import type { MailboxRepository } from "./database.js";
import { FeishuClient, type FeishuBaseRecord } from "./feishu-client.js";
import type { CreatorMatcher, MessageSummary } from "./mailbox-service.js";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/giu;

function collectEmails(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      output.add(match[0].toLowerCase());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectEmails(item, output, depth + 1);
    }
  }
}

export function buildCreatorEmailIndex(
  records: FeishuBaseRecord[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    const emails = new Set<string>();
    collectEmails(record.fields, emails);
    for (const email of emails) {
      if (!index.has(email)) index.set(email, record.record_id);
    }
  }
  return index;
}

export class FeishuCreatorMatcher implements CreatorMatcher {
  private cachedIndex:
    | { value: Map<string, string>; expiresAt: number }
    | undefined;
  private indexRequest: Promise<Map<string, string>> | undefined;

  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly repository: MailboxRepository
  ) {}

  async matchMessages(messages: MessageSummary[]): Promise<void> {
    const index = await this.getEmailIndex();
    for (const message of messages) {
      const matchedRecordId = message.fromAddresses
        .map((email) => index.get(email.toLowerCase()))
        .find(Boolean);
      if (matchedRecordId) {
        await this.repository.updateMessageMatch(
          message.id,
          "matched",
          matchedRecordId
        );
        message.matchStatus = "matched";
        message.matchedRecordId = matchedRecordId;
      } else {
        await this.repository.updateMessageMatch(message.id, "unmatched");
        message.matchStatus = "unmatched";
      }
    }
  }

  private async getEmailIndex(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cachedIndex && this.cachedIndex.expiresAt > now) {
      return this.cachedIndex.value;
    }
    if (this.indexRequest) return this.indexRequest;
    this.indexRequest = this.feishuClient
      .listAllBaseRecords()
      .then((records) => {
        const value = buildCreatorEmailIndex(records);
        this.cachedIndex = { value, expiresAt: Date.now() + 60_000 };
        return value;
      })
      .finally(() => {
        this.indexRequest = undefined;
      });
    return this.indexRequest;
  }
}
