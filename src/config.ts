export type AppConfig = {
  nodeEnv: string;
  port: number;
  adminToken: string;
  database: {
    url: string;
    ssl: boolean;
  };
  mailboxEncryptionKey: string;
  mailboxInitialSyncLimit: number;
  mailboxSyncIntervalMinutes: number;
  openai: {
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    baseAppToken: string;
    baseTableId: string;
    unmatchedTableId?: string;
  };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error("Boolean environment values must be true or false");
}

function parseSyncLimit(raw: string | undefined): number {
  const limit = Number.parseInt(raw ?? "20", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("MAILBOX_INITIAL_SYNC_LIMIT must be between 1 and 100");
  }
  return limit;
}

function parseSyncInterval(raw: string | undefined): number {
  const minutes = Number.parseInt(raw ?? "2", 10);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error("MAILBOX_SYNC_INTERVAL_MINUTES must be between 1 and 60");
  }
  return minutes;
}

function encryptionKey(env: NodeJS.ProcessEnv): string {
  const value = required(env, "MAILBOX_ENCRYPTION_KEY");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error("MAILBOX_ENCRYPTION_KEY must be valid base64");
  }
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(
      "MAILBOX_ENCRYPTION_KEY must be a base64-encoded 32-byte key"
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adminToken = required(env, "ADMIN_TOKEN");
  if (adminToken.length < 32) {
    throw new Error("ADMIN_TOKEN must contain at least 32 characters");
  }

  const verificationToken = optional(env, "FEISHU_VERIFICATION_TOKEN");
  const encryptKey = optional(env, "FEISHU_ENCRYPT_KEY");
  const unmatchedTableId = optional(env, "FEISHU_UNMATCHED_TABLE_ID");

  return {
    nodeEnv: env.NODE_ENV?.trim() || "development",
    port: parsePort(env.PORT),
    adminToken,
    database: {
      url: required(env, "DATABASE_URL"),
      ssl: parseBoolean(env.DATABASE_SSL, false)
    },
    mailboxEncryptionKey: encryptionKey(env),
    mailboxInitialSyncLimit: parseSyncLimit(env.MAILBOX_INITIAL_SYNC_LIMIT),
    mailboxSyncIntervalMinutes: parseSyncInterval(
      env.MAILBOX_SYNC_INTERVAL_MINUTES
    ),
    openai: {
      apiKey: required(env, "OPENAI_API_KEY"),
      model: optional(env, "OPENAI_MODEL") ?? "gpt-5.6-luna",
      baseUrl: optional(env, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1"
    },
    feishu: {
      appId: required(env, "FEISHU_APP_ID"),
      appSecret: required(env, "FEISHU_APP_SECRET"),
      ...(verificationToken ? { verificationToken } : {}),
      ...(encryptKey ? { encryptKey } : {}),
      baseAppToken: required(env, "FEISHU_BASE_APP_TOKEN"),
      baseTableId: required(env, "FEISHU_BASE_TABLE_ID"),
      ...(unmatchedTableId ? { unmatchedTableId } : {})
    }
  };
}

export function configurationStatus(config: AppConfig): {
  feishuCoreConfigured: boolean;
  callbackSecurityConfigured: boolean;
  mailboxStorageConfigured: boolean;
  unmatchedTableConfigured: boolean;
  openaiConfigured: boolean;
} {
  return {
    feishuCoreConfigured: Boolean(
      config.feishu.appId &&
        config.feishu.appSecret &&
        config.feishu.baseAppToken &&
        config.feishu.baseTableId
    ),
    callbackSecurityConfigured: Boolean(
      config.feishu.verificationToken && config.feishu.encryptKey
    ),
    mailboxStorageConfigured: Boolean(
      config.database.url && config.mailboxEncryptionKey
    ),
    unmatchedTableConfigured: Boolean(config.feishu.unmatchedTableId),
    openaiConfigured: Boolean(
      config.openai.apiKey && config.openai.model && config.openai.baseUrl
    )
  };
}
