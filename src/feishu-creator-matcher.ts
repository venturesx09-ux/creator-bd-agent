import type { MailboxRepository } from "./database.js";
import { FeishuClient, type FeishuBaseRecord } from "./feishu-client.js";
import type { CreatorMatcher, MessageSummary } from "./mailbox-service.js";

const EMAIL_PATTERN_SOURCE = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,63}";

export function buildCreatorEmailIndex(
  records: FeishuBaseRecord[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    const serializedFields = JSON.stringify(record.fields);
    const emails = serializedFields.match(
      new RegExp(EMAIL_PATTERN_SOURCE, "giu")
    ) ?? [];
    for (const email of new Set(emails.map((value) => value.toLowerCase()))) {
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
