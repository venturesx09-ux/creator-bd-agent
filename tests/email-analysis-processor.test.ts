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
      model: "gpt-5.6-terra",
      analyze: async () => analysis
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
    assert.equal(savedModel, "gpt-5.6-terra");
    assert.equal(writtenRecord, "rec123");
    assert.equal(writtenFields["AI中文摘要"], analysis.summaryZh);
    assert.equal(writtenFields["AI回复草稿"], analysis.replyDraftEn);
    assert.equal(writtenFields["报价金额"], 500);
    assert.equal(writtenFields["报价币种"], "USD");
    assert.equal("合作阶段" in writtenFields, false);
    assert.equal(synced, true);
    assert.equal(message.aiBaseSyncStatus, "synced");
  });
});
