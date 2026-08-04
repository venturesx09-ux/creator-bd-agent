import OpenAI from "openai";
import type { MailboxRepository } from "./database.js";
import type { EmailAnalysis, EmailAnalysisClient } from "./email-analysis.js";
import type { FeishuClient } from "./feishu-client.js";
import type { MessageSummary } from "./mailbox-service.js";
import { SecretBox } from "./secret-box.js";

export interface EmailAnalysisProcessor {
  process(message: MessageSummary, force?: boolean): Promise<EmailAnalysis>;
}

function analysisFields(analysis: EmailAnalysis): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "AI中文摘要": analysis.summaryZh,
    "AI回复草稿": analysis.replyDraftEn
  };
  if (analysis.quotedAmount !== null) {
    fields["报价金额"] = analysis.quotedAmount;
  }
  if (analysis.currency) fields["报价币种"] = analysis.currency;
  if (analysis.rightsRequests.length) {
    fields["权益要求"] = analysis.rightsRequests.join("；");
  }
  return fields;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return "OPENAI_TIMEOUT";
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) return "OPENAI_AUTH_FAILED";
    if (error.status === 429) return "OPENAI_RATE_LIMITED";
    if (error.status !== undefined && error.status >= 500) {
      return "OPENAI_UNAVAILABLE";
    }
  }
  return "OPENAI_ANALYSIS_FAILED";
}

export class DefaultEmailAnalysisProcessor implements EmailAnalysisProcessor {
  private readonly active = new Map<string, Promise<EmailAnalysis>>();

  constructor(
    private readonly client: EmailAnalysisClient,
    private readonly repository: MailboxRepository,
    private readonly secretBox: SecretBox,
    private readonly feishuClient: FeishuClient
  ) {}

  async process(message: MessageSummary, force = false): Promise<EmailAnalysis> {
    const existing = this.active.get(message.id);
    if (existing) return existing;
    const job = this.processOnce(message, force).finally(() => {
      this.active.delete(message.id);
    });
    this.active.set(message.id, job);
    return job;
  }

  private async processOnce(
    message: MessageSummary,
    force: boolean
  ): Promise<EmailAnalysis> {
    let analysis = message.analysis;
    if (force || message.aiAnalysisStatus !== "completed" || !analysis) {
      try {
        analysis = await this.client.analyze({
          ...(message.project ? { project: message.project } : {}),
          ...(message.mailboxEmail ? { mailboxEmail: message.mailboxEmail } : {}),
          subject: message.subject,
          from: message.from,
          ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
          text: message.textPreview
        });
        await this.repository.saveMessageAnalysis(
          message.id,
          this.secretBox.encrypt(analysis),
          this.client.model
        );
        message.analysis = analysis;
        message.aiAnalysisStatus = "completed";
        message.aiAnalyzedAt = new Date().toISOString();
        message.aiModel = this.client.model;
        message.aiBaseSyncStatus = "pending";
        delete message.aiErrorCode;
      } catch (error) {
        const errorCode = safeErrorCode(error);
        await this.repository.recordMessageAnalysisFailure(message.id, errorCode);
        message.aiAnalysisStatus = "failed";
        message.aiAnalyzedAt = new Date().toISOString();
        message.aiErrorCode = errorCode;
        throw new Error(errorCode);
      }
    }

    if (
      message.matchedRecordId &&
      message.aiBaseSyncStatus !== "synced"
    ) {
      try {
        await this.feishuClient.updateBaseRecord(
          message.matchedRecordId,
          analysisFields(analysis)
        );
        await this.repository.markMessageAnalysisSynced(message.id);
        message.aiBaseSyncStatus = "synced";
      } catch (error) {
        console.error(JSON.stringify({
          event: "feishu_ai_analysis_writeback_failed",
          messageId: message.id,
          message: error instanceof Error ? error.message : "Internal error"
        }));
      }
    }
    return analysis;
  }
}
