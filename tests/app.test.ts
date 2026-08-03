import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { FeishuClient } from "../src/feishu-client.js";

const ADMIN_TOKEN = "test-admin-token-that-is-longer-than-32-chars";

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  adminToken: ADMIN_TOKEN,
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

describe("Feishu test endpoints", () => {
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
    const body = {
      type: "url_verification",
      token: config.feishu.verificationToken,
      challenge: "challenge-value"
    };

    const response = await request(app)
      .post("/feishu/events")
      .set(callbackHeaders(body))
      .send(body)
      .expect(200);

    assert.deepEqual(response.body, { challenge: "challenge-value" });
  });

  it("rejects callbacks with invalid signatures", async () => {
    const app = createApp({ config, logger: silentLogger });
    const body = {
      type: "url_verification",
      token: config.feishu.verificationToken,
      challenge: "challenge-value"
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
