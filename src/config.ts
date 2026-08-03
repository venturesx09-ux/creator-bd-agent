export type AppConfig = {
  nodeEnv: string;
  port: number;
  adminToken: string;
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    baseAppToken: string;
    baseTableId: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adminToken = required(env, "ADMIN_TOKEN");
  if (adminToken.length < 32) {
    throw new Error("ADMIN_TOKEN must contain at least 32 characters");
  }

  const verificationToken = optional(env, "FEISHU_VERIFICATION_TOKEN");
  const encryptKey = optional(env, "FEISHU_ENCRYPT_KEY");

  return {
    nodeEnv: env.NODE_ENV?.trim() || "development",
    port: parsePort(env.PORT),
    adminToken,
    feishu: {
      appId: required(env, "FEISHU_APP_ID"),
      appSecret: required(env, "FEISHU_APP_SECRET"),
      ...(verificationToken ? { verificationToken } : {}),
      ...(encryptKey ? { encryptKey } : {}),
      baseAppToken: required(env, "FEISHU_BASE_APP_TOKEN"),
      baseTableId: required(env, "FEISHU_BASE_TABLE_ID")
    }
  };
}

export function configurationStatus(config: AppConfig): {
  feishuCoreConfigured: boolean;
  callbackSecurityConfigured: boolean;
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
    )
  };
}
