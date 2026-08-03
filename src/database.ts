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

export type StoredMessage = {
  id: string;
  uid: number;
  encryptedPayload: string;
  receivedAt?: Date;
  createdAt: Date;
  classification: EmailClassification;
  matchStatus: MatchStatus;
  matchedRecordId?: string;
  baseSyncStatus: BaseSyncStatus;
};

export type DailySummary = {
  total: number;
  matched: number;
  unmatched: number;
  pending: number;
  classifications: Record<EmailClassification, number>;
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
  listMessagesNeedingProcessing(
    mailboxId: string,
    limit: number
  ): Promise<StoredMessage[]>;
  updateMessageClassification(
    messageId: string,
    classification: EmailClassification
  ): Promise<void>;
  updateMessageMatch(
    messageId: string,
    status: MatchStatus,
    matchedRecordId?: string
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
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  id: string;
  uid: string;
  encrypted_payload: string;
  received_at: Date | null;
  created_at: Date;
  classification: EmailClassification;
  match_status: MatchStatus;
  matched_record_id: string | null;
  base_sync_status: BaseSyncStatus;
};

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
        ADD COLUMN IF NOT EXISTS base_sync_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS email_messages_daily_summary_idx
      ON email_messages (received_at DESC, classification, match_status)
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
      `SELECT id, uid, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status
       FROM email_messages
       WHERE mailbox_id = $1
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [mailboxId, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      uid: Number.parseInt(row.uid, 10),
      encryptedPayload: row.encrypted_payload,
      ...(row.received_at ? { receivedAt: row.received_at } : {}),
      createdAt: row.created_at,
      classification: row.classification,
      matchStatus: row.match_status,
      ...(row.matched_record_id ? { matchedRecordId: row.matched_record_id } : {}),
      baseSyncStatus: row.base_sync_status
    }));
  }

  async listMessagesNeedingProcessing(
    mailboxId: string,
    limit: number
  ): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, uid, encrypted_payload, received_at, created_at,
              classification, match_status, matched_record_id, base_sync_status
       FROM email_messages
       WHERE mailbox_id = $1
         AND (classification = 'unknown' OR match_status <> 'matched'
              OR base_sync_status <> 'synced')
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [mailboxId, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      uid: Number.parseInt(row.uid, 10),
      encryptedPayload: row.encrypted_payload,
      ...(row.received_at ? { receivedAt: row.received_at } : {}),
      createdAt: row.created_at,
      classification: row.classification,
      matchStatus: row.match_status,
      ...(row.matched_record_id ? { matchedRecordId: row.matched_record_id } : {}),
      baseSyncStatus: row.base_sync_status
    }));
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
    matchedRecordId?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_messages
       SET match_status = $2, matched_record_id = $3,
           base_sync_status = CASE WHEN $2 = 'matched' THEN 'synced' ELSE 'pending' END
       WHERE id = $1`,
      [messageId, status, matchedRecordId ?? null]
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
      summary[row.match_status] += count;
    }
    return summary;
  }
}
