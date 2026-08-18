import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ADMIN_JS } from "../src/admin-assets.js";
import type { AppConfig } from "../src/config.js";
import { FeishuClient } from "../src/feishu-client.js";
import type { MailboxServiceLike } from "../src/mailbox-service.js";

const ADMIN_TOKEN = "test-admin-token-that-is-longer-than-32-chars";

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  adminToken: ADMIN_TOKEN,
  database: {
    url: "postgresql://test:test@localhost:5432/test",
    ssl: false
  },
  mailboxEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
  mailboxInitialSyncLimit: 20,
  mailboxSyncIntervalMinutes: 10,
  openai: {
    apiKey: "test-openai-key",
    model: "gpt-5.6-luna",
    baseUrl: "https://aihubmix.com/v1"
  },
  feishu: {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    verificationToken: "test-verification-token",
    encryptKey: "test-encrypt-key",
    baseAppToken: "test-base-token",
    baseTableId: "test-table-id"
  }
};

const silentLogger = {
  info: (_message?: unknown): void => undefined,
  error: (_message?: unknown): void => undefined
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const CALLBACK_TIMESTAMP = "1785757000";
const CALLBACK_NONCE = "test-nonce";

function callbackHeaders(body: unknown): Record<string, string> {
  const serialized = JSON.stringify(body);
  const signature = createHash("sha256")
    .update(CALLBACK_TIMESTAMP + CALLBACK_NONCE + config.feishu.encryptKey)
    .update(serialized)
    .digest("hex");
  return {
    "x-lark-request-timestamp": CALLBACK_TIMESTAMP,
    "x-lark-request-nonce": CALLBACK_NONCE,
    "x-lark-signature": signature
  };
}

function encryptCallback(payload: unknown): { encrypt: string } {
  const key = createHash("sha256")
    .update(config.feishu.encryptKey ?? "")
    .digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return { encrypt: Buffer.concat([iv, ciphertext]).toString("base64") };
}

describe("health and authentication", () => {
  it("returns a safe health response without secret values", async () => {
    const app = createApp({ config, logger: silentLogger });
    const response = await request(app).get("/health").expect(200);

    assert.equal(response.body.status, "ok");
    assert.equal(response.body.version, "5.5.1");
    assert.equal(response.body.configuration.unmatchedTableConfigured, false);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(config.feishu.appSecret), false);
    assert.equal(serialized.includes(config.adminToken), false);
  });

  it("rejects missing or invalid admin tokens", async () => {
    const app = createApp({ config, logger: silentLogger });
    await request(app)
      .get("/api/test/feishu/base/records")
      .expect(401);
    await request(app)
      .get("/api/test/feishu/base/records")
      .set("authorization", "Bearer wrong-token")
      .expect(403);
  });
});

describe("mailbox admin", () => {
  const mailbox = {
    id: "2b0660a8-c5d9-4b46-a49d-cb9c576ece68",
    label: "Test mailbox",
    brand: "Tripo",
    emailAddress: "test@example.com",
    senderName: "Test",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls" as const,
    enabled: true,
    smtpConfigured: false,
    smtpEnabled: false
  };
  const mailboxService: MailboxServiceLike = {
    listMailboxes: async () => [mailbox],
    createMailbox: async () => mailbox,
    setMailboxEnabled: async (_id, enabled) => ({ ...mailbox, enabled }),
    deleteMailbox: async () => ({ status: "deleted" }),
    testConnection: async () => ({
      status: "ok",
      messagesInInbox: 12,
      nextUid: 13
    }),
    configureSmtp: async () => ({
      ...mailbox,
      smtpConfigured: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecurity: "tls" as const
    }),
    testSmtp: async () => ({ status: "ok" }),
    setSmtpEnabled: async (_id, enabled) => ({
      ...mailbox,
      smtpConfigured: true,
      smtpEnabled: enabled
    }),
    syncMailbox: async () => ({
      status: "ok",
      fetched: 1,
      inserted: 1,
      hasMore: false,
      messages: []
    }),
    listMessages: async () => [],
    analyzeMessage: async (_mailboxId, messageId) => ({
      id: messageId,
      uid: 1,
      subject: "Re: collaboration",
      from: ["Creator <creator@example.com>"],
      fromAddresses: ["creator@example.com"],
      to: ["test@example.com"],
      messageId: "message@example.com",
      references: [],
      textPreview: "Our rate is USD 500.",
      classification: "creator_reply",
      matchStatus: "matched",
      matchedRecordId: "rec_test",
      aiAnalysisStatus: "completed",
      aiBaseSyncStatus: "synced",
      analysis: {
        replyType: "interested_with_quote",
        detectedLanguage: "en",
        summaryZh: "达人感兴趣，报价500美元。",
        quoteOriginalText: "Our rate is USD 500.",
        quoteNormalizedZh: "总价：USD 500",
        quoteItems: [{
          source: "latest_reply",
          quoteType: "total",
          originalText: "Our rate is USD 500.",
          normalizedTextZh: "总价：USD 500",
          amountMin: 500,
          amountMax: 500,
          currency: "USD",
          unit: null,
          packageName: null
        }],
        quotedAmount: 500,
        currency: "USD",
        deliverables: ["1 Reel"],
        timeline: "",
        rightsRequests: [],
        paymentRequests: [],
        riskFlags: [],
        recommendedAction: "review_quote",
        replyDraftZh: "",
        replyDraftEn: ""
      }
    }),
    updateMessageDrafts: async (mailboxId, messageId) =>
      mailboxService.analyzeMessage(mailboxId, messageId),
    sendReply: async (mailboxId, messageId) => ({
      ...(await mailboxService.analyzeMessage(mailboxId, messageId)),
      sendStatus: "sent",
      sentAt: new Date(0).toISOString(),
      sentCopyStatus: "saved",
      sendFeishuSyncStatus: "synced"
    }),
    syncAllEnabled: async () => ({ attempted: 1, succeeded: 1, failed: 0 }),
    getDailySummary: async () => ({
      since: new Date(0).toISOString(), total: 1, matched: 1,
      uniqueMatchedCreators: 1, duplicateMatchedMessages: 0,
      unmatched: 0, pending: 0,
      classifications: {
        creator_reply: 1, automatic_reply: 0, delivery_failure: 0,
        bulk_notification: 0, unknown: 0
      }
    })
  };

  it("serves an admin page without embedding secrets", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    const response = await request(app).get("/admin").expect(200);

    assert.match(response.text, /Creator BD工作台/u);
    assert.equal(response.text.includes(config.adminToken), false);
    assert.equal(response.text.includes(config.feishu.appSecret), false);
    assert.match(
      String(response.headers["content-security-policy"]),
      /default-src 'self'/u
    );
    assert.match(response.text, /全部同步/u);
    assert.match(response.text, /刷新概览/u);
    assert.match(ADMIN_JS, /sessionStorage/u);
    assert.doesNotMatch(ADMIN_JS, /重新分析|正在调用AI分析/u);
    assert.match(ADMIN_JS, /系统正在自动生成中文摘要和报价/u);
    assert.match(ADMIN_JS, /已匹配飞书/u);
    assert.match(ADMIN_JS, /等待匹配/u);
    assert.match(ADMIN_JS, /无需匹配/u);
    assert.match(response.text, /message-filters/u);
    assert.doesNotThrow(() => new Function(ADMIN_JS));
  });

  it("protects and runs manual AI analysis", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    const url = `/api/admin/mailboxes/${mailbox.id}/messages/message_test/analyze`;
    await request(app).post(url).expect(401);
    const response = await request(app)
      .post(url)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    assert.equal(response.body.message.analysis.quotedAmount, 500);
    assert.equal(response.body.message.aiBaseSyncStatus, "synced");
  });

  it("does not expose the retired reply-draft endpoint", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    const url = `/api/admin/mailboxes/${mailbox.id}/messages/message_test/draft`;
    await request(app)
      .put(url)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ draftZh: "你好，感谢你的回复。", translate: true })
      .expect(404);
  });

  it("keeps SMTP configuration but does not expose a send endpoint", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const smtpConfigUrl = `/api/admin/mailboxes/${mailbox.id}/smtp/config`;
    await request(app).post(smtpConfigUrl).expect(401);
    const configured = await request(app)
      .post(smtpConfigUrl)
      .set(auth)
      .send({
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        username: "test@example.com",
        password: "application-password",
        sentFolder: "Sent",
        saveToSent: true,
        signature: "Best, Shark"
      })
      .expect(200);
    assert.equal(configured.body.mailbox.smtpConfigured, true);

    await request(app)
      .post(`/api/admin/mailboxes/${mailbox.id}/smtp/test`)
      .set(auth)
      .expect(200);
    await request(app)
      .patch(`/api/admin/mailboxes/${mailbox.id}/smtp/status`)
      .set(auth)
      .send({ enabled: true })
      .expect(200);

    const sendUrl = `/api/admin/mailboxes/${mailbox.id}/messages/message_test/send`;
    await request(app)
      .post(sendUrl)
      .set(auth)
      .send({
        confirm: true,
        recipient: "creator@example.com",
        draftZh: "你好，感谢回复。",
        draftEn: "Hi, thank you for your reply."
      })
      .expect(404);
  });

  it("protects mailbox APIs and returns only safe mailbox metadata", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    await request(app).get("/api/admin/mailboxes").expect(401);

    const response = await request(app)
      .get("/api/admin/mailboxes")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    assert.equal(response.body.mailboxes[0].emailAddress, "test@example.com");
    assert.equal(JSON.stringify(response.body).includes("imapPassword"), false);
  });

  it("supports protected IMAP test and sync actions", async () => {
    const app = createApp({ config, mailboxService, logger: silentLogger });
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

    const testResponse = await request(app)
      .post(`/api/admin/mailboxes/${mailbox.id}/test`)
      .set(auth)
      .expect(200);
    assert.equal(testResponse.body.messagesInInbox, 12);

    const syncResponse = await request(app)
      .post(`/api/admin/mailboxes/${mailbox.id}/sync`)
      .set(auth)
      .expect(200);
    assert.equal(syncResponse.body.inserted, 1);

    const statusResponse = await request(app)
      .patch(`/api/admin/mailboxes/${mailbox.id}/status`)
      .set(auth)
      .send({ enabled: false })
      .expect(200);
    assert.equal(statusResponse.body.mailbox.enabled, false);

    await request(app)
      .delete(`/api/admin/mailboxes/${mailbox.id}`)
      .set(auth)
      .expect(200);

    const summary = await request(app)
      .get("/api/admin/daily-summary")
      .set(auth)
      .expect(200);
    assert.equal(summary.body.matched, 1);
  });

  it("serves protected Feishu background progress", async () => {
    let refreshRequests = 0;
    const app = createApp({
      config,
      mailboxService,
      logger: silentLogger,
      feishuProgress: {
        snapshot: () => ({
          status: "processing",
          updatedAt: new Date(0).toISOString(),
          activeBatches: 1,
          index: { status: "ready", source: "database", loaded: 11_418, total: 11_418 },
          messages: {
            total: 48, processed: 26, matched: 21, unmatched: 5,
            writebackSucceeded: 21, failed: 0
          }
        })
      },
      feishuIndexRefresher: {
        requestIndexRefresh: () => {
          refreshRequests += 1;
          return { status: "started" };
        }
      }
    });
    await request(app).get("/api/admin/feishu/progress").expect(401);
    const response = await request(app)
      .get("/api/admin/feishu/progress")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    assert.equal(response.body.messages.processed, 26);
    assert.equal(response.body.index.loaded, 11_418);
    await request(app)
      .post("/api/admin/feishu/index/refresh")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(202);
    assert.equal(refreshRequests, 1);
  });
});

describe("Feishu test endpoints", () => {
  it("continues Base pagination when total shows more records", async () => {
    const fetchImpl = async (
      input: string | URL | globalThis.Request
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0, msg: "ok", tenant_access_token: "mock-token", expire: 7200
        });
      }
      if (url.includes("page_token=next-page")) {
        return jsonResponse({
          code: 0, data: {
            items: [{ record_id: "rec_2", fields: {} }],
            has_more: false, total: 2
          }
        });
      }
      return jsonResponse({
        code: 0, data: {
          items: [{ record_id: "rec_1", fields: {} }],
          has_more: false, page_token: "next-page", total: 2
        }
      });
    };
    const client = new FeishuClient({
      config: config.feishu,
      fetchImpl: fetchImpl as typeof fetch
    });
    const records = await client.listAllBaseRecords();
    assert.deepEqual(records.map((record) => record.record_id), ["rec_1", "rec_2"]);
  });

  it("obtains a token and sends a protected group message", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (
      input: string | URL | globalThis.Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "mock-tenant-token",
          expire: 7200
        });
      }
      return jsonResponse({
        code: 0,
        msg: "success",
        data: { message_id: "om_test" }
      });
    };
    const feishuClient = new FeishuClient({
      config: config.feishu,
      fetchImpl: fetchImpl as typeof fetch
    });
    const app = createApp({ config, feishuClient, logger: silentLogger });

    const response = await request(app)
      .post("/api/test/feishu/messages")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ chat_id: "oc_test_chat" })
      .expect(200);

    assert.equal(response.body.status, "sent");
    assert.equal(calls.length, 2);
    const messageHeaders = new Headers(calls[1]?.init?.headers);
    assert.equal(
      messageHeaders.get("authorization"),
      "Bearer mock-tenant-token"
    );
  });

  it("lists Base records", async () => {
    const fetchImpl = async (
      input: string | URL | globalThis.Request
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "mock-token",
          expire: 7200
        });
      }
      return jsonResponse({
        code: 0,
        msg: "success",
        data: { items: [{ record_id: "rec_test", fields: { Name: "Test" } }] }
      });
    };
    const app = createApp({
      config,
      logger: silentLogger,
      feishuClient: new FeishuClient({
        config: config.feishu,
        fetchImpl: fetchImpl as typeof fetch
      })
    });

    const response = await request(app)
      .get("/api/test/feishu/base/records?page_size=10")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    assert.equal(response.body.data.items[0].record_id, "rec_test");
  });

  it("updates a Base record and rejects malformed fields", async () => {
    const requestBodies: unknown[] = [];
    const fetchImpl = async (
      input: string | URL | globalThis.Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "mock-token",
          expire: 7200
        });
      }
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse({
        code: 0,
        msg: "success",
        data: { record: { record_id: "rec_test" } }
      });
    };
    const app = createApp({
      config,
      logger: silentLogger,
      feishuClient: new FeishuClient({
        config: config.feishu,
        fetchImpl: fetchImpl as typeof fetch
      })
    });

    await request(app)
      .patch("/api/test/feishu/base/records/rec_test")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ fields: [] })
      .expect(400);

    await request(app)
      .patch("/api/test/feishu/base/records/rec_test")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ fields: { 系统测试: "读取和更新成功" } })
      .expect(200);

    assert.deepEqual(requestBodies[0], {
      fields: { 系统测试: "读取和更新成功" }
    });
  });

  it("returns a sanitized gateway error for Feishu failures", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({ code: 10001, msg: "permission denied" }, 403);
    const app = createApp({
      config,
      logger: silentLogger,
      feishuClient: new FeishuClient({
        config: config.feishu,
        fetchImpl: fetchImpl as typeof fetch
      })
    });

    const response = await request(app)
      .get("/api/test/feishu/base/records")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(502);

    assert.equal(response.body.error, "feishu_api_error");
    assert.equal(JSON.stringify(response.body).includes(config.feishu.appSecret), false);
  });
});

describe("Feishu event callback", () => {
  it("validates the callback URL challenge", async () => {
    const app = createApp({ config, logger: silentLogger });
    const payload = {
      type: "url_verification",
      token: config.feishu.verificationToken,
      challenge: "challenge-value"
    };
    const body = encryptCallback(payload);

    const response = await request(app)
      .post("/feishu/events")
      .send(body)
      .expect(200);

    assert.deepEqual(response.body, { challenge: "challenge-value" });
  });

  it("rejects a challenge with an invalid verification token", async () => {
    const app = createApp({ config, logger: silentLogger });

    await request(app)
      .post("/feishu/events")
      .send({
        type: "url_verification",
        token: "wrong-verification-token",
        challenge: "challenge-value"
      })
      .expect(403);
  });

  it("rejects formal callbacks with invalid signatures", async () => {
    const app = createApp({ config, logger: silentLogger });
    const body = {
      schema: "2.0",
      header: {
        event_id: "evt_invalid_signature",
        event_type: "unknown.event",
        app_id: config.feishu.appId,
        token: config.feishu.verificationToken
      },
      event: {}
    };

    await request(app)
      .post("/feishu/events")
      .set({
        ...callbackHeaders(body),
        "x-lark-signature": "invalid-signature"
      })
      .send(body)
      .expect(403);
  });

  it("decrypts, replies to a test command, and ignores a duplicate", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (
      input: string | URL | globalThis.Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "mock-token",
          expire: 7200
        });
      }
      return jsonResponse({
        code: 0,
        msg: "success",
        data: { message_id: "om_reply" }
      });
    };
    const pendingTasks: Promise<void>[] = [];
    const app = createApp({
      config,
      logger: silentLogger,
      feishuClient: new FeishuClient({
        config: config.feishu,
        fetchImpl: fetchImpl as typeof fetch
      }),
      scheduleTask: (task) => {
        pendingTasks.push(task());
      }
    });
    const event = {
      schema: "2.0",
      header: {
        event_id: "evt_test_1",
        event_type: "im.message.receive_v1",
        app_id: config.feishu.appId,
        token: config.feishu.verificationToken
      },
      event: {
        sender: { sender_type: "user" },
        message: {
          chat_id: "oc_test_chat",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 测试" })
        }
      }
    };
    const body = encryptCallback(event);

    await request(app)
      .post("/feishu/events")
      .set(callbackHeaders(body))
      .send(body)
      .expect(200, { code: 0 });
    await Promise.all(pendingTasks);

    await request(app)
      .post("/feishu/events")
      .set(callbackHeaders(body))
      .send(body)
      .expect(200, { code: 0 });

    assert.equal(calls.length, 2);
    const sentBody = JSON.parse(String(calls[1]?.init?.body)) as {
      receive_id: string;
      content: string;
    };
    assert.equal(sentBody.receive_id, "oc_test_chat");
    assert.equal(
      JSON.parse(sentBody.content).text,
      "Creator BD Agent运行正常 ✅"
    );
  });
});
