import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  MailboxRepository,
  StoredMailbox,
  StoredMessage,
  StoredMessageInput
} from "../src/database.js";
import {
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
