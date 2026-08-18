import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  MailboxRepository,
  StoredMailbox,
  StoredMessage,
  StoredMessageInput
} from "../src/database.js";
import {
  classifyEmail,
  mergeSyncUids,
  messagesNeedingMatch,
  MailboxService,
  MailboxServiceError,
  parseMailboxSource,
  shouldProcessAiMessage,
  type MailboxConnectionConfig
} from "../src/mailbox-service.js";
import { SecretBox } from "../src/secret-box.js";
import type { SmtpFactory } from "../src/smtp-reply.js";

class MemoryRepository implements MailboxRepository {
  rows: StoredMailbox[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async listMailboxes(): Promise<StoredMailbox[]> { return this.rows; }
  async getMailbox(id: string): Promise<StoredMailbox | undefined> {
    return this.rows.find((row) => row.id === id);
  }
  async createMailbox(input: {
    id: string;
    label: string;
    brand: string;
    encryptedConfig: string;
  }): Promise<StoredMailbox> {
    const now = new Date();
    const row: StoredMailbox = {
      ...input,
      enabled: true,
      smtpEnabled: false,
      lastUid: 0,
      createdAt: now,
      updatedAt: now
    };
    this.rows.push(row);
    return row;
  }
  async setMailboxEnabled(id: string, enabled: boolean): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return false;
    row.enabled = enabled;
    return true;
  }
  async saveSmtpConfig(id: string, encryptedConfig: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return false;
    row.encryptedConfig = encryptedConfig;
    row.smtpEnabled = false;
    delete row.smtpLastTestAt;
    delete row.smtpLastTestStatus;
    delete row.smtpLastErrorCode;
    return true;
  }
  async recordSmtpTest(
    id: string,
    status: "success" | "failed",
    errorCode?: string
  ): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    row.smtpLastTestAt = new Date();
    row.smtpLastTestStatus = status;
    if (errorCode) row.smtpLastErrorCode = errorCode;
    else delete row.smtpLastErrorCode;
  }
  async setSmtpEnabled(id: string, enabled: boolean): Promise<"updated" | "conflict"> {
    if (enabled && this.rows.some((item) => item.id !== id && item.smtpEnabled)) {
      return "conflict";
    }
    const row = this.rows.find((item) => item.id === id);
    if (!row) return "conflict";
    row.smtpEnabled = enabled;
    return "updated";
  }
  async deleteMailboxIfEmpty(id: string): Promise<"deleted" | "not_found" | "has_messages"> {
    const index = this.rows.findIndex((item) => item.id === id);
    if (index < 0) return "not_found";
    this.rows.splice(index, 1);
    return "deleted";
  }
  async recordConnectionTest(): Promise<void> {}
  async recordSyncFailure(): Promise<void> {}
  async saveMessagesAndCursor(_input: {
    mailboxId: string;
    messages: StoredMessageInput[];
    uidValidity: string;
    lastUid: number;
    errorCode?: string;
  }): Promise<number> { return 0; }
  async listMessages(_mailboxId: string, _limit: number): Promise<StoredMessage[]> {
    return [];
  }
  async getMessage(): Promise<StoredMessage | undefined> { return undefined; }
  async saveMessageAnalysis(): Promise<void> {}
  async recordMessageAnalysisFailure(): Promise<void> {}
  async markMessageAnalysisSynced(): Promise<void> {}
  async claimMessageForSend(): Promise<"claimed"> { return "claimed"; }
  async recordMessageSent(): Promise<void> {}
  async recordMessageSendFailure(): Promise<void> {}
  async markSentCopyStatus(): Promise<void> {}
  async markMessageSendFeishuSynced(): Promise<void> {}
  async listKnownUids(): Promise<Set<number>> { return new Set(); }
  async listMessagesNeedingProcessing(): Promise<StoredMessage[]> { return []; }
  async listMessagesNeedingContentRefresh(): Promise<StoredMessage[]> { return []; }
  async refreshMessageContent(): Promise<void> {}
  async updateMessageClassification(): Promise<void> {}
  async updateMessageMatch(): Promise<void> {}
  async getUnmatchedRecordId(): Promise<string | undefined> { return undefined; }
  async setUnmatchedRecordId(): Promise<void> {}
  async loadFeishuEmailIndex() { return { entries: [] }; }
  async replaceFeishuEmailIndex(): Promise<void> {}
  async loadFeishuCreatorIdIndex() { return []; }
  async replaceFeishuCreatorIdIndex(): Promise<void> {}
  async updateFeishuIndexRecord(): Promise<void> {}
  async getDailySummary() {
    return {
      total: 0, matched: 0, uniqueMatchedCreators: 0,
      duplicateMatchedMessages: 0, unmatched: 0, pending: 0,
      classifications: {
        creator_reply: 0, automatic_reply: 0, delivery_failure: 0,
        bulk_notification: 0, unknown: 0
      }
    };
  }
}

describe("email body extraction", () => {
  it("converts HTML-only email bodies to text and preserves quote history", async () => {
    const source = Buffer.from([
      "From: Creator <creator@example.com>",
      "To: Shark <shark@example.com>",
      "Subject: Re: campaign",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>My rate is <strong>$500 per Reel</strong>.</p>",
      "<blockquote>Earlier package: $1,200 for three videos.</blockquote>"
    ].join("\r\n"));

    const parsed = await parseMailboxSource(source);

    assert.match(parsed?.text ?? "", /\$500 per Reel/u);
    assert.match(parsed?.text ?? "", /\$1,200 for three videos/u);
  });
});

describe("MailboxService configuration", () => {
  it("validates and encrypts mailbox credentials before storage", async () => {
    const repository = new MemoryRepository();
    const secretBox = new SecretBox(Buffer.alloc(32, 8).toString("base64"));
    const service = new MailboxService(repository, secretBox, 20);

    const result = await service.createMailbox({
      label: "Tripo inbox",
      brand: "Tripo",
      emailAddress: "shark@example.com",
      senderName: "Shark",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "shark@example.com",
      imapPassword: "application-password",
      inboxName: "INBOX"
    });

    assert.equal(result.emailAddress, "shark@example.com");
    const stored = repository.rows[0];
    assert.ok(stored);
    assert.equal(stored.encryptedConfig.includes("application-password"), false);
    assert.equal(
      secretBox.decrypt<MailboxConnectionConfig>(stored.encryptedConfig)
        .imapPassword,
      "application-password"
    );
  });

  it("rejects non-public or malformed IMAP hostnames", async () => {
    const service = new MailboxService(
      new MemoryRepository(),
      new SecretBox(Buffer.alloc(32, 9).toString("base64")),
      20
    );

    await assert.rejects(
      service.createMailbox({
        label: "Unsafe",
        brand: "",
        emailAddress: "test@example.com",
        senderName: "Test",
        imapHost: "localhost",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: "test@example.com",
        imapPassword: "password",
        inboxName: "INBOX"
      }),
      (error: unknown) =>
        error instanceof MailboxServiceError && error.errorCode === "INVALID_INPUT"
    );
  });

  it("encrypts SMTP credentials, verifies without sending, then enables one pilot", async () => {
    const repository = new MemoryRepository();
    const secretBox = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
    let verifyCalls = 0;
    let sendCalls = 0;
    const smtpFactory: SmtpFactory = () => ({
      verify: async () => { verifyCalls += 1; return true; },
      sendMail: async () => { sendCalls += 1; return {}; },
      close: () => undefined
    });
    const service = new MailboxService(
      repository,
      secretBox,
      20,
      undefined,
      undefined,
      undefined,
      smtpFactory
    );
    const mailbox = await service.createMailbox({
      label: "Pilot",
      brand: "Tripo",
      emailAddress: "shark@example.com",
      senderName: "Shark",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "shark@example.com",
      imapPassword: "imap-password",
      inboxName: "INBOX"
    });

    const configured = await service.configureSmtp(mailbox.id, {
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: "shark@example.com",
      password: "smtp-application-password",
      sentFolder: "Sent",
      saveToSent: true,
      signature: "Best, Shark"
    });
    assert.equal(configured.smtpConfigured, true);
    assert.equal(configured.smtpEnabled, false);
    assert.equal(
      repository.rows[0]?.encryptedConfig.includes("smtp-application-password"),
      false
    );

    await service.testSmtp(mailbox.id);
    const enabled = await service.setSmtpEnabled(mailbox.id, true);
    assert.equal(enabled.smtpEnabled, true);
    assert.equal(verifyCalls, 1);
    assert.equal(sendCalls, 0);
  });
});

describe("email rule classification", () => {
  it("separates creator replies, automatic replies, bounces and bulk mail", () => {
    assert.equal(classifyEmail({
      subject: "Re: collaboration", fromAddresses: ["creator@example.com"]
    }), "creator_reply");
    assert.equal(classifyEmail({
      subject: "Automatic Reply", fromAddresses: ["creator@example.com"],
      autoSubmitted: "auto-replied"
    }), "automatic_reply");
    assert.equal(classifyEmail({
      subject: "Delivery Status Notification", fromAddresses: ["mailer-daemon@example.com"]
    }), "delivery_failure");
    assert.equal(classifyEmail({
      subject: "Weekly update", fromAddresses: ["no-reply@example.com"],
      precedence: "bulk"
    }), "bulk_notification");
  });
});

describe("email rematching", () => {
  it("retries pending, unmatched, and matched messages awaiting reply aggregation", () => {
    const base = {
      uid: 1, subject: "Re", from: [], fromAddresses: [], to: [],
      messageId: "m", references: [], textPreview: "",
      classification: "creator_reply" as const
    };
    const result = messagesNeedingMatch([
      { ...base, id: "pending", matchStatus: "pending" },
      { ...base, id: "unmatched", matchStatus: "unmatched" },
      {
        ...base,
        id: "matched-synced",
        matchStatus: "matched",
        replyAggregateSyncStatus: "synced"
      },
      {
        ...base,
        id: "matched-needs-aggregate",
        matchStatus: "matched",
        replyAggregateSyncStatus: "pending"
      },
      {
        ...base,
        id: "automatic-with-creator-id",
        subject: "Automatic reply: partnership with @creator_handle",
        classification: "automatic_reply",
        matchStatus: "pending"
      }
    ]);
    assert.deepEqual(result.map((message) => message.id), [
      "pending",
      "unmatched",
      "matched-needs-aggregate"
    ]);
  });
});

describe("bounded AI retry eligibility", () => {
  const base = {
    id: "retry", uid: 1, subject: "Re", from: [], fromAddresses: [], to: [],
    messageId: "m", references: [], textPreview: "",
    classification: "creator_reply" as const, matchStatus: "matched" as const,
    matchedRecordId: "rec1", aiAnalysisSchemaVersion: 1
  };

  it("does not retry failed analysis before its scheduled time or after retries stop", () => {
    const now = Date.parse("2026-08-18T08:00:00.000Z");
    assert.equal(shouldProcessAiMessage({
      ...base, aiAnalysisStatus: "failed",
      aiNextRetryAt: "2026-08-18T08:30:00.000Z"
    }, now), false);
    assert.equal(shouldProcessAiMessage({
      ...base, aiAnalysisStatus: "failed",
      aiNextRetryAt: "2026-08-18T07:59:00.000Z"
    }, now), true);
    assert.equal(shouldProcessAiMessage({
      ...base, aiAnalysisStatus: "failed"
    }, now), false);
  });
});

describe("unread backfill", () => {
  it("adds missing unseen UIDs without refetching stored messages", () => {
    assert.deepEqual(
      mergeSyncUids([101, 102], [20, 21, 101], new Set([20])),
      [21, 101, 102]
    );
  });
});
