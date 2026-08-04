import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxRepository } from "../src/database.js";
import {
  EmailAnalysisSchema,
  type EmailAnalysis,
  type EmailAnalysisClient
} from "../src/email-analysis.js";
import { DefaultEmailAnalysisProcessor } from "../src/email-analysis-processor.js";
import type { FeishuClient } from "../src/feishu-client.js";
import type { MessageSummary } from "../src/mailbox-service.js";
import { SecretBox } from "../src/secret-box.js";

const analysis: EmailAnalysis = {
  replyType: "interested_with_quote",
  detectedLanguage: "en",
  summaryZh: "达人感兴趣，报价500美元并询问付款周期。",
  quotedAmount: 500,
  currency: "USD",
  deliverables: ["1 Instagram Reel"],
  timeline: "October",
  rightsRequests: ["30-day boosting"],
  paymentRequests: ["asks about payment timing"],
  riskFlags: [],
  recommendedAction: "review_quote",
  replyDraftZh: "你好，感谢你分享报价，我们会进行内部确认。",
  replyDraftEn: "Hi, thank you for sharing your rate. We will review it internally."
};

describe("AI email analysis", () => {
  it("validates the structured analysis contract", () => {
    assert.deepEqual(EmailAnalysisSchema.parse(analysis), analysis);
    assert.throws(() => EmailAnalysisSchema.parse({ ...analysis, currency: "dollars" }));
  });

  it("encrypts stored analysis and writes only approved AI fields to Feishu", async () => {
    const secretBox = new SecretBox(Buffer.alloc(32, 4).toString("base64"));
    let encrypted = "";
    let savedModel = "";
    let synced = false;
    let writtenRecord = "";
    let writtenFields: Record<string, unknown> = {};
    const repository = {
      saveMessageAnalysis: async (
        _messageId: string,
        encryptedAnalysis: string,
        model: string
      ) => {
        encrypted = encryptedAnalysis;
        savedModel = model;
      },
      recordMessageAnalysisFailure: async () => undefined,
      markMessageAnalysisSynced: async () => { synced = true; }
    } as unknown as MailboxRepository;
    const client: EmailAnalysisClient = {
      model: "gpt-5.6-luna",
      analyze: async () => analysis,
      translateDraft: async () => "Hi, thanks for your reply."
    };
    const feishuClient = {
      updateBaseRecord: async (
        recordId: string,
        fields: Record<string, unknown>
      ) => {
        writtenRecord = recordId;
        writtenFields = fields;
      }
    } as unknown as FeishuClient;
    const message: MessageSummary = {
      id: "message-1",
      uid: 1,
      subject: "Re: partnership",
      from: ["Creator <creator@example.com>"],
      fromAddresses: ["creator@example.com"],
      to: ["bd@example.com"],
      messageId: "message@example.com",
      references: [],
      textPreview: "Our rate is USD 500.",
      classification: "creator_reply",
      matchStatus: "matched",
      matchedRecordId: "rec123",
      aiAnalysisStatus: "pending",
      aiBaseSyncStatus: "pending"
    };

    const processor = new DefaultEmailAnalysisProcessor(
      client,
      repository,
      secretBox,
      feishuClient
    );
    const result = await processor.process(message);

    assert.deepEqual(result, analysis);
    assert.deepEqual(secretBox.decrypt<EmailAnalysis>(encrypted), analysis);
    assert.equal(savedModel, "gpt-5.6-luna");
    assert.equal(writtenRecord, "rec123");
    assert.equal(writtenFields["AI中文摘要"], analysis.summaryZh);
    assert.equal(writtenFields["AI回复草稿"], analysis.replyDraftEn);
    assert.equal(writtenFields["报价金额"], 500);
    assert.equal(writtenFields["报价币种"], "USD");
    assert.equal(writtenFields["交付内容"], "1 Instagram Reel");
    assert.equal("合作阶段" in writtenFields, false);
    assert.equal(synced, true);
    assert.equal(message.aiBaseSyncStatus, "synced");
  });

  it("translates an edited Chinese draft and persists the bilingual pair", async () => {
    const secretBox = new SecretBox(Buffer.alloc(32, 5).toString("base64"));
    let encrypted = "";
    const repository = {
      saveMessageAnalysis: async (
        _messageId: string,
        encryptedAnalysis: string
      ) => { encrypted = encryptedAnalysis; },
      markMessageAnalysisSynced: async () => undefined
    } as unknown as MailboxRepository;
    const client: EmailAnalysisClient = {
      model: "gpt-5.6-luna",
      analyze: async () => analysis,
      translateDraft: async () => "Hi, thank you. We will confirm internally."
    };
    const feishuClient = {
      updateBaseRecord: async () => undefined
    } as unknown as FeishuClient;
    const message: MessageSummary = {
      id: "message-2", uid: 2, subject: "Re", from: [], fromAddresses: [],
      to: [], messageId: "m2", references: [], textPreview: "Thanks",
      classification: "creator_reply", matchStatus: "matched",
      matchedRecordId: "rec2", aiAnalysisStatus: "completed",
      aiBaseSyncStatus: "synced", analysis
    };
    const processor = new DefaultEmailAnalysisProcessor(
      client, repository, secretBox, feishuClient
    );
    await processor.translateDraft(message, "你好，感谢回复，我们会内部确认。");
    const stored = secretBox.decrypt<EmailAnalysis>(encrypted);
    assert.equal(stored.replyDraftZh, "你好，感谢回复，我们会内部确认。");
    assert.equal(stored.replyDraftEn, "Hi, thank you. We will confirm internally.");
  });
});
