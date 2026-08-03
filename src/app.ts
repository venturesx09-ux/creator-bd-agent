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

type Logger = Pick<Console, "info" | "error">;

export type CreateAppOptions = {
  config: AppConfig;
  feishuClient?: FeishuClient;
  logger?: Logger;
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
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb", strict: true }));

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
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      configuration: configurationStatus(config)
    });
  });

  const adminOnly = requireAdminToken(config);

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
        if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 100) {
          response.status(400).json({
            error: "invalid_request",
            message: "page_size must be an integer between 1 and 100"
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
