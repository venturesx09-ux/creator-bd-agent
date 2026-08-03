import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

export class FeishuCallbackError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "FeishuCallbackError";
  }
}

export type ReceivedTextMessage = {
  eventId: string;
  chatId: string;
  command: string;
};

export type ParsedCallback =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: ReceivedTextMessage }
  | { kind: "ignored"; eventId?: string };

export type FeishuSignatureInput = {
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
  encryptKey: string | undefined;
};

function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyFeishuSignature(input: FeishuSignatureInput): void {
  const { timestamp, nonce, signature, rawBody, encryptKey } = input;
  if (!timestamp || !nonce || !signature || !rawBody || !encryptKey) {
    throw new FeishuCallbackError("Missing callback signature headers", 401);
  }
  if (timestamp.length > 32 || nonce.length > 256 || signature.length > 128) {
    throw new FeishuCallbackError("Invalid callback signature headers", 401);
  }

  const expected = createHash("sha256")
    .update(timestamp, "utf8")
    .update(nonce, "utf8")
    .update(encryptKey, "utf8")
    .update(rawBody)
    .digest("hex");
  if (!safeEqual(signature, expected)) {
    throw new FeishuCallbackError("Invalid callback signature", 403);
  }
}

function decryptCallback(encrypted: string, encryptKey: string): unknown {
  let cipherText: Buffer;
  try {
    cipherText = Buffer.from(encrypted, "base64");
  } catch {
    throw new FeishuCallbackError("Invalid encrypted callback", 400);
  }
  if (cipherText.length <= 16) {
    throw new FeishuCallbackError("Invalid encrypted callback", 400);
  }

  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const iv = cipherText.subarray(0, 16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([
      decipher.update(cipherText.subarray(16)),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new FeishuCallbackError("Unable to decrypt Feishu callback", 400);
  }
}

function decodeCallback(rawBody: unknown, encryptKey: string): JsonObject {
  if (!isPlainObject(rawBody)) {
    throw new FeishuCallbackError("Callback body must be a JSON object", 400);
  }

  if (typeof rawBody.encrypt === "string") {
    const decrypted = decryptCallback(rawBody.encrypt, encryptKey);
    if (!isPlainObject(decrypted)) {
      throw new FeishuCallbackError("Decrypted callback must be an object", 400);
    }
    return decrypted;
  }
  return rawBody;
}

function verifyCallback(
  payload: JsonObject,
  config: AppConfig["feishu"]
): void {
  const header = isPlainObject(payload.header) ? payload.header : undefined;
  const providedToken =
    typeof header?.token === "string"
      ? header.token
      : typeof payload.token === "string"
        ? payload.token
        : undefined;

  if (
    !providedToken ||
    !config.verificationToken ||
    !safeEqual(providedToken, config.verificationToken)
  ) {
    throw new FeishuCallbackError("Invalid callback verification token", 403);
  }

  const callbackAppId =
    typeof header?.app_id === "string" ? header.app_id : undefined;
  if (callbackAppId && !safeEqual(callbackAppId, config.appId)) {
    throw new FeishuCallbackError("Callback app ID does not match", 403);
  }
}

function normalizeCommand(text: string): string {
  return text
    .replace(/@_user_\d+\s*/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function parseFeishuCallback(
  rawBody: unknown,
  config: AppConfig["feishu"]
): ParsedCallback {
  if (!config.verificationToken || !config.encryptKey) {
    throw new FeishuCallbackError("Callback security is not configured", 503);
  }

  const payload = decodeCallback(rawBody, config.encryptKey);
  verifyCallback(payload, config);

  if (
    payload.type === "url_verification" &&
    typeof payload.challenge === "string" &&
    payload.challenge.length <= 512
  ) {
    return { kind: "challenge", challenge: payload.challenge };
  }

  const header = isPlainObject(payload.header) ? payload.header : undefined;
  const eventId =
    typeof header?.event_id === "string" && header.event_id.length <= 256
      ? header.event_id
      : undefined;
  if (header?.event_type !== "im.message.receive_v1") {
    return { kind: "ignored", ...(eventId ? { eventId } : {}) };
  }

  const event = isPlainObject(payload.event) ? payload.event : undefined;
  const sender = isPlainObject(event?.sender) ? event.sender : undefined;
  const message = isPlainObject(event?.message) ? event.message : undefined;
  if (
    !eventId ||
    sender?.sender_type !== "user" ||
    message?.message_type !== "text" ||
    typeof message.chat_id !== "string" ||
    message.chat_id.length < 1 ||
    message.chat_id.length > 128 ||
    typeof message.content !== "string" ||
    message.content.length > 16_384
  ) {
    return { kind: "ignored", ...(eventId ? { eventId } : {}) };
  }

  let content: unknown;
  try {
    content = JSON.parse(message.content) as unknown;
  } catch {
    return { kind: "ignored", eventId };
  }
  if (!isPlainObject(content) || typeof content.text !== "string") {
    return { kind: "ignored", eventId };
  }

  return {
    kind: "message",
    message: {
      eventId,
      chatId: message.chat_id,
      command: normalizeCommand(content.text)
    }
  };
}

export class EventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  isDuplicate(eventId: string): boolean {
    const currentTime = this.now();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= currentTime) {
        this.seen.delete(id);
      }
    }

    if (this.seen.has(eventId)) {
      return true;
    }
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest) {
        this.seen.delete(oldest);
      }
    }
    this.seen.set(eventId, currentTime + this.ttlMs);
    return false;
  }
}
