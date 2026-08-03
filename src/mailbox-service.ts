import { createHash, randomUUID } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import type {
  MailboxRepository,
  StoredMailbox,
  StoredMessageInput
} from "./database.js";
import { SecretBox } from "./secret-box.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const SYNC_BATCH_SIZE = 100;

export type MailboxConnectionConfig = {
  emailAddress: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  imapUsername: string;
  imapPassword: string;
  inboxName: string;
};

export type CreateMailboxInput = MailboxConnectionConfig & {
  label: string;
  brand: string;
};

export type MailboxSummary = {
  id: string;
  label: string;
  brand: string;
  emailAddress: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  enabled: boolean;
  lastTestAt?: string;
  lastTestStatus?: string;
  lastSyncAt?: string;
  lastErrorCode?: string;
};

export type MessageSummary = {
  id: string;
  uid: number;
  subject: string;
  from: string[];
  to: string[];
  receivedAt?: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  textPreview: string;
};

type EncryptedMessagePayload = Omit<MessageSummary, "id" | "uid">;

export class MailboxServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: string
  ) {
    super(message);
    this.name = "MailboxServiceError";
  }
}

export interface MailboxServiceLike {
  listMailboxes(): Promise<MailboxSummary[]>;
  createMailbox(input: unknown): Promise<MailboxSummary>;
  testConnection(id: string): Promise<{
    status: "ok";
    messagesInInbox: number;
    nextUid: number;
  }>;
  syncMailbox(id: string): Promise<{
    status: "ok";
    fetched: number;
    inserted: number;
    hasMore: boolean;
    messages: MessageSummary[];
  }>;
  listMessages(id: string, limit: number): Promise<MessageSummary[]>;
}

type ImapFactory = (options: ImapFlowOptions) => ImapFlow;

function requiredString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new MailboxServiceError(`${field} is required`, 400, "INVALID_INPUT");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new MailboxServiceError(
      `${field} has an invalid length`,
      400,
      "INVALID_INPUT"
    );
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return requiredString(value, field, maxLength);
}

function validateCreateInput(value: unknown): CreateMailboxInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MailboxServiceError(
      "Request body must be an object",
      400,
      "INVALID_INPUT"
    );
  }
  const input = value as Record<string, unknown>;
  const emailAddress = requiredString(input.emailAddress, "emailAddress", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(emailAddress)) {
    throw new MailboxServiceError(
      "emailAddress is invalid",
      400,
      "INVALID_INPUT"
    );
  }

  const imapHost = requiredString(input.imapHost, "imapHost", 253).toLowerCase();
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      imapHost
    )
  ) {
    throw new MailboxServiceError(
      "imapHost must be a public fully-qualified hostname",
      400,
      "INVALID_INPUT"
    );
  }

  const imapPort = input.imapPort;
  if (imapPort !== 993 && imapPort !== 143) {
    throw new MailboxServiceError(
      "imapPort must be 993 or 143",
      400,
      "INVALID_INPUT"
    );
  }
  const imapSecurity = input.imapSecurity;
  if (imapSecurity !== "tls" && imapSecurity !== "starttls") {
    throw new MailboxServiceError(
      "imapSecurity must be tls or starttls",
      400,
      "INVALID_INPUT"
    );
  }
  if (
    (imapPort === 993 && imapSecurity !== "tls") ||
    (imapPort === 143 && imapSecurity !== "starttls")
  ) {
    throw new MailboxServiceError(
      "Use TLS with port 993 or STARTTLS with port 143",
      400,
      "INVALID_INPUT"
    );
  }

  return {
    label: requiredString(input.label, "label", 80),
    brand: optionalString(input.brand, "brand", 80),
    emailAddress,
    senderName: requiredString(input.senderName, "senderName", 100),
    imapHost,
    imapPort,
    imapSecurity,
    imapUsername: requiredString(input.imapUsername, "imapUsername", 254),
    imapPassword: requiredString(input.imapPassword, "imapPassword", 2_048),
    inboxName: optionalString(input.inboxName, "inboxName", 128) || "INBOX"
  };
}

function addresses(
  values: Array<{ name?: string; address?: string }> | undefined
): string[] {
  return (values ?? [])
    .map((value) => {
      if (value.name && value.address) {
        return `${value.name} <${value.address}>`;
      }
      return value.address || value.name || "";
    })
    .filter(Boolean)
    .slice(0, 50);
}

function normalizedReferences(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).slice(0, 100);
}

function safePreview(value: string | undefined): string {
  return (value ?? "")
    .replace(/\u0000/gu, "")
    .replace(/\r\n/gu, "\n")
    .trim()
    .slice(0, 4_000);
}

function imapError(error: unknown, fallbackCode: string): MailboxServiceError {
  const candidate = error as {
    code?: unknown;
    authenticationFailed?: unknown;
    message?: unknown;
  };
  const rawCode = typeof candidate?.code === "string" ? candidate.code : "";
  const rawMessage =
    typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  if (
    candidate?.authenticationFailed === true ||
    /auth|login|credential|password/u.test(rawCode.toLowerCase()) ||
    /authentication|login failed|invalid credentials/u.test(rawMessage)
  ) {
    return new MailboxServiceError(
      "IMAP authentication failed",
      502,
      "IMAP_AUTH_FAILED"
    );
  }
  if (/cert|tls|ssl/u.test(rawCode.toLowerCase() + rawMessage)) {
    return new MailboxServiceError(
      "IMAP TLS connection failed",
      502,
      "IMAP_TLS_FAILED"
    );
  }
  return new MailboxServiceError(
    "Unable to connect to the IMAP server",
    502,
    fallbackCode
  );
}

export class MailboxService implements MailboxServiceLike {
  constructor(
    private readonly repository: MailboxRepository,
    private readonly secretBox: SecretBox,
    private readonly initialSyncLimit: number,
    private readonly imapFactory: ImapFactory = (options) => new ImapFlow(options)
  ) {}

  async listMailboxes(): Promise<MailboxSummary[]> {
    const rows = await this.repository.listMailboxes();
    return rows.map((row) => this.toSummary(row));
  }

  async createMailbox(value: unknown): Promise<MailboxSummary> {
    const input = validateCreateInput(value);
    const { label, brand, ...connection } = input;
    const row = await this.repository.createMailbox({
      id: randomUUID(),
      label,
      brand,
      encryptedConfig: this.secretBox.encrypt(connection)
    });
    return this.toSummary(row);
  }

  async testConnection(id: string): Promise<{
    status: "ok";
    messagesInInbox: number;
    nextUid: number;
  }> {
    const row = await this.requireMailbox(id);
    const config = this.connectionConfig(row);
    const client = this.createImapClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.inboxName, {
        readOnly: true,
        description: "connection-test"
      });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) {
          throw new Error("Mailbox was not opened");
        }
        await this.repository.recordConnectionTest(id, "success");
        return {
          status: "ok",
          messagesInInbox: mailbox.exists,
          nextUid: mailbox.uidNext
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      const safeError = imapError(error, "IMAP_CONNECT_FAILED");
      await this.repository.recordConnectionTest(id, "failed", safeError.errorCode);
      throw safeError;
    } finally {
      await this.closeImap(client);
    }
  }

  async syncMailbox(id: string): Promise<{
    status: "ok";
    fetched: number;
    inserted: number;
    hasMore: boolean;
    messages: MessageSummary[];
  }> {
    const row = await this.requireMailbox(id);
    const config = this.connectionConfig(row);
    const client = this.createImapClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.inboxName, {
        readOnly: true,
        description: "read-only-sync"
      });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) {
          throw new Error("Mailbox was not opened");
        }
        const uidValidity = mailbox.uidValidity.toString();
        const highestUid = Math.max(0, mailbox.uidNext - 1);
        const cursorIsValid = row.uidValidity === uidValidity;
        const startUid = cursorIsValid && row.lastUid > 0
          ? row.lastUid + 1
          : Math.max(1, mailbox.uidNext - this.initialSyncLimit);

        if (startUid > highestUid) {
          await this.repository.saveMessagesAndCursor({
            mailboxId: id,
            messages: [],
            uidValidity,
            lastUid: highestUid
          });
          return {
            status: "ok",
            fetched: 0,
            inserted: 0,
            hasMore: false,
            messages: []
          };
        }

        const endUid = Math.min(highestUid, startUid + SYNC_BATCH_SIZE - 1);
        const fetched = await client.fetchAll(
          `${startUid}:${endUid}`,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            size: true,
            source: { start: 0, maxLength: MAX_SOURCE_BYTES }
          },
          { uid: true }
        );

        const messages: MessageSummary[] = [];
        const stored: StoredMessageInput[] = [];
        for (const item of fetched) {
          const parsed = item.source
            ? await simpleParser(item.source, {
                skipHtmlToText: true,
                skipTextToHtml: true,
                skipImageLinks: true,
                skipTextLinks: true,
                maxHtmlLengthToParse: 0
              }).catch(() => undefined)
            : undefined;
          const messageId =
            item.envelope?.messageId ||
            parsed?.messageId ||
            `imap:${uidValidity}:${item.uid}`;
          const receivedAtValue = item.internalDate ?? item.envelope?.date ?? parsed?.date;
          const receivedAt = receivedAtValue
            ? new Date(receivedAtValue)
            : undefined;
          const inReplyTo = item.envelope?.inReplyTo || parsed?.inReplyTo;
          const payload: EncryptedMessagePayload = {
            subject: item.envelope?.subject || parsed?.subject || "(无主题)",
            from: addresses(item.envelope?.from),
            to: addresses(item.envelope?.to),
            ...(receivedAt && !Number.isNaN(receivedAt.getTime())
              ? { receivedAt: receivedAt.toISOString() }
              : {}),
            messageId,
            ...(inReplyTo ? { inReplyTo } : {}),
            references: normalizedReferences(parsed?.references),
            textPreview: safePreview(parsed?.text)
          };
          const summary: MessageSummary = {
            id: randomUUID(),
            uid: item.uid,
            ...payload
          };
          messages.push(summary);
          stored.push({
            id: summary.id,
            uid: item.uid,
            uidValidity,
            messageKeyHash: createHash("sha256")
              .update(messageId.trim().toLowerCase())
              .digest("hex"),
            encryptedPayload: this.secretBox.encrypt(payload),
            ...(receivedAt && !Number.isNaN(receivedAt.getTime())
              ? { receivedAt }
              : {})
          });
        }

        const inserted = await this.repository.saveMessagesAndCursor({
          mailboxId: id,
          messages: stored,
          uidValidity,
          lastUid: endUid
        });
        return {
          status: "ok",
          fetched: fetched.length,
          inserted,
          hasMore: endUid < highestUid,
          messages
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      const safeError =
        error instanceof MailboxServiceError
          ? error
          : imapError(error, "IMAP_SYNC_FAILED");
      await this.repository
        .recordSyncFailure(id, safeError.errorCode)
        .catch(() => undefined);
      throw safeError;
    } finally {
      await this.closeImap(client);
    }
  }

  async listMessages(id: string, limit: number): Promise<MessageSummary[]> {
    await this.requireMailbox(id);
    const rows = await this.repository.listMessages(id, limit);
    return rows.map((row) => ({
      id: row.id,
      uid: row.uid,
      ...this.secretBox.decrypt<EncryptedMessagePayload>(row.encryptedPayload)
    }));
  }

  private async requireMailbox(id: string): Promise<StoredMailbox> {
    const row = await this.repository.getMailbox(id);
    if (!row) {
      throw new MailboxServiceError("Mailbox not found", 404, "MAILBOX_NOT_FOUND");
    }
    return row;
  }

  private connectionConfig(row: StoredMailbox): MailboxConnectionConfig {
    return this.secretBox.decrypt<MailboxConnectionConfig>(row.encryptedConfig);
  }

  private toSummary(row: StoredMailbox): MailboxSummary {
    const config = this.connectionConfig(row);
    return {
      id: row.id,
      label: row.label,
      brand: row.brand,
      emailAddress: config.emailAddress,
      senderName: config.senderName,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      imapSecurity: config.imapSecurity,
      enabled: row.enabled,
      ...(row.lastTestAt ? { lastTestAt: row.lastTestAt.toISOString() } : {}),
      ...(row.lastTestStatus ? { lastTestStatus: row.lastTestStatus } : {}),
      ...(row.lastSyncAt ? { lastSyncAt: row.lastSyncAt.toISOString() } : {}),
      ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {})
    };
  }

  private createImapClient(config: MailboxConnectionConfig): ImapFlow {
    return this.imapFactory({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecurity === "tls",
      ...(config.imapSecurity === "starttls" ? { doSTARTTLS: true } : {}),
      auth: {
        user: config.imapUsername,
        pass: config.imapPassword
      },
      logger: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: 2 * 1024 * 1024,
      disableAutoIdle: true
    });
  }

  private async closeImap(client: ImapFlow): Promise<void> {
    try {
      if (client.usable) {
        await client.logout();
      } else {
        client.close();
      }
    } catch {
      client.close();
    }
  }
}
