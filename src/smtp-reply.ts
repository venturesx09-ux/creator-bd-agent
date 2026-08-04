import { createHash } from "node:crypto";
import nodemailer from "nodemailer";

export type SmtpSecurity = "tls" | "starttls";

export type SmtpConnectionConfig = {
  host: string;
  port: 465 | 587;
  security: SmtpSecurity;
  username: string;
  password: string;
  sentFolder: string;
  saveToSent: boolean;
  signature: string;
};

export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
};

export type SmtpMessageOptions = {
  messageId: string;
  date: Date;
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  disableFileAccess: true;
  disableUrlAccess: true;
};

export interface SmtpTransportLike {
  verify(): Promise<unknown>;
  sendMail(options: SmtpMessageOptions): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
  }>;
  close(): void;
}

export type SmtpFactory = (
  options: SmtpTransportOptions
) => SmtpTransportLike;

export const defaultSmtpFactory: SmtpFactory = (options) =>
  nodemailer.createTransport(options) as unknown as SmtpTransportLike;

export function smtpTransportOptions(
  config: SmtpConnectionConfig
): SmtpTransportOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    auth: { user: config.username, pass: config.password },
    tls: { rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };
}

export function smtpErrorCode(error: unknown): string {
  const candidate = error as {
    code?: unknown;
    responseCode?: unknown;
    command?: unknown;
    message?: unknown;
  };
  const code = typeof candidate?.code === "string"
    ? candidate.code.toUpperCase()
    : "";
  const message = typeof candidate?.message === "string"
    ? candidate.message.toLowerCase()
    : "";
  const responseCode = typeof candidate?.responseCode === "number"
    ? candidate.responseCode
    : 0;
  if (code === "EAUTH" || responseCode === 535 || /auth|credential/u.test(message)) {
    return "SMTP_AUTH_FAILED";
  }
  if (/cert|tls|ssl/u.test(code + message)) return "SMTP_TLS_FAILED";
  if (
    code === "EENVELOPE" ||
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 553
  ) {
    return "SMTP_RECIPIENT_REJECTED";
  }
  if (
    code === "ECONNECTION" ||
    code === "ESOCKET" ||
    code === "ETIMEDOUT" ||
    /connect|timeout/u.test(message)
  ) {
    return "SMTP_CONNECT_FAILED";
  }
  return "SMTP_SEND_FAILED";
}

function validEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/iu.test(value)
  );
}

export function replyRecipient(
  fromAddresses: string[],
  mailboxEmail: string
): string | undefined {
  const ownAddress = mailboxEmail.trim().toLowerCase();
  return [...new Set(fromAddresses.map((value) => value.trim().toLowerCase()))]
    .find((value) => value !== ownAddress && validEmail(value));
}

export function replySubject(subject: string): string {
  const sanitized = subject.replace(/[\r\n]+/gu, " ").trim().slice(0, 500);
  if (/^re\s*:/iu.test(sanitized)) return sanitized;
  return `Re: ${sanitized || "(无主题)"}`;
}

function normalizedMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\r\n\s]+/gu, "").slice(0, 500);
  if (/^<[^<>\s@]+@[^<>\s@]+>$/u.test(sanitized)) return sanitized;
  if (/^[^<>\s@]+@[^<>\s@]+$/u.test(sanitized)) return `<${sanitized}>`;
  return undefined;
}

export function replyThreadHeaders(input: {
  originalMessageId: string;
  references: string[];
}): { inReplyTo?: string; references?: string[] } {
  const inReplyTo = normalizedMessageId(input.originalMessageId);
  const references = [...new Set([
    ...input.references.map((value) => normalizedMessageId(value)),
    inReplyTo
  ].filter((value): value is string => Boolean(value)))].slice(-100);
  return {
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {})
  };
}

export function outboundMessageId(
  messageId: string,
  attemptId: string,
  senderEmail: string
): string {
  const domain = senderEmail.split("@")[1]?.toLowerCase() ?? "localhost";
  const digest = createHash("sha256")
    .update(`${messageId}:${attemptId}`)
    .digest("hex")
    .slice(0, 32);
  return `<creator-bd-${digest}@${domain}>`;
}

export function replyText(draft: string, signature: string): string {
  const normalizedDraft = draft.replace(/\u0000/gu, "").trim();
  const normalizedSignature = signature.replace(/\u0000/gu, "").trim();
  return normalizedSignature
    ? `${normalizedDraft}\n\n${normalizedSignature}`
    : normalizedDraft;
}

function encodedWord(value: string): string {
  const sanitized = value.replace(/[\r\n]+/gu, " ").trim();
  if (/^[\x20-\x7E]*$/u.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .match(/.{1,76}/gu)
    ?.join("\r\n") ?? "";
}

export function rawSentCopy(input: {
  senderName: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  text: string;
  sentAt: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}): Buffer {
  const headers = [
    `Date: ${input.sentAt.toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    `From: ${encodedWord(input.senderName)} <${input.senderEmail}>`,
    `To: ${input.recipient}`,
    `Subject: ${encodedWord(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length
      ? [`References: ${input.references.join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64"
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${base64Lines(input.text)}\r\n`);
}
