import { createHash, randomUUID } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import type {
  DailySummary,
  EmailClassification,
  AiAnalysisStatus,
  AiBaseSyncStatus,
  MatchReason,
  MailboxRepository,
  StoredMailbox,
  StoredMessageInput
} from "./database.js";
import { EmailAnalysisSchema, type EmailAnalysis } from "./email-analysis.js";
import type { EmailAnalysisProcessor } from "./email-analysis-processor.js";
import { SecretBox } from "./secret-box.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const SYNC_BATCH_SIZE = 100;
const UNREAD_BACKFILL_LIMIT = 200;
const BACKFILL_BATCH_SIZE = 500;
const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/giu;

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
  fromAddresses: string[];
  to: string[];
  receivedAt?: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  textPreview: string;
  classification: EmailClassification;
  matchStatus: "matched" | "unmatched" | "pending";
  matchedRecordId?: string;
  matchReason?: MatchReason;
  mailboxLabel?: string;
  mailboxEmail?: string;
  project?: string;
  aiAnalysisStatus?: AiAnalysisStatus;
  analysis?: EmailAnalysis;
  aiAnalyzedAt?: string;
  aiErrorCode?: string;
  aiModel?: string;
  aiBaseSyncStatus?: AiBaseSyncStatus;
};

type EncryptedMessagePayload = Omit<MessageSummary, "id" | "uid">;
type LegacyEncryptedMessagePayload = Partial<EncryptedMessagePayload> & {
  subject?: string;
  from?: string[];
  to?: string[];
  messageId?: string;
  references?: string[];
  textPreview?: string;
};

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
  setMailboxEnabled(id: string, enabled: boolean): Promise<MailboxSummary>;
  deleteMailbox(id: string): Promise<{ status: "deleted" }>;
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
  analyzeMessage(id: string, messageId: string): Promise<MessageSummary>;
  syncAllEnabled(): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
  }>;
  getDailySummary(): Promise<DailySummary & { since: string }>;
}

export interface CreatorMatcher {
  matchMessages(messages: MessageSummary[]): Promise<void>;
}

export function mergeSyncUids(
  incrementalUids: number[],
  unseenUids: number[],
  knownUnseenUids: ReadonlySet<number>
): number[] {
  return [...new Set([
    ...incrementalUids,
    ...unseenUids.filter((uid) => !knownUnseenUids.has(uid))
  ])].sort((left, right) => left - right);
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

function rawAddresses(
  values: Array<{ address?: string }> | undefined
): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => value.address?.trim().toLowerCase() ?? "")
      .filter(Boolean)
  )].slice(0, 50);
}

function addressesFromFormatted(values: string[] | undefined): string[] {
  const output = new Set<string>();
  for (const value of values ?? []) {
    for (const match of value.matchAll(EMAIL_ADDRESS_PATTERN)) {
      output.add(match[0].toLowerCase());
    }
  }
  return [...output].slice(0, 50);
}

function headerValue(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.join(" ").toLowerCase();
  return value === undefined || value === null ? "" : String(value).toLowerCase();
}

export function classifyEmail(input: {
  subject: string;
  fromAddresses: string[];
  autoSubmitted?: unknown;
  precedence?: unknown;
  listId?: unknown;
}): EmailClassification {
  const subject = input.subject.toLowerCase();
  const senders = input.fromAddresses.join(" ").toLowerCase();
  if (
    /mailer-daemon|postmaster/u.test(senders) ||
    /undeliverable|delivery status notification|delivery failure|returned mail|邮件投递失败|退信/u.test(subject)
  ) {
    return "delivery_failure";
  }
  const autoSubmitted = headerValue(input.autoSubmitted);
  if (
    (autoSubmitted && autoSubmitted !== "no") ||
    /automatic reply|auto reply|out of office|autoreply|自动回复|外出回复/u.test(subject)
  ) {
    return "automatic_reply";
  }
  const precedence = headerValue(input.precedence);
  if (
    /bulk|list|junk/u.test(precedence) ||
    Boolean(input.listId) ||
    /(^|[._-])no-?reply@|(^|[._-])notifications?@/u.test(senders)
  ) {
    return "bulk_notification";
  }
  return input.fromAddresses.length ? "creator_reply" : "unknown";
}

export function messagesNeedingMatch(
  messages: MessageSummary[]
): MessageSummary[] {
  return messages.filter((message) => message.matchStatus !== "matched");
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
    .slice(0, 12_000);
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
  private readonly reprocessJobs = new Map<string, Promise<void>>();
  private readonly reprocessAgain = new Set<string>();

  constructor(
    private readonly repository: MailboxRepository,
    private readonly secretBox: SecretBox,
    private readonly initialSyncLimit: number,
    private readonly imapFactory: ImapFactory = (options) => new ImapFlow(options),
    private readonly creatorMatcher?: CreatorMatcher,
    private readonly analysisProcessor?: EmailAnalysisProcessor
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

  async setMailboxEnabled(id: string, enabled: boolean): Promise<MailboxSummary> {
    await this.requireMailbox(id);
    const updated = await this.repository.setMailboxEnabled(id, enabled);
    if (!updated) {
      throw new MailboxServiceError("Mailbox not found", 404, "MAILBOX_NOT_FOUND");
    }
    return this.toSummary(await this.requireMailbox(id));
  }

  async deleteMailbox(id: string): Promise<{ status: "deleted" }> {
    const result = await this.repository.deleteMailboxIfEmpty(id);
    if (result === "not_found") {
      throw new MailboxServiceError("Mailbox not found", 404, "MAILBOX_NOT_FOUND");
    }
    if (result === "has_messages") {
      throw new MailboxServiceError(
        "This mailbox contains synced messages. Disable it instead of deleting it.",
        409,
        "MAILBOX_HAS_MESSAGES"
      );
    }
    return { status: "deleted" };
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
    if (!row.enabled) {
      throw new MailboxServiceError("Mailbox is disabled", 409, "MAILBOX_DISABLED");
    }
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

        const endUid = startUid <= highestUid
          ? Math.min(highestUid, startUid + SYNC_BATCH_SIZE - 1)
          : undefined;
        const incrementalUids = endUid === undefined
          ? []
          : Array.from(
              { length: endUid - startUid + 1 },
              (_, index) => startUid + index
            );
        const unseenSearch = await client.search(
          { seen: false },
          { uid: true }
        );
        const unseenUids = (unseenSearch === false ? [] : unseenSearch)
          .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
          .slice(-UNREAD_BACKFILL_LIMIT);
        const knownUnseenUids = await this.repository.listKnownUids(
          id,
          uidValidity,
          unseenUids
        );
        const syncUids = mergeSyncUids(
          incrementalUids,
          unseenUids,
          knownUnseenUids
        );

        if (syncUids.length === 0) {
          await this.repository.saveMessagesAndCursor({
            mailboxId: id,
            messages: [],
            uidValidity,
            lastUid: highestUid
          });
          this.scheduleReprocess(id);
          return {
            status: "ok",
            fetched: 0,
            inserted: 0,
            hasMore: false,
            messages: []
          };
        }

        const fetched = await client.fetchAll(
          syncUids.join(","),
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
            fromAddresses: rawAddresses(item.envelope?.from),
            to: addresses(item.envelope?.to),
            ...(receivedAt && !Number.isNaN(receivedAt.getTime())
              ? { receivedAt: receivedAt.toISOString() }
              : {}),
            messageId,
            ...(inReplyTo ? { inReplyTo } : {}),
            references: normalizedReferences(parsed?.references),
            textPreview: safePreview(parsed?.text),
            classification: classifyEmail({
              subject: item.envelope?.subject || parsed?.subject || "(无主题)",
              fromAddresses: rawAddresses(item.envelope?.from),
              autoSubmitted: parsed?.headers.get("auto-submitted"),
              precedence: parsed?.headers.get("precedence"),
              listId: parsed?.headers.get("list-id")
            }),
            matchStatus: "pending"
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
            classification: payload.classification,
            ...(receivedAt && !Number.isNaN(receivedAt.getTime())
              ? { receivedAt }
              : {})
          });
        }

        const inserted = await this.repository.saveMessagesAndCursor({
          mailboxId: id,
          messages: stored,
          uidValidity,
          lastUid: endUid ?? highestUid
        });
        this.scheduleReprocess(id);
        return {
          status: "ok",
          fetched: fetched.length,
          inserted,
          hasMore: endUid !== undefined && endUid < highestUid,
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
    return rows.map((row) => this.messageFromStored(row));
  }

  async analyzeMessage(id: string, messageId: string): Promise<MessageSummary> {
    const mailbox = await this.requireMailbox(id);
    const row = await this.repository.getMessage(id, messageId);
    if (!row) {
      throw new MailboxServiceError("Message not found", 404, "MESSAGE_NOT_FOUND");
    }
    if (row.classification !== "creator_reply") {
      throw new MailboxServiceError(
        "Only creator replies can be analyzed",
        409,
        "MESSAGE_NOT_ANALYZABLE"
      );
    }
    if (!this.analysisProcessor) {
      throw new MailboxServiceError(
        "AI analysis service is unavailable",
        503,
        "AI_ANALYSIS_UNAVAILABLE"
      );
    }
    const connection = this.connectionConfig(mailbox);
    const message: MessageSummary = {
      ...this.messageFromStored(row),
      mailboxLabel: mailbox.label,
      mailboxEmail: connection.emailAddress,
      project: mailbox.brand
    };
    try {
      await this.analysisProcessor.process(message, true);
      return message;
    } catch (error) {
      throw new MailboxServiceError(
        "AI analysis failed. Please try again later.",
        502,
        error instanceof Error ? error.message : "OPENAI_ANALYSIS_FAILED"
      );
    }
  }

  private messageFromStored(row: import("./database.js").StoredMessage): MessageSummary {
    const payload = this.secretBox.decrypt<LegacyEncryptedMessagePayload>(
      row.encryptedPayload
    );
    const from = payload.from ?? [];
    const fromAddresses = payload.fromAddresses?.length
      ? payload.fromAddresses
      : addressesFromFormatted(from);
    let analysis: EmailAnalysis | undefined;
    if (row.encryptedAiAnalysis) {
      try {
        const parsed = EmailAnalysisSchema.safeParse(
          this.secretBox.decrypt<unknown>(row.encryptedAiAnalysis)
        );
        if (parsed.success) analysis = parsed.data;
      } catch {
        analysis = undefined;
      }
    }
    return {
      id: row.id,
      uid: row.uid,
      subject: payload.subject || "(无主题)",
      from,
      fromAddresses,
      to: payload.to ?? [],
      ...(payload.receivedAt ? { receivedAt: payload.receivedAt } : {}),
      messageId: payload.messageId || `stored:${row.id}`,
      ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
      references: payload.references ?? [],
      textPreview: payload.textPreview ?? "",
      classification: row.classification,
      matchStatus: row.baseSyncStatus === "synced" ? row.matchStatus : "pending",
      ...(row.matchedRecordId ? { matchedRecordId: row.matchedRecordId } : {}),
      ...(row.matchReason ? { matchReason: row.matchReason } : {}),
      aiAnalysisStatus: row.aiAnalysisStatus,
      ...(analysis ? { analysis } : {}),
      ...(row.aiAnalyzedAt
        ? { aiAnalyzedAt: row.aiAnalyzedAt.toISOString() }
        : {}),
      ...(row.aiErrorCode ? { aiErrorCode: row.aiErrorCode } : {}),
      ...(row.aiModel ? { aiModel: row.aiModel } : {}),
      aiBaseSyncStatus: row.aiBaseSyncStatus
    };
  }

  private async reprocessStoredMessages(mailboxId: string): Promise<void> {
    const mailbox = await this.requireMailbox(mailboxId);
    const connection = this.connectionConfig(mailbox);
    const rows = await this.repository.listMessagesNeedingProcessing(
      mailboxId,
      BACKFILL_BATCH_SIZE
    );
    const messages = rows.map((row) => ({
      ...this.messageFromStored(row),
      mailboxLabel: mailbox.label,
      mailboxEmail: connection.emailAddress,
      project: mailbox.brand
    }));
    for (const message of messages) {
      if (message.classification === "unknown") {
        message.classification = classifyEmail({
          subject: message.subject,
          fromAddresses: message.fromAddresses
        });
        await this.repository.updateMessageClassification(
          message.id,
          message.classification
        );
      }
    }
    const candidates = messagesNeedingMatch(messages);
    if (this.creatorMatcher && candidates.length) {
      await this.creatorMatcher.matchMessages(candidates);
    }
    if (this.analysisProcessor) {
      for (const message of messages) {
        const shouldAnalyze =
          message.classification === "creator_reply" &&
          (message.aiAnalysisStatus === "pending" ||
            (message.aiAnalysisStatus === "completed" &&
              message.matchedRecordId !== undefined &&
              message.aiBaseSyncStatus !== "synced"));
        if (!shouldAnalyze) continue;
        try {
          await this.analysisProcessor.process(message);
        } catch (error) {
          console.error(JSON.stringify({
            event: "mailbox_background_ai_failed",
            mailboxId,
            messageId: message.id,
            code: error instanceof Error ? error.message : "OPENAI_ANALYSIS_FAILED"
          }));
        }
      }
    }
  }

  private scheduleReprocess(mailboxId: string): void {
    if (this.reprocessJobs.has(mailboxId)) {
      this.reprocessAgain.add(mailboxId);
      return;
    }
    const job = this.reprocessStoredMessages(mailboxId)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "mailbox_background_match_failed",
          mailboxId,
          message: error instanceof Error ? error.message : "Internal error"
        }));
      })
      .finally(() => {
        this.reprocessJobs.delete(mailboxId);
        if (this.reprocessAgain.delete(mailboxId)) {
          this.scheduleReprocess(mailboxId);
        }
      });
    this.reprocessJobs.set(mailboxId, job);
  }

  async syncAllEnabled(): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
  }> {
    const mailboxes = (await this.repository.listMailboxes()).filter((row) => row.enabled);
    let succeeded = 0;
    let failed = 0;
    for (const mailbox of mailboxes) {
      try {
        let hasMore = true;
        while (hasMore) {
          const result = await this.syncMailbox(mailbox.id);
          hasMore = result.hasMore;
        }
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted: mailboxes.length, succeeded, failed };
  }

  async getDailySummary(): Promise<DailySummary & { since: string }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    return { ...(await this.repository.getDailySummary(since)), since: since.toISOString() };
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
