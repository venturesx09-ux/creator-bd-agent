import { Pool, type PoolClient } from "pg";
import type { AppConfig } from "./config.js";

type Logger = Pick<Console, "error">;

export type StoredMailbox = {
  id: string;
  label: string;
  brand: string;
  enabled: boolean;
  encryptedConfig: string;
  uidValidity?: string;
  lastUid: number;
  lastTestAt?: Date;
  lastTestStatus?: string;
  lastSyncAt?: Date;
  lastErrorCode?: string;
  smtpEnabled: boolean;
  smtpLastTestAt?: Date;
  smtpLastTestStatus?: string;
  smtpLastErrorCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredMessageInput = {
  id: string;
  uid: number;
  uidValidity: string;
  messageKeyHash: string;
  encryptedPayload: string;
  receivedAt?: Date;
  classification: EmailClassification;
};

export type EmailClassification =
  | "creator_reply"
  | "automatic_reply"
  | "delivery_failure"
  | "bulk_notification"
  | "unknown";

export type MatchStatus = "matched" | "unmatched" | "pending";
export type BaseSyncStatus = "pending" | "synced";
export type AiAnalysisStatus =
  | "pending"
  | "completed"
  | "failed"
  | "skipped";
export type AiBaseSyncStatus = "pending" | "synced";
export type SendStatus =
  | "not_ready"
  | "awaiting_confirmation"
  | "sending"
  | "sent"
  | "failed";
export type SentCopyStatus = "not_required" | "pending" | "saved" | "failed";
export type SendFeishuSyncStatus = "not_required" | "pending" | "synced";
export type MatchReason =
  | "email_exact"
  | "subject_creator_id"
  | "history_creator_id"
  | "history_creator_id_missing"
  | "creator_id_not_found"
  | "creator_id_ambiguous";

export type StoredMessage = {
  id: string;
  uid: number;
  uidValidity?: string;
  encryptedPayload: string;
  receivedAt?: Date;
  createdAt: Date;
  classification: EmailClassification;
  matchStatus: MatchStatus;
  matchedRecordId?: string;
  baseSyncStatus: BaseSyncStatus;
  matchReason?: MatchReason;
  unmatchedRecordId?: string;
  aiAnalysisStatus: AiAnalysisStatus;
  encryptedAiAnalysis?: string;
  aiAnalyzedAt?: Date;
  aiErrorCode?: string;
  aiModel?: string;
  aiAnalysisSchemaVersion?: number;
  aiBaseSyncStatus: AiBaseSyncStatus;
  sendStatus: SendStatus;
  sentAt?: Date;
  sentMessageId?: string;
  sendErrorCode?: string;
  sentCopyStatus: SentCopyStatus;
  sendFeishuSyncStatus: SendFeishuSyncStatus;
};

export type DailySummary = {
  total: number;
  matched: number;
  uniqueMatchedCreators: number;
  duplicateMatchedMessages: number;
  unmatched: number;
  pending: number;
  classifications: Record<EmailClassification, number>;
};

export type FeishuEmailIndexEntry = {
  emailHash: string;
  recordId: string;
  cooperationStage: string;
  lastContactAt?: number;
};

export type FeishuCreatorIdIndexEntry = {
  creatorIdHash: string;
  recordId?: string;
  ambiguous: boolean;
  cooperationStage: string;
  lastContactAt?: number;
};

export interface MailboxRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listMailboxes(): Promise<StoredMailbox[]>;
  getMailbox(id: string): Promise<StoredMailbox | undefined>;
  createMailbox(input: {
    id: string;
    label: string;
    brand: string;
    encryptedConfig: string;
  }): Promise<StoredMailbox>;
  setMailboxEnabled(id: string, enabled: boolean): Promise<boolean>;
  saveSmtpConfig(id: string, encryptedConfig: string): Promise<boolean>;
  recordSmtpTest(
    id: string,
    status: "success" | "failed",
    errorCode?: string
  ): Promise<void>;
  setSmtpEnabled(id: string, enabled: boolean): Promise<"updated" | "conflict">;
  deleteMailboxIfEmpty(id: string): Promise<"deleted" | "not_found" | "has_messages">;
  recordConnectionTest(
    id: string,
    status: "success" | "failed",
    errorCode?: string
  ): Promise<void>;
  recordSyncFailure(id: string, errorCode: string): Promise<void>;
  saveMessagesAndCursor(input: {
    mailboxId: string;
    messages: StoredMessageInput[];
    uidValidity: string;
    lastUid: number;
    errorCode?: string;
  }): Promise<number>;
  listMessages(mailboxId: string, limit: number): Promise<StoredMessage[]>;
  listKnownUids(
    mailboxId: string,
    uidValidity: string,
    uids: number[]
  ): Promise<Set<number>>;
  listMessagesNeedingProcessing(
    mailboxId: string,
    limit: number
  ): Promise<StoredMessage[]>;
  listMessagesNeedingContentRefresh(
    mailboxId: string,
    uidValidity: string,
    limit: number
  ): Promise<StoredMessage[]>;
  refreshMessageContent(
    messageId: string,
    encryptedPayload: string,
    classification: EmailClassification
  ): Promise<void>;
  updateMessageClassification(
    messageId: string,
    classification: EmailClassification
  ): Promise<void>;
  updateMessageMatch(
    messageId: string,
    status: MatchStatus,
    matchedRecordId?: string,
    reason?: MatchReason
  ): Promise<void>;
  getUnmatchedRecordId(messageId: string): Promise<string | undefined>;
  setUnmatchedRecordId(messageId: string, recordId: string): Promise<void>;
  getMessage(mailboxId: string, messageId: string): Promise<StoredMessage | undefined>;
  saveMessageAnalysis(
    messageId: string,
    encryptedAnalysis: string,
    model: string
  ): Promise<void>;
  recordMessageAnalysisFailure(messageId: string, errorCode: string): Promise<void>;
  markMessageAnalysisSynced(messageId: string): Promise<void>;
  claimMessageForSend(input: {
    attemptId: string;
    mailboxId: string;
    messageId: string;
    recipientHash: string;
    outboundMessageId: string;
  }): Promise<"claimed" | "not_found" | "already_sent" | "busy">;
  recordMessageSent(input: {
    attemptId: string;
    messageId: string;
    providerMessageId: string;
    sentAt: Date;
    sentCopyStatus: SentCopyStatus;
  }): Promise<void>;
  recordMessageSendFailure(
    attemptId: string,
    messageId: string,
    errorCode: string
  ): Promise<void>;
  markSentCopyStatus(
    messageId: string,
    status: "saved" | "failed"
  ): Promise<void>;
  markMessageSendFeishuSynced(messageId: string): Promise<void>;
  loadFeishuEmailIndex(): Promise<{
    entries: FeishuEmailIndexEntry[];
    refreshedAt?: Date;
  }>;
  replaceFeishuEmailIndex(entries: FeishuEmailIndexEntry[]): Promise<void>;
  loadFeishuCreatorIdIndex(): Promise<FeishuCreatorIdIndexEntry[]>;
  replaceFeishuCreatorIdIndex(entries: FeishuCreatorIdIndexEntry[]): Promise<void>;
  updateFeishuIndexRecord(
    recordId: string,
    cooperationStage: string,
    lastContactAt?: number
  ): Promise<void>;
  getDailySummary(since: Date): Promise<DailySummary>;
}

type MailboxRow = {
  id: string;
  label: string;
  brand: string;
  enabled: boolean;
  encrypted_config: string;
  uid_validity: string | null;
  last_uid: string;
  last_test_at: Date | null;
  last_test_status: string | null;
  last_sync_at: Date | null;
  last_error_code: string | null;
  smtp_enabled: boolean;
  smtp_last_test_at: Date | null;
  smtp_last_test_status: string | null;
  smtp_last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  id: string;
  uid: string;
  uid_validity: string;
  encrypted_payload: string;
  received_at: Date | null;
  created_at: Date;
  classification: EmailClassification;
  match_status: MatchStatus;
  matched_record_id: string | null;
  base_sync_status: BaseSyncStatus;
  match_reason: MatchReason | null;
  unmatched_record_id: string | null;
  ai_analysis_status: AiAnalysisStatus;
  encrypted_ai_analysis: string | null;
  ai_analyzed_at: Date | null;
  ai_error_code: string | null;
  ai_model: string | null;
  ai_analysis_schema_version: number;
  ai_base_sync_status: AiBaseSyncStatus;
  send_status: SendStatus;
  sent_at: Date | null;
  sent_message_id: string | null;
  send_error_code: string | null;
  sent_copy_status: SentCopyStatus;
  send_feishu_sync_status: SendFeishuSyncStatus;
};

function messageFromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    uid: Number.parseInt(row.uid, 10),
    uidValidity: row.uid_validity,
    encryptedPayload: row.encrypted_payload,
    ...(row.received_at ? { receivedAt: row.received_at } : {}),
    createdAt: row.created_at,
    classification: row.classification,
    matchStatus: row.match_status,
    ...(row.matched_record_id ? { matchedRecordId: row.matched_record_id } : {}),
    baseSyncStatus: row.base_sync_status,
    ...(row.match_reason ? { matchReason: row.match_reason } : {}),
    ...(row.unmatched_record_id
      ? { unmatchedRecordId: row.unmatched_record_id }
      : {}),
    aiAnalysisStatus: row.ai_analysis_status,
    ...(row.encrypted_ai_analysis
      ? { encryptedAiAnalysis: row.encrypted_ai_analysis }
      : {}),
    ...(row.ai_analyzed_at ? { aiAnalyzedAt: row.ai_analyzed_at } : {}),
    ...(row.ai_error_code ? { aiErrorCode: row.ai_error_code } : {}),
    ...(row.ai_model ? { aiModel: row.ai_model } : {}),
    aiAnalysisSchemaVersion: row.ai_analysis_schema_version ?? 1,
    aiBaseSyncStatus: row.ai_base_sync_status,
    sendStatus: row.send_status,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    ...(row.sent_message_id ? { sentMessageId: row.sent_message_id } : {}),
    ...(row.send_error_code ? { sendErrorCode: row.send_error_code } : {}),
    sentCopyStatus: row.sent_copy_status,
    sendFeishuSyncStatus: row.send_feishu_sync_status
  };
}

function mailboxFromRow(row: MailboxRow): StoredMailbox {
  return {
    id: row.id,
    label: row.label,
    brand: row.brand,
    enabled: row.enabled,
    encryptedConfig: row.encrypted_config,
    ...(row.uid_validity ? { uidValidity: row.uid_validity } : {}),
    lastUid: Number.parseInt(row.last_uid, 10),
    ...(row.last_test_at ? { lastTestAt: row.last_test_at } : {}),
    ...(row.last_test_status ? { lastTestStatus: row.last_test_status } : {}),
    ...(row.last_sync_at ? { lastSyncAt: row.last_sync_at } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    smtpEnabled: row.smtp_enabled,
    ...(row.smtp_last_test_at ? { smtpLastTestAt: row.smtp_last_test_at } : {}),
    ...(row.smtp_last_test_status
      ? { smtpLastTestStatus: row.smtp_last_test_status }
      : {}),
    ...(row.smtp_last_error_code
      ? { smtpLastErrorCode: row.smtp_last_error_code }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PostgresMailboxRepository implements MailboxRepository {
  private readonly pool: Pool;

  constructor(config: AppConfig["database"], logger: Logger = console) {
    this.pool = new Pool({
      connectionString: config.url,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {})
    });
    this.pool.on("error", () => {
      logger.error(
        JSON.stringify({ event: "database_pool_error", message: "Database error" })
      );
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        id UUID PRIMARY KEY,
        label VARCHAR(80) NOT NULL,
        brand VARCHAR(80) NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        encrypted_config TEXT NOT NULL,
        uid_validity TEXT,
        last_uid BIGINT NOT NULL DEFAULT 0,
        last_test_at TIMESTAMPTZ,
        last_test_status VARCHAR(20),
        last_sync_at TIMESTAMPTZ,
        last_error_code VARCHAR(80),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      ALTER TABLE mailboxes
        ADD COLUMN IF NOT EXISTS smtp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS smtp_last_test_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS smtp_last_test_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS smtp_last_error_code VARCHAR(80)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_one_smtp_pilot_idx
      ON mailboxes ((smtp_enabled)) WHERE smtp_enabled = TRUE
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS email_messages (
        id UUID PRIMARY KEY,
        mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
        uid BIGINT NOT NULL,
        uid_validity TEXT NOT NULL,
        message_key_hash CHAR(64) NOT NULL,
        encrypted_payload TEXT NOT NULL,
        received_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox_id, uid_validity, uid),
        UNIQUE (mailbox_id, message_key_hash)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS email_messages_mailbox_received_idx
      ON email_messages (mailbox_id, received_at DESC, created_at DESC)
    `);
    await this.pool.query(`
      ALTER TABLE email_messages
        ADD COLUMN IF NOT EXISTS classification VARCHAR(40) NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS match_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS matched_record_id VARCHAR(128),
        ADD COLUMN IF NOT EXISTS base_sync_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS match_reason VARCHAR(64),
        ADD COLUMN IF NOT EXISTS unmatched_record_id VARCHAR(128)
    `);
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'email_messages'
            AND column_name = 'ai_analysis_status'
        ) THEN
          ALTER TABLE email_messages
            ADD COLUMN ai_analysis_status VARCHAR(20) NOT NULL DEFAULT 'skipped';
          ALTER TABLE email_messages
            ALTER COLUMN ai_analysis_status SET DEFAULT 'pending';
        END IF;
      END $$
    `);
    await this.pool.query(`
      ALTER TABLE email_messages
        ADD COLUMN IF NOT EXISTS encrypted_ai_analysis TEXT,
        ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS ai_error_code VARCHAR(80),
        ADD COLUMN IF NOT EXISTS ai_model VARCHAR(100),
        ADD COLUMN IF NOT EXISTS ai_analysis_schema_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS ai_base_sync_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    `);
    await this.pool.query(`
      ALTER TABLE email_messages
        ADD COLUMN IF NOT EXISTS send_status VARCHAR(30) NOT NULL DEFAULT 'not_ready',
        ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS sent_message_id VARCHAR(512),
        ADD COLUMN IF NOT EXISTS send_error_code VARCHAR(80),
        ADD COLUMN IF NOT EXISTS sent_copy_status VARCHAR(20) NOT NULL DEFAULT 'not_required',
        ADD COLUMN IF NOT EXISTS send_feishu_sync_status VARCHAR(20) NOT NULL DEFAULT 'not_required'
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS email_send_attempts (
        id UUID PRIMARY KEY,
        message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE RESTRICT,
        mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL,
        recipient_hash CHAR(64) NOT NULL,
        outbound_message_id VARCHAR(512) NOT NULL,
        provider_message_id VARCHAR(512),
        error_code VARCHAR(80),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS email_send_attempts_message_idx
      ON email_send_attempts (message_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS email_messages_daily_summary_idx
      ON email_messages (received_at DESC, classification, match_status)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS feishu_email_index (
        email_hash CHAR(64) PRIMARY KEY,
        record_id VARCHAR(128) NOT NULL,
        cooperation_stage TEXT NOT NULL DEFAULT '',
        last_contact_at BIGINT,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS feishu_email_index_record_idx
      ON feishu_email_index (record_id)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS feishu_creator_id_index (
        creator_id_hash CHAR(64) PRIMARY KEY,
        record_id VARCHAR(128),
        ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
        cooperation_stage TEXT NOT NULL DEFAULT '',
        last_contact_at BIGINT,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS feishu_creator_id_index_record_idx
      ON feishu_creator_id_index (record_id)
    `);
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listMailboxes(): Promise<StoredMailbox[]> {
    const result = await this.pool.query<MailboxRow>(
      "SELECT * FROM mailboxes ORDER BY created_at ASC"
    );
    return result.rows.map(mailboxFromRow);
  }

  async getMailbox(id: string): Promise<StoredMailbox | undefined> {
    const result = await this.pool.query<MailboxRow>(
      "SELECT * FROM mailboxes WHERE id = $1",
      [id]
    );
    const row = result.rows[0];
    return row ? mailboxFromRow(row) : undefined;
  }

  async createMailbox(input: {
    id: string;
    label: string;
    brand: string;
    encryptedConfig: string;
  }): Promise<StoredMailbox> {
    const result = await this.pool.query<MailboxRow>(
      `INSERT INTO mailboxes (id, label, brand, encrypted_config)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.id, input.label, input.brand, input.encryptedConfig]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Mailbox insert failed");
    }
    return mailboxFromRow(row);
  }

  async setMailboxEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE mailboxes SET enabled = $2, updated_at = NOW() WHERE id = $1`,
      [id, enabled]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveSmtpConfig(id: string, encryptedConfig: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE mailboxes
       SET encrypted_config = $2, smtp_enabled = FALSE,
           smtp_last_test_at = NULL, smtp_last_test_status = NULL,
           smtp_last_error_code = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id, encryptedConfig]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordSmtpTest(
    id: string,
    status: "success" | "failed",
    errorCode?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mailboxes
       SET smtp_last_test_at = NOW(), smtp_last_test_status = $2,
           smtp_last_error_code = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, errorCode ?? null]
    );
  }

  async setSmtpEnabled(
    id: string,
    enabled: boolean
  ): Promise<"updated" | "conflict"> {
    try {
      const result = await this.pool.query(
        `UPDATE mailboxes SET smtp_enabled = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, enabled]
      );
      return (result.rowCount ?? 0) > 0 ? "updated" : "conflict";
    } catch (error) {
      const candidate = error as { code?: unknown };
      if (candidate.code === "23505") return "conflict";
      throw error;
    }
  }

  async deleteMailboxIfEmpty(
    id: string
  ): Promise<"deleted" | "not_found" | "has_messages"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const mailbox = await client.query<{ id: string }>(
        "SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!mailbox.rows[0]) {
        await client.query("ROLLBACK");
        return "not_found";
      }
      const messages = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM email_messages WHERE mailbox_id = $1",
        [id]
      );
      if (Number.parseInt(messages.rows[0]?.count ?? "0", 10) > 0) {
        await client.query("ROLLBACK");
        return "has_messages";
      }
      await client.query("DELETE FROM mailboxes WHERE id = $1", [id]);
      await client.query("COMMIT");
      return "deleted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordConnectionTest(
    id: string,
    status: "success" | "failed",
    errorCode?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mailboxes
       SET last_test_at = NOW(), last_test_status = $2,
           last_error_code = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, errorCode ?? null]
    );
  }

  async recordSyncFailure(id: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE mailboxes
       SET last_sync_at = NOW(), last_error_code = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, errorCode]
    );
  }

  async saveMessagesAndCursor(input: {
    mailboxId: string;
    messages: StoredMessageInput[];
    uidValidity: string;
    lastUid: number;
    errorCode?: string;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await this.insertMessages(client, input);
      await client.query(
        `UPDATE mailboxes
         SET uid_validity = $2, last_uid = $3, last_sync_at = NOW(),
             last_error_code = $4, updated_at = NOW()
         WHERE id = $1`,
        [
          input.mailboxId,
          input.uidValidity,
          input.lastUid,
          input.errorCode ?? null
        ]
      );
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertMessages(
    client: PoolClient,
    input: {
      mailboxId: string;
      messages: StoredMessageInput[];
    }
  ): Promise<number> {
    let inserted = 0;
    for (const message of input.messages) {
      const result = await client.query(
        `INSERT INTO email_messages
           (id, mailbox_id, uid, uid_validity, message_key_hash,
            encrypted_payload, received_at, classification)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          message.id,
          input.mailboxId,
          message.uid,
          message.uidValidity,
          message.messageKeyHash,
          message.encryptedPayload,
          message.receivedAt ?? null,
          message.classification
        ]
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }

  async listMessages(mailboxId: string, limit: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, uid, uid_validity, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status,
              match_reason, unmatched_record_id, ai_analysis_status,
              encrypted_ai_analysis, ai_analyzed_at, ai_error_code, ai_model,
              ai_analysis_schema_version,
              ai_base_sync_status, send_status, sent_at, sent_message_id,
              send_error_code, sent_copy_status, send_feishu_sync_status
       FROM email_messages
       WHERE mailbox_id = $1
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [mailboxId, limit]
    );
    return result.rows.map(messageFromRow);
  }

  async getMessage(
    mailboxId: string,
    messageId: string
  ): Promise<StoredMessage | undefined> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, uid, uid_validity, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status,
              match_reason, unmatched_record_id, ai_analysis_status,
              encrypted_ai_analysis, ai_analyzed_at, ai_error_code, ai_model,
              ai_analysis_schema_version,
              ai_base_sync_status, send_status, sent_at, sent_message_id,
              send_error_code, sent_copy_status, send_feishu_sync_status
       FROM email_messages
       WHERE mailbox_id = $1 AND id = $2`,
      [mailboxId, messageId]
    );
    const row = result.rows[0];
    return row ? messageFromRow(row) : undefined;
  }

  async listKnownUids(
    mailboxId: string,
    uidValidity: string,
    uids: number[]
  ): Promise<Set<number>> {
    if (!uids.length) return new Set();
    const result = await this.pool.query<{ uid: string }>(
      `SELECT uid FROM email_messages
       WHERE mailbox_id = $1 AND uid_validity = $2
         AND uid = ANY($3::bigint[])`,
      [mailboxId, uidValidity, uids]
    );
    return new Set(result.rows.map((row) => Number.parseInt(row.uid, 10)));
  }

  async loadFeishuEmailIndex(): Promise<{
    entries: FeishuEmailIndexEntry[];
    refreshedAt?: Date;
  }> {
    const result = await this.pool.query<{
      email_hash: string;
      record_id: string;
      cooperation_stage: string;
      last_contact_at: string | null;
      refreshed_at: Date;
    }>(`SELECT email_hash, record_id, cooperation_stage, last_contact_at, refreshed_at
        FROM feishu_email_index`);
    const refreshedAt = result.rows.reduce<Date | undefined>(
      (latest, row) => !latest || row.refreshed_at > latest ? row.refreshed_at : latest,
      undefined
    );
    return {
      entries: result.rows.map((row) => ({
        emailHash: row.email_hash,
        recordId: row.record_id,
        cooperationStage: row.cooperation_stage,
        ...(row.last_contact_at
          ? { lastContactAt: Number.parseInt(row.last_contact_at, 10) }
          : {})
      })),
      ...(refreshedAt ? { refreshedAt } : {})
    };
  }

  async replaceFeishuEmailIndex(entries: FeishuEmailIndexEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM feishu_email_index");
      for (let offset = 0; offset < entries.length; offset += 500) {
        const batch = entries.slice(offset, offset + 500);
        if (!batch.length) continue;
        const values: unknown[] = [];
        const placeholders = batch.map((entry, index) => {
          const base = index * 4;
          values.push(
            entry.emailHash,
            entry.recordId,
            entry.cooperationStage,
            entry.lastContactAt ?? null
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        });
        await client.query(
          `INSERT INTO feishu_email_index
            (email_hash, record_id, cooperation_stage, last_contact_at)
           VALUES ${placeholders.join(",")}`,
          values
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadFeishuCreatorIdIndex(): Promise<FeishuCreatorIdIndexEntry[]> {
    const result = await this.pool.query<{
      creator_id_hash: string;
      record_id: string | null;
      ambiguous: boolean;
      cooperation_stage: string;
      last_contact_at: string | null;
    }>(`SELECT creator_id_hash, record_id, ambiguous, cooperation_stage,
               last_contact_at
        FROM feishu_creator_id_index`);
    return result.rows.map((row) => ({
      creatorIdHash: row.creator_id_hash,
      ...(row.record_id ? { recordId: row.record_id } : {}),
      ambiguous: row.ambiguous,
      cooperationStage: row.cooperation_stage,
      ...(row.last_contact_at
        ? { lastContactAt: Number.parseInt(row.last_contact_at, 10) }
        : {})
    }));
  }

  async replaceFeishuCreatorIdIndex(
    entries: FeishuCreatorIdIndexEntry[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM feishu_creator_id_index");
      for (let offset = 0; offset < entries.length; offset += 500) {
        const batch = entries.slice(offset, offset + 500);
        if (!batch.length) continue;
        const values: unknown[] = [];
        const placeholders = batch.map((entry, index) => {
          const base = index * 5;
          values.push(
            entry.creatorIdHash,
            entry.recordId ?? null,
            entry.ambiguous,
            entry.cooperationStage,
            entry.lastContactAt ?? null
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        await client.query(
          `INSERT INTO feishu_creator_id_index
            (creator_id_hash, record_id, ambiguous, cooperation_stage, last_contact_at)
           VALUES ${placeholders.join(",")}`,
          values
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateFeishuIndexRecord(
    recordId: string,
    cooperationStage: string,
    lastContactAt?: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE feishu_email_index
       SET cooperation_stage = $2,
           last_contact_at = COALESCE($3, last_contact_at)
       WHERE record_id = $1`,
      [recordId, cooperationStage, lastContactAt ?? null]
    );
    await this.pool.query(
      `UPDATE feishu_creator_id_index
       SET cooperation_stage = $2,
           last_contact_at = COALESCE($3, last_contact_at)
       WHERE record_id = $1`,
      [recordId, cooperationStage, lastContactAt ?? null]
    );
  }

  async listMessagesNeedingProcessing(
    mailboxId: string,
    limit: number
  ): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, uid, uid_validity, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status,
              match_reason, unmatched_record_id, ai_analysis_status,
              encrypted_ai_analysis, ai_analyzed_at, ai_error_code, ai_model,
              ai_analysis_schema_version,
              ai_base_sync_status, send_status, sent_at, sent_message_id,
              send_error_code, sent_copy_status, send_feishu_sync_status
       FROM email_messages
       WHERE mailbox_id = $1
         AND (classification = 'unknown'
              OR (classification = 'creator_reply'
                  AND (match_status <> 'matched'
                       OR base_sync_status <> 'synced'
                       OR ai_analysis_status IN ('pending', 'skipped')
                       OR ai_analysis_schema_version < 2
                       OR (ai_analysis_status = 'failed'
                           AND (ai_analyzed_at IS NULL
                                OR ai_analyzed_at < NOW() - INTERVAL '30 minutes'))
                       OR (send_status = 'sent'
                           AND send_feishu_sync_status = 'pending')
                       OR (matched_record_id IS NOT NULL
                           AND ai_analysis_status = 'completed'
                           AND ai_base_sync_status <> 'synced'))))
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [mailboxId, limit]
    );
    return result.rows.map(messageFromRow);
  }

  async listMessagesNeedingContentRefresh(
    mailboxId: string,
    uidValidity: string,
    limit: number
  ): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, uid, uid_validity, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status,
              match_reason, unmatched_record_id, ai_analysis_status,
              encrypted_ai_analysis, ai_analyzed_at, ai_error_code, ai_model,
              ai_analysis_schema_version,
              ai_base_sync_status, send_status, sent_at, sent_message_id,
              send_error_code, sent_copy_status, send_feishu_sync_status
       FROM email_messages
       WHERE mailbox_id = $1 AND uid_validity = $2
         AND classification = 'creator_reply'
         AND ai_analysis_schema_version < 2
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT $3`,
      [mailboxId, uidValidity, limit]
    );
    return result.rows.map(messageFromRow);
  }

  async refreshMessageContent(
    messageId: string,
    encryptedPayload: string,
    classification: EmailClassification
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET encrypted_payload = $2, classification = $3,
           ai_analysis_status = 'pending', encrypted_ai_analysis = NULL,
           ai_analyzed_at = NULL, ai_error_code = NULL, ai_model = NULL,
           ai_analysis_schema_version = 1, ai_base_sync_status = 'pending',
           send_status = CASE
             WHEN send_status IN ('sending', 'sent') THEN send_status
             ELSE 'not_ready'
           END
       WHERE id = $1`,
      [messageId, encryptedPayload, classification]
    );
  }

  async updateMessageClassification(
    messageId: string,
    classification: EmailClassification
  ): Promise<void> {
    await this.pool.query(
      "UPDATE email_messages SET classification = $2 WHERE id = $1",
      [messageId, classification]
    );
  }

  async updateMessageMatch(
    messageId: string,
    status: MatchStatus,
    matchedRecordId?: string,
    reason?: MatchReason
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET match_status = $2::varchar, matched_record_id = $3,
           match_reason = $4,
           base_sync_status = CASE
             WHEN $2::text = 'matched' THEN 'synced'
             ELSE 'pending'
           END
       WHERE id = $1`,
      [messageId, status, matchedRecordId ?? null, reason ?? null]
    );
  }

  async getUnmatchedRecordId(messageId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ unmatched_record_id: string | null }>(
      "SELECT unmatched_record_id FROM email_messages WHERE id = $1",
      [messageId]
    );
    return result.rows[0]?.unmatched_record_id ?? undefined;
  }

  async setUnmatchedRecordId(
    messageId: string,
    recordId: string
  ): Promise<void> {
    await this.pool.query(
      "UPDATE email_messages SET unmatched_record_id = $2 WHERE id = $1",
      [messageId, recordId]
    );
  }

  async saveMessageAnalysis(
    messageId: string,
    encryptedAnalysis: string,
    model: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET ai_analysis_status = 'completed', encrypted_ai_analysis = $2,
           ai_analyzed_at = NOW(), ai_error_code = NULL, ai_model = $3,
           ai_analysis_schema_version = 2,
           ai_base_sync_status = 'pending',
           send_status = CASE
             WHEN send_status IN ('sending', 'sent') THEN send_status
             ELSE 'awaiting_confirmation'
           END,
           send_error_code = CASE
             WHEN send_status IN ('sending', 'sent') THEN send_error_code
             ELSE NULL
           END
       WHERE id = $1`,
      [messageId, encryptedAnalysis, model]
    );
  }

  async recordMessageAnalysisFailure(
    messageId: string,
    errorCode: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET ai_analysis_status = 'failed', ai_error_code = $2,
           ai_analyzed_at = NOW()
       WHERE id = $1`,
      [messageId, errorCode]
    );
  }

  async markMessageAnalysisSynced(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages SET ai_base_sync_status = 'synced' WHERE id = $1`,
      [messageId]
    );
  }

  async claimMessageForSend(input: {
    attemptId: string;
    mailboxId: string;
    messageId: string;
    recipientHash: string;
    outboundMessageId: string;
  }): Promise<"claimed" | "not_found" | "already_sent" | "busy"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        send_status: SendStatus;
        classification: EmailClassification;
      }>(
        `SELECT send_status, classification FROM email_messages
         WHERE id = $1 AND mailbox_id = $2 FOR UPDATE`,
        [input.messageId, input.mailboxId]
      );
      const row = current.rows[0];
      if (!row || row.classification !== "creator_reply") {
        await client.query("ROLLBACK");
        return "not_found";
      }
      if (row.send_status === "sent") {
        await client.query("ROLLBACK");
        return "already_sent";
      }
      if (row.send_status === "sending") {
        await client.query("ROLLBACK");
        return "busy";
      }
      await client.query(
        `UPDATE email_messages
         SET send_status = 'sending', send_error_code = NULL,
             sent_message_id = $2
         WHERE id = $1`,
        [input.messageId, input.outboundMessageId]
      );
      await client.query(
        `INSERT INTO email_send_attempts
           (id, message_id, mailbox_id, status, recipient_hash,
            outbound_message_id)
         VALUES ($1, $2, $3, 'sending', $4, $5)`,
        [
          input.attemptId,
          input.messageId,
          input.mailboxId,
          input.recipientHash,
          input.outboundMessageId
        ]
      );
      await client.query("COMMIT");
      return "claimed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMessageSent(input: {
    attemptId: string;
    messageId: string;
    providerMessageId: string;
    sentAt: Date;
    sentCopyStatus: SentCopyStatus;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE email_messages
         SET send_status = 'sent', sent_at = $2, sent_message_id = $3,
             send_error_code = NULL, sent_copy_status = $4,
             send_feishu_sync_status = CASE
               WHEN matched_record_id IS NULL THEN 'not_required'
               ELSE 'pending'
             END
         WHERE id = $1`,
        [
          input.messageId,
          input.sentAt,
          input.providerMessageId,
          input.sentCopyStatus
        ]
      );
      await client.query(
        `UPDATE email_send_attempts
         SET status = 'sent', provider_message_id = $2,
             error_code = NULL, finished_at = $3
         WHERE id = $1`,
        [input.attemptId, input.providerMessageId, input.sentAt]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMessageSendFailure(
    attemptId: string,
    messageId: string,
    errorCode: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE email_messages
         SET send_status = 'failed', send_error_code = $2
         WHERE id = $1 AND send_status = 'sending'`,
        [messageId, errorCode]
      );
      await client.query(
        `UPDATE email_send_attempts
         SET status = 'failed', error_code = $2, finished_at = NOW()
         WHERE id = $1`,
        [attemptId, errorCode]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSentCopyStatus(
    messageId: string,
    status: "saved" | "failed"
  ): Promise<void> {
    await this.pool.query(
      "UPDATE email_messages SET sent_copy_status = $2 WHERE id = $1",
      [messageId, status]
    );
  }

  async markMessageSendFeishuSynced(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET send_feishu_sync_status = 'synced' WHERE id = $1`,
      [messageId]
    );
  }

  async getDailySummary(since: Date): Promise<DailySummary> {
    const result = await this.pool.query<{
      classification: EmailClassification;
      match_status: MatchStatus;
      count: string;
    }>(
      `SELECT classification, match_status, COUNT(*) AS count
       FROM email_messages
       WHERE COALESCE(received_at, created_at) >= $1
       GROUP BY classification, match_status`,
      [since]
    );
    const summary: DailySummary = {
      total: 0,
      matched: 0,
      uniqueMatchedCreators: 0,
      duplicateMatchedMessages: 0,
      unmatched: 0,
      pending: 0,
      classifications: {
        creator_reply: 0,
        automatic_reply: 0,
        delivery_failure: 0,
        bulk_notification: 0,
        unknown: 0
      }
    };
    for (const row of result.rows) {
      const count = Number.parseInt(row.count, 10);
      summary.total += count;
      summary.classifications[row.classification] += count;
      if (row.classification === "creator_reply") {
        summary[row.match_status] += count;
      }
    }
    const distinct = await this.pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT matched_record_id) AS count
       FROM email_messages
       WHERE COALESCE(received_at, created_at) >= $1
         AND match_status = 'matched'
         AND classification = 'creator_reply'
         AND matched_record_id IS NOT NULL`,
      [since]
    );
    summary.uniqueMatchedCreators = Number.parseInt(
      distinct.rows[0]?.count ?? "0",
      10
    );
    summary.duplicateMatchedMessages = Math.max(
      0,
      summary.matched - summary.uniqueMatchedCreators
    );
    return summary;
  }
}
