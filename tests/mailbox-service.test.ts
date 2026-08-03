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
  type MailboxConnectionConfig
} from "../src/mailbox-service.js";
import { SecretBox } from "../src/secret-box.js";

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
  async listKnownUids(): Promise<Set<number>> { return new Set(); }
  async listMessagesNeedingProcessing(): Promise<StoredMessage[]> { return []; }
  async updateMessageClassification(): Promise<void> {}
  async updateMessageMatch(): Promise<void> {}
  async loadFeishuEmailIndex() { return { entries: [] }; }
  async replaceFeishuEmailIndex(): Promise<void> {}
  async loadFeishuCreatorIdIndex() { return []; }
  async replaceFeishuCreatorIdIndex(): Promise<void> {}
  async updateFeishuIndexRecord(): Promise<void> {}
  async getDailySummary() {
    return {
      total: 0, matched: 0, unmatched: 0, pending: 0,
      classifications: {
        creator_reply: 0, automatic_reply: 0, delivery_failure: 0,
        bulk_notification: 0, unknown: 0
      }
    };
  }
}

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
  it("retries both pending and previously unmatched messages", () => {
    const base = {
      uid: 1, subject: "Re", from: [], fromAddresses: [], to: [],
      messageId: "m", references: [], textPreview: "",
      classification: "creator_reply" as const
    };
    const result = messagesNeedingMatch([
      { ...base, id: "pending", matchStatus: "pending" },
      { ...base, id: "unmatched", matchStatus: "unmatched" },
      { ...base, id: "matched", matchStatus: "matched" }
    ]);
    assert.deepEqual(result.map((message) => message.id), ["pending", "unmatched"]);
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
