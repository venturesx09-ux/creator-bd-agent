import { timingSafeEqual } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import {
  configurationStatus,
  type AppConfig
} from "./config.js";
import { FeishuApiError, FeishuClient } from "./feishu-client.js";
import {
  EventDeduplicator,
  FeishuCallbackError,
  parseFeishuCallback,
  verifyFeishuSignature
} from "./feishu-events.js";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./admin-assets.js";
import type { FeishuProcessingProgress } from "./feishu-progress.js";
import {
  MailboxServiceError,
  type MailboxServiceLike
} from "./mailbox-service.js";

type Logger = Pick<Console, "info" | "error">;
type RequestWithRawBody = Request & { rawBody?: Buffer };

export type CreateAppOptions = {
  config: AppConfig;
  feishuClient?: FeishuClient;
  logger?: Logger;
  eventDeduplicator?: EventDeduplicator;
  scheduleTask?: (task: () => Promise<void>) => void;
  mailboxService?: MailboxServiceLike;
  feishuProgress?: { snapshot(): FeishuProcessingProgress };
  feishuIndexRefresher?: {
    requestIndexRefresh(): { status: "started" | "already_running" };
  };
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function bearerToken(request: Request): string | undefined {
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length).trim() || undefined;
}

function requireAdminToken(config: AppConfig): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const providedToken = bearerToken(request);
    if (!providedToken) {
      response.status(401).json({
        error: "unauthorized",
        message: "Authorization: Bearer <ADMIN_TOKEN> is required"
      });
      return;
    }
    if (!safeEqual(providedToken, config.adminToken)) {
      response.status(403).json({
        error: "forbidden",
        message: "Invalid admin token"
      });
      return;
    }
    next();
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function createApp(options: CreateAppOptions): express.Express {
  const { config } = options;
  const logger = options.logger ?? console;
  const feishuClient =
    options.feishuClient ?? new FeishuClient({ config: config.feishu });
  const eventDeduplicator =
    options.eventDeduplicator ?? new EventDeduplicator();
  const scheduleTask =
    options.scheduleTask ?? ((task: () => Promise<void>) => void task());
  const mailboxService = options.mailboxService;
  const app = express();

  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: "64kb",
      strict: true,
      verify: (request, _response, buffer) => {
        (request as RequestWithRawBody).rawBody = Buffer.from(buffer);
      }
    })
  );

  app.use((request, response, next) => {
    const startedAt = Date.now();
    response.on("finish", () => {
      logger.info(
        JSON.stringify({
          event: "http_request",
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Date.now() - startedAt
        })
      );
    });
    next();
  });

  app.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: "creator-bd-agent",
      version: "3.3.0",
      timestamp: new Date().toISOString(),
      configuration: configurationStatus(config)
    });
  });

  const adminOnly = requireAdminToken(config);

  const adminHeaders = (response: Response, contentType: string): void => {
    response.set({
      "content-type": contentType,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; " +
        "frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
  };

  app.get("/admin", (_request, response) => {
    adminHeaders(response, "text/html; charset=utf-8");
    response.status(200).send(ADMIN_HTML);
  });

  app.get("/admin/styles.css", (_request, response) => {
    adminHeaders(response, "text/css; charset=utf-8");
    response.status(200).send(ADMIN_CSS);
  });

  app.get("/admin/app.js", (_request, response) => {
    adminHeaders(response, "text/javascript; charset=utf-8");
    response.status(200).send(ADMIN_JS);
  });

  const requireMailboxService = (): MailboxServiceLike => {
    if (!mailboxService) {
      throw new MailboxServiceError(
        "Mailbox service is unavailable",
        503,
        "MAILBOX_SERVICE_UNAVAILABLE"
      );
    }
    return mailboxService;
  };

  app.get("/api/admin/mailboxes", adminOnly, async (_request, response, next) => {
    try {
      const mailboxes = await requireMailboxService().listMailboxes();
      response.status(200).json({ mailboxes });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/mailboxes", adminOnly, async (request, response, next) => {
    try {
      const mailbox = await requireMailboxService().createMailbox(
        request.body as unknown
      );
      response.status(201).json({ mailbox });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/admin/mailboxes/:mailboxId/test",
    adminOnly,
    async (request, response, next) => {
      try {
        const mailboxId = request.params.mailboxId;
        if (!validIdentifier(mailboxId, 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "mailboxId is invalid"
          });
          return;
        }
        const result = await requireMailboxService().testConnection(mailboxId);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/mailboxes/:mailboxId/status",
    adminOnly,
    async (request, response, next) => {
      try {
        const mailboxId = request.params.mailboxId;
        if (!validIdentifier(mailboxId, 128)) {
          response.status(400).json({ error: "invalid_request", message: "mailboxId is invalid" });
          return;
        }
        const body = request.body as unknown;
        if (!isPlainObject(body) || typeof body.enabled !== "boolean") {
          response.status(400).json({
            error: "invalid_request",
            message: "Request body must be { enabled: boolean }"
          });
          return;
        }
        const mailbox = await requireMailboxService().setMailboxEnabled(
          mailboxId,
          body.enabled
        );
        response.status(200).json({ mailbox });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/mailboxes/:mailboxId",
    adminOnly,
    async (request, response, next) => {
      try {
        const mailboxId = request.params.mailboxId;
        if (!validIdentifier(mailboxId, 128)) {
          response.status(400).json({ error: "invalid_request", message: "mailboxId is invalid" });
          return;
        }
        const result = await requireMailboxService().deleteMailbox(mailboxId);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/daily-summary",
    adminOnly,
    async (_request, response, next) => {
      try {
        response.status(200).json(await requireMailboxService().getDailySummary());
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/feishu/progress",
    adminOnly,
    (_request, response) => {
      response.status(200).json(
        options.feishuProgress?.snapshot() ?? {
          status: "idle",
          updatedAt: new Date().toISOString(),
          activeBatches: 0,
          index: { status: "idle", loaded: 0 },
          messages: {
            total: 0,
            processed: 0,
            matched: 0,
            unmatched: 0,
            writebackSucceeded: 0,
            failed: 0
          }
        }
      );
    }
  );

  app.post(
    "/api/admin/feishu/index/refresh",
    adminOnly,
    (_request, response) => {
      if (!options.feishuIndexRefresher) {
        response.status(503).json({
          error: "index_refresher_unavailable",
          message: "Feishu index refresher is unavailable"
        });
        return;
      }
      const result = options.feishuIndexRefresher.requestIndexRefresh();
      response.status(result.status === "started" ? 202 : 200).json(result);
    }
  );

  app.post(
    "/api/admin/mailboxes/:mailboxId/sync",
    adminOnly,
    async (request, response, next) => {
      try {
        const mailboxId = request.params.mailboxId;
        if (!validIdentifier(mailboxId, 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "mailboxId is invalid"
          });
          return;
        }
        const result = await requireMailboxService().syncMailbox(mailboxId);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/mailboxes/:mailboxId/messages",
    adminOnly,
    async (request, response, next) => {
      try {
        const mailboxId = request.params.mailboxId;
        if (!validIdentifier(mailboxId, 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "mailboxId is invalid"
          });
          return;
        }
        const limit = Number.parseInt(
          typeof request.query.limit === "string" ? request.query.limit : "20",
          10
        );
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          response.status(400).json({
            error: "invalid_request",
            message: "limit must be between 1 and 100"
          });
          return;
        }
        const messages = await requireMailboxService().listMessages(
          mailboxId,
          limit
        );
        response.status(200).json({ messages });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post("/feishu/events", (request, response, next) => {
    try {
      const callback = parseFeishuCallback(request.body as unknown, config.feishu);
      if (callback.kind === "challenge") {
        response.status(200).json({ challenge: callback.challenge });
        return;
      }

      verifyFeishuSignature({
        timestamp: request.header("x-lark-request-timestamp") ?? undefined,
        nonce: request.header("x-lark-request-nonce") ?? undefined,
        signature: request.header("x-lark-signature") ?? undefined,
        rawBody: (request as RequestWithRawBody).rawBody,
        encryptKey: config.feishu.encryptKey
      });

      if (
        callback.kind === "message" &&
        !eventDeduplicator.isDuplicate(callback.message.eventId) &&
        (callback.message.command === "测试" ||
          callback.message.command === "test")
      ) {
        const { chatId, eventId } = callback.message;
        scheduleTask(async () => {
          try {
            await feishuClient.sendTextMessage(
              chatId,
              "Creator BD Agent运行正常 ✅"
            );
            logger.info(
              JSON.stringify({ event: "feishu_event_replied", eventId })
            );
          } catch (error) {
            if (error instanceof FeishuApiError) {
              logger.error(
                JSON.stringify({
                  event: "feishu_event_reply_failed",
                  eventId,
                  httpStatus: error.httpStatus,
                  feishuCode: error.feishuCode,
                  logId: error.logId,
                  message: error.message
                })
              );
              return;
            }
            logger.error(
              JSON.stringify({
                event: "feishu_event_reply_failed",
                eventId,
                message: "Internal error"
              })
            );
          }
        });
      }

      response.status(200).json({ code: 0 });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/test/feishu/messages",
    adminOnly,
    async (request, response, next) => {
      try {
        const body = request.body as unknown;
        if (!isPlainObject(body) || !validIdentifier(body.chat_id, 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "chat_id must be a valid non-empty identifier"
          });
          return;
        }
        const text =
          typeof body.text === "string" && body.text.trim()
            ? body.text.trim()
            : "Creator BD Agent飞书连接测试成功 ✅";
        if (text.length > 1_000) {
          response.status(400).json({
            error: "invalid_request",
            message: "text must not exceed 1000 characters"
          });
          return;
        }

        const result = await feishuClient.sendTextMessage(body.chat_id, text);
        response.status(200).json({ status: "sent", result });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/test/feishu/base/records",
    adminOnly,
    async (request, response, next) => {
      try {
        const requestedSize = Number.parseInt(
          typeof request.query.page_size === "string"
            ? request.query.page_size
            : "20",
          10
        );
        if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 500) {
          response.status(400).json({
            error: "invalid_request",
            message: "page_size must be an integer between 1 and 500"
          });
          return;
        }
        const pageToken =
          typeof request.query.page_token === "string" &&
          request.query.page_token.length <= 512
            ? request.query.page_token
            : undefined;

        const result = await feishuClient.listBaseRecords({
          pageSize: requestedSize,
          ...(pageToken ? { pageToken } : {})
        });
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/test/feishu/base/records/:recordId",
    adminOnly,
    async (request, response, next) => {
      try {
        const recordId = request.params.recordId;
        if (!validIdentifier(recordId, 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "recordId must be a valid non-empty identifier"
          });
          return;
        }
        const body = request.body as unknown;
        if (!isPlainObject(body) || !isPlainObject(body.fields)) {
          response.status(400).json({
            error: "invalid_request",
            message: "Request body must be { fields: { ... } }"
          });
          return;
        }
        const fieldNames = Object.keys(body.fields);
        if (fieldNames.length < 1 || fieldNames.length > 50) {
          response.status(400).json({
            error: "invalid_request",
            message: "fields must contain between 1 and 50 entries"
          });
          return;
        }
        if (fieldNames.some((name) => name.length > 128)) {
          response.status(400).json({
            error: "invalid_request",
            message: "Field names must not exceed 128 characters"
          });
          return;
        }

        const result = await feishuClient.updateBaseRecord(
          recordId,
          body.fields
        );
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next
  ) => {
    if (error instanceof SyntaxError) {
      response.status(400).json({
        error: "invalid_json",
        message: "Request body is not valid JSON"
      });
      return;
    }

    if (error instanceof FeishuApiError) {
      logger.error(
        JSON.stringify({
          event: "feishu_api_error",
          httpStatus: error.httpStatus,
          feishuCode: error.feishuCode,
          logId: error.logId,
          message: error.message
        })
      );
      response.status(502).json({
        error: "feishu_api_error",
        message: error.message,
        feishuCode: error.feishuCode,
        logId: error.logId
      });
      return;
    }

    if (error instanceof FeishuCallbackError) {
      logger.error(
        JSON.stringify({
          event: "feishu_callback_rejected",
          status: error.statusCode,
          message: error.message
        })
      );
      response.status(error.statusCode).json({
        error: "feishu_callback_rejected",
        message: error.message
      });
      return;
    }

    if (error instanceof MailboxServiceError) {
      logger.error(
        JSON.stringify({
          event: "mailbox_operation_failed",
          errorCode: error.errorCode,
          status: error.statusCode
        })
      );
      response.status(error.statusCode).json({
        error: error.errorCode,
        message: error.message
      });
      return;
    }

    logger.error(
      JSON.stringify({ event: "unhandled_error", message: "Internal error" })
    );
    response.status(500).json({
      error: "internal_error",
      message: "An unexpected error occurred"
    });
  };
  app.use(errorHandler);

  return app;
}
