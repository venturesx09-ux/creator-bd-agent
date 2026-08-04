import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  outboundMessageId,
  rawSentCopy,
  replyRecipient,
  replySubject,
  replyText,
  replyThreadHeaders,
  smtpErrorCode
} from "../src/smtp-reply.js";

describe("SMTP reply safety helpers", () => {
  it("selects only the original external sender", () => {
    assert.equal(
      replyRecipient(
        ["SHARK@example.com", "Creator@Example.org"],
        "shark@example.com"
      ),
      "creator@example.org"
    );
    assert.equal(replyRecipient(["not-an-email"], "shark@example.com"), undefined);
  });

  it("preserves reply threading headers and normalizes the subject", () => {
    assert.equal(replySubject("Paid collaboration"), "Re: Paid collaboration");
    assert.equal(replySubject("Re: Paid collaboration"), "Re: Paid collaboration");
    assert.deepEqual(replyThreadHeaders({
      originalMessageId: "original@example.com",
      references: ["<older@example.com>"]
    }), {
      inReplyTo: "<original@example.com>",
      references: ["<older@example.com>", "<original@example.com>"]
    });
  });

  it("builds a deterministic safe message ID and MIME Sent copy", () => {
    const messageId = outboundMessageId(
      "message-id",
      "attempt-id",
      "shark@example.com"
    );
    const content = rawSentCopy({
      senderName: "Shark",
      senderEmail: "shark@example.com",
      recipient: "creator@example.org",
      subject: "Re: 合作",
      text: replyText("Hi!", "Best,\nShark"),
      sentAt: new Date("2026-08-04T12:00:00.000Z"),
      messageId,
      inReplyTo: "<original@example.org>",
      references: ["<original@example.org>"]
    }).toString("utf8");

    assert.match(messageId, /^<creator-bd-[a-f0-9]{32}@example\.com>$/u);
    assert.match(content, /In-Reply-To: <original@example\.org>/u);
    assert.match(content, /Content-Transfer-Encoding: base64/u);
    assert.equal(content.includes("Hi!\r\nBcc:"), false);
  });

  it("maps provider failures to safe non-secret error codes", () => {
    assert.equal(smtpErrorCode({ code: "EAUTH" }), "SMTP_AUTH_FAILED");
    assert.equal(smtpErrorCode({ code: "ETIMEDOUT" }), "SMTP_CONNECT_FAILED");
    assert.equal(smtpErrorCode({ responseCode: 550 }), "SMTP_RECIPIENT_REJECTED");
  });
});
