import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxRepository } from "../src/database.js";
import {
  EmailAnalysisSchema,
  parseStoredEmailAnalysis,
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
  quoteOriginalText: "Our rate is USD 500.",
  quoteNormalizedZh: "1条Instagram Reel总价：USD 500",
  quoteItems: [{
    source: "latest_reply",
    quoteType: "total",
    originalText: "Our rate is USD 500.",
    normalizedTextZh: "1条Instagram Reel总价：USD 500",
    amountMin: 500,
    amountMax: 500,
    currency: "USD",
    unit: null,
    packageName: null
  }],
  quotedAmount: 500,
  currency: "USD",
  deliverables: ["1 Instagram Reel"],
  timeline: "October",
  rightsRequests: ["30-day boosting"],
  paymentRequests: ["asks about payment timing"],
  riskFlags: [],
  recommendedAction: "review_quote",
  replyDraftZh: "",
  replyDraftEn: ""
};

describe("AI email analysis", () => {
  it("validates the structured analysis contract", () => {
    assert.deepEqual(EmailAnalysisSchema.parse(analysis), analysis);
    assert.throws(() => EmailAnalysisSchema.parse({ ...analysis, currency: "dollars" }));
  });

  it("upgrades previously stored single-amount analyses without losing data", () => {
    const previous = {
      ...analysis,
      quoteOriginalText: undefined,
      quoteNormalizedZh: undefined,
      quoteItems: undefined
    };
    const upgraded = parseStoredEmailAnalysis(previous);
    assert.equal(upgraded?.quoteNormalizedZh, "USD 500");
    assert.equal(upgraded?.quoteItems[0]?.quoteType, "total");
    assert.equal(upgraded?.quotedAmount, 500);
  });

  it("formats ranges and multiple packages without inventing one total", () => {
    const packages: EmailAnalysis = {
      ...analysis,
      quoteOriginalText: "$500 per Reel; package of 3 for $1,200",
      quoteNormalizedZh: "单条Reel：USD 500；3条套餐：USD 1,200",
      quoteItems: [{
        source: "latest_reply", quoteType: "unit",
        originalText: "$500 per Reel", normalizedTextZh: "单条Reel：USD 500",
        amountMin: 500, amountMax: 500, currency: "USD",
        unit: "每条Reel", packageName: null
      }, {
        source: "latest_reply", quoteType: "package",
        originalText: "package of 3 for $1,200",
        normalizedTextZh: "3条套餐：USD 1,200",
        amountMin: 1200, amountMax: 1200, currency: "USD",
        unit: null, packageName: "3条套餐"
      }],
      quotedAmount: null,
      currency: null
    };
    assert.equal(
      EmailAnalysisSchema.parse(packages).quoteItems.length,
      2
    );
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
    assert.equal(savedModel, "gpt-5.6-luna");
    assert.equal(writtenRecord, "rec123");
    assert.equal(writtenFields["AI中文摘要"], analysis.summaryZh);
    assert.equal("AI回复草稿" in writtenFields, false);
    assert.equal("报价" in writtenFields, false);
    assert.equal("权益要求" in writtenFields, false);
    assert.equal(writtenFields["报价金额"], 500);
    assert.equal(writtenFields["报价币种"], "USD");
    assert.equal(writtenFields["交付内容"], "1 Instagram Reel");
    assert.equal("合作阶段" in writtenFields, false);
    assert.deepEqual(Object.keys(writtenFields).sort(), [
      "AI中文摘要", "报价金额", "报价币种", "交付内容"
    ].sort());
    assert.equal(synced, true);
    assert.equal(message.aiBaseSyncStatus, "synced");
  });

  it("always writes a Chinese summary and clears numeric quote fields when absent", async () => {
    const noQuoteAnalysis: EmailAnalysis = {
      ...analysis,
      replyType: "interested_without_quote",
      summaryZh: "达人表示有兴趣，但邮件中没有提及报价。",
      quoteOriginalText: "",
      quoteNormalizedZh: "",
      quoteItems: [],
      quotedAmount: null,
      currency: null,
      recommendedAction: "ask_for_quote"
    };
    let writtenFields: Record<string, unknown> = {};
    const repository = {
      saveMessageAnalysis: async () => undefined,
      recordMessageAnalysisFailure: async () => undefined,
      markMessageAnalysisSynced: async () => undefined
    } as unknown as MailboxRepository;
    const client: EmailAnalysisClient = {
      model: "gpt-5.6-luna",
      analyze: async () => noQuoteAnalysis
    };
    const feishuClient = {
      updateBaseRecord: async (
        _recordId: string,
        fields: Record<string, unknown>
      ) => { writtenFields = fields; }
    } as unknown as FeishuClient;
    const message: MessageSummary = {
      id: "message-no-quote", uid: 3, subject: "Re", from: [],
      fromAddresses: ["creator@example.com"], to: [], messageId: "m3",
      references: [], textPreview: "I am interested.",
      classification: "creator_reply", matchStatus: "matched",
      matchedRecordId: "rec3", aiAnalysisStatus: "pending",
      aiBaseSyncStatus: "pending"
    };

    await new DefaultEmailAnalysisProcessor(
      client,
      repository,
      new SecretBox(Buffer.alloc(32, 6).toString("base64")),
      feishuClient
    ).process(message);

    assert.equal(writtenFields["AI中文摘要"], noQuoteAnalysis.summaryZh);
    assert.equal(writtenFields["报价金额"], null);
    assert.equal(writtenFields["报价币种"], null);
    assert.equal(writtenFields["交付内容"], "1 Instagram Reel");
    assert.equal("报价" in writtenFields, false);
  });

  it("writes AI summary and quote into the unmatched-mail table", async () => {
    let writtenRecord = "";
    let writtenFields: Record<string, unknown> = {};
    const repository = {
      saveMessageAnalysis: async () => undefined,
      recordMessageAnalysisFailure: async () => undefined,
      getUnmatchedRecordId: async () => "rec_unmatched"
    } as unknown as MailboxRepository;
    const feishuClient = {
      isUnmatchedTableConfigured: () => true,
      updateUnmatchedRecord: async (
        recordId: string,
        fields: Record<string, unknown>
      ) => {
        writtenRecord = recordId;
        writtenFields = fields;
      }
    } as unknown as FeishuClient;
    const message: MessageSummary = {
      id: "message-unmatched", uid: 4, subject: "Re", from: [],
      fromAddresses: ["agent@example.com"], to: [], messageId: "m4",
      references: [], textPreview: "Our rate is USD 500.",
      classification: "creator_reply", matchStatus: "unmatched",
      aiAnalysisStatus: "pending", aiBaseSyncStatus: "pending"
    };

    await new DefaultEmailAnalysisProcessor(
      { model: "gpt-5.6-luna", analyze: async () => analysis },
      repository,
      new SecretBox(Buffer.alloc(32, 7).toString("base64")),
      feishuClient
    ).process(message);

    assert.equal(writtenRecord, "rec_unmatched");
    assert.equal(writtenFields["AI中文摘要"], analysis.summaryZh);
    assert.match(String(writtenFields["报价"]), /标准化报价/u);
    assert.deepEqual(Object.keys(writtenFields).sort(), ["AI中文摘要", "报价"].sort());
  });

  it("keeps reply drafting disabled", async () => {
    const processor = new DefaultEmailAnalysisProcessor(
      { model: "gpt-5.6-luna", analyze: async () => analysis },
      {} as MailboxRepository,
      new SecretBox(Buffer.alloc(32, 5).toString("base64")),
      {} as FeishuClient
    );
    await assert.rejects(
      processor.translateDraft({} as MessageSummary, "你好"),
      /REPLY_DRAFTS_DISABLED/u
    );
  });
});
