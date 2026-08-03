import type { AppConfig } from "./config.js";

const FEISHU_API_BASE_URL = "https://open.feishu.cn/open-apis";
const REQUEST_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

type TenantTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

type FeishuEnvelope = {
  code?: number;
  msg?: string;
  data?: unknown;
  error?: {
    log_id?: string;
  };
};

export type FeishuBaseRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly feishuCode?: number,
    readonly logId?: string
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export type FeishuClientOptions = {
  config: AppConfig["feishu"];
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class FeishuClient {
  private readonly config: AppConfig["feishu"];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedToken: { value: string; expiresAt: number } | undefined;

  constructor(options: FeishuClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async sendTextMessage(chatId: string, text: string): Promise<unknown> {
    return this.authorizedRequest(
      `/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text })
        })
      }
    );
  }

  async listBaseRecords(options: {
    pageSize: number;
    pageToken?: string;
  }): Promise<unknown> {
    const params = new URLSearchParams({ page_size: String(options.pageSize) });
    if (options.pageToken) {
      params.set("page_token", options.pageToken);
    }

    return this.authorizedRequest(
      `/bitable/v1/apps/${encodeURIComponent(this.config.baseAppToken)}` +
        `/tables/${encodeURIComponent(this.config.baseTableId)}/records?${params}`,
      { method: "GET" }
    );
  }

  async listAllBaseRecords(
    onProgress?: (progress: { loaded: number; total?: number; page: number }) => void
  ): Promise<FeishuBaseRecord[]> {
    const records: FeishuBaseRecord[] = [];
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const response = await this.listBaseRecords({
        pageSize: 500,
        ...(pageToken ? { pageToken } : {})
      }) as {
        data?: {
          items?: FeishuBaseRecord[];
          has_more?: boolean;
          page_token?: string;
          total?: number;
        };
      };
      records.push(...(response.data?.items ?? []));
      onProgress?.({
        loaded: records.length,
        ...(typeof response.data?.total === "number"
          ? { total: response.data.total }
          : {}),
        page: page + 1
      });
      const nextPageToken = response.data?.page_token;
      const total = response.data?.total;
      const totalIndicatesMore =
        typeof total === "number" && records.length < total;
      if (
        (!response.data?.has_more && !totalIndicatesMore) ||
        !nextPageToken ||
        seenPageTokens.has(nextPageToken)
      ) {
        return records;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new FeishuApiError(
      "Feishu Base contains more than the supported 50,000 records",
      502
    );
  }

  async updateBaseRecord(
    recordId: string,
    fields: JsonObject
  ): Promise<unknown> {
    return this.authorizedRequest(
      `/bitable/v1/apps/${encodeURIComponent(this.config.baseAppToken)}` +
        `/tables/${encodeURIComponent(this.config.baseTableId)}` +
        `/records/${encodeURIComponent(recordId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields })
      }
    );
  }

  private async getTenantAccessToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.cachedToken &&
      this.cachedToken.expiresAt - 60_000 > this.now()
    ) {
      return this.cachedToken.value;
    }

    const response = await this.fetchImpl(
      `${FEISHU_API_BASE_URL}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );

    const payload = await this.parseJson<TenantTokenResponse>(response);
    if (
      !response.ok ||
      payload.code !== 0 ||
      !payload.tenant_access_token
    ) {
      throw new FeishuApiError(
        payload.msg || "Failed to obtain Feishu tenant access token",
        response.status,
        payload.code
      );
    }

    const expiresInSeconds = Math.max(payload.expire ?? 7_200, 60);
    this.cachedToken = {
      value: payload.tenant_access_token,
      expiresAt: this.now() + expiresInSeconds * 1_000
    };
    return payload.tenant_access_token;
  }

  private async authorizedRequest(
    path: string,
    init: RequestInit,
    retryOnExpiredToken = true
  ): Promise<unknown> {
    const token = await this.getTenantAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);

    const response = await this.fetchImpl(`${FEISHU_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const payload = await this.parseJson<FeishuEnvelope>(response);

    if (
      retryOnExpiredToken &&
      (response.status === 401 ||
        payload.code === 99991663 ||
        payload.code === 99991668)
    ) {
      this.cachedToken = undefined;
      await this.getTenantAccessToken(true);
      return this.authorizedRequest(path, init, false);
    }

    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      throw new FeishuApiError(
        payload.msg || "Feishu API request failed",
        response.status,
        payload.code,
        payload.error?.log_id
      );
    }

    return payload;
  }

  private async parseJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new FeishuApiError(
        "Feishu API returned a non-JSON response",
        response.status
      );
    }
  }
}
