import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  MailboxRepository,
  StoredMailbox,
  StoredMessage
} from "../src/database.js";
import type { EmailAnalysisProcessor } from "../src/email-analysis-processor.js";
import {
  MailboxService,
  MailboxServiceError,
  type MessageSummary
} from "../src/mailbox-service.js";
import { SecretBox } from "../src/secret-box.js";
import type {
  SmtpFactory,
  SmtpMessageOptions
} from "../src/smtp-reply.js";

const analysis = {
  replyType: "interested_without_quote" as const,
  detectedLanguage: "en",
  summaryZh: "达人感兴趣。",
  quoteOriginalText: "",
  quoteNormalizedZh: "",
  quoteItems: [],
  quotedAmount: null,
  currency: null,
  deliverables: [],
  timeline: null,
  rightsRequests: [],
  paymentRequests: [],
  riskFlags: [],
  recommendedAction: "ask_for_quote" as const,
  replyDraftZh: "",
  replyDraftEn: ""
};

describe("retired SMTP reply flow", () => {
  it("does not send when reply drafting is disabled", async () => {
    const secretBox = new SecretBox(Buffer.alloc(32, 4).toString("base64"));
    const mailbox: StoredMailbox = {
      id: "mailbox-id",
      label: "Pilot",
      brand: "Tripo",
      enabled: true,
      smtpEnabled: true,
      smtpLastTestStatus: "success",
      encryptedConfig: secretBox.encrypt({
        emailAddress: "shark@example.com",
        senderName: "Shark",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: "shark@example.com",
        imapPassword: "imap-secret",
        inboxName: "INBOX",
        smtp: {
          host: "smtp.example.com",
          port: 465,
          security: "tls",
          username: "shark@example.com",
          password: "smtp-secret",
          sentFolder: "Sent",
          saveToSent: false,
          signature: "Best,\nShark"
        }
      }),
      lastUid: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    };
    const storedMessage: StoredMessage = {
      id: "message-id",
      uid: 1,
      encryptedPayload: secretBox.encrypt({
        subject: "Paid collaboration",
        from: ["Creator <creator@example.org>"],
        fromAddresses: ["creator@example.org"],
        to: ["shark@example.com"],
        messageId: "original@example.org",
        references: ["<older@example.org>"],
        textPreview: "Interested",
        classification: "creator_reply",
        matchStatus: "matched"
      }),
      createdAt: new Date(0),
      classification: "creator_reply",
      matchStatus: "matched",
      matchedRecordId: "rec_creator",
      baseSyncStatus: "synced",
      aiAnalysisStatus: "completed",
      encryptedAiAnalysis: secretBox.encrypt(analysis),
      aiBaseSyncStatus: "synced",
      sendStatus: "awaiting_confirmation",
      sentCopyStatus: "not_required",
      sendFeishuSyncStatus: "not_required"
    };
    let sendState: StoredMessage["sendStatus"] = "awaiting_confirmation";
    let sentRecords = 0;
    const repository = {
      getMailbox: async () => mailbox,
      getMessage: async () => ({ ...storedMessage, sendStatus: sendState }),
      saveMessageAnalysis: async () => undefined,
      claimMessageForSend: async () => {
        if (sendState === "sent") return "already_sent" as const;
        sendState = "sending";
        return "claimed" as const;
      },
      recordMessageSent: async () => {
        sendState = "sent";
        sentRecords += 1;
      },
      recordMessageSendFailure: async () => undefined,
      markSentCopyStatus: async () => undefined,
      markMessageSendFeishuSynced: async () => undefined
    } as unknown as MailboxRepository;
    const analysisProcessor = {
      saveDrafts: async () => {
        throw new Error("REPLY_DRAFTS_DISABLED");
      },
      syncSentState: async (message: MessageSummary) => {
        message.sendFeishuSyncStatus = "synced";
      }
    } as unknown as EmailAnalysisProcessor;
    const sentOptions: SmtpMessageOptions[] = [];
    const smtpFactory: SmtpFactory = () => ({
      verify: async () => true,
      sendMail: async (options) => {
        sentOptions.push(options);
        return { messageId: options.messageId, accepted: [options.to], rejected: [] };
      },
      close: () => undefined
    });
    const service = new MailboxService(
      repository,
      secretBox,
      20,
      undefined,
      undefined,
      analysisProcessor,
      smtpFactory
    );

    await assert.rejects(
      service.sendReply(mailbox.id, storedMessage.id, {
        confirm: true,
        recipient: "creator@example.org",
        draftZh: analysis.replyDraftZh,
        draftEn: analysis.replyDraftEn
      }),
      (error: unknown) =>
        error instanceof MailboxServiceError &&
        error.errorCode === "REPLY_DRAFTS_DISABLED"
    );
    assert.equal(sentRecords, 0);
    assert.equal(sentOptions.length, 0);
  });
});
