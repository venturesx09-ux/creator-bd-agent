import assert from "node:assert/strict";
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
