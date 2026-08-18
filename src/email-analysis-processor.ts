import OpenAI from "openai";
import type { MailboxRepository } from "./database.js";
import type { EmailAnalysis, EmailAnalysisClient } from "./email-analysis.js";
import type { FeishuClient } from "./feishu-client.js";
import type { MessageSummary } from "./mailbox-service.js";
import { SecretBox } from "./secret-box.js";

export interface EmailAnalysisProcessor {
  testConnection(): Promise<{ status: "ok"; model: string }>;
  process(message: MessageSummary, force?: boolean): Promise<EmailAnalysis>;
  translateDraft(message: MessageSummary, draftZh: string): Promise<EmailAnalysis>;
  saveDrafts(
    message: MessageSummary,
    draftZh: string,
    draftEn: string
  ): Promise<EmailAnalysis>;
  syncSentState(message: MessageSummary, sentAt: Date): Promise<void>;
}

export function quoteText(analysis: EmailAnalysis): string {
  const normalized = analysis.quoteNormalizedZh.trim() || analysis.quoteItems
    .map((item) => item.normalizedTextZh.trim())
    .filter(Boolean)
    .join("；");
  if (!analysis.quoteItems.length && !normalized) {
    return "未提及报价";
  }
  const sections: string[] = [];
  if (analysis.quoteOriginalText.trim()) {
    sections.push(`报价原文：${analysis.quoteOriginalText.trim()}`);
  }
  sections.push(`标准化报价：${normalized}`);
  return sections.join("\n");
}

function analysisFields(analysis: EmailAnalysis): Record<string, unknown> {
  return {
    "AI中文摘要": analysis.summaryZh,
    "报价金额": analysis.quotedAmount,
    "报价币种": analysis.currency,
    "交付内容": analysis.deliverables.join("；")
  };
}

function unmatchedAnalysisFields(
  analysis: EmailAnalysis
): Record<string, unknown> {
  return {
    "AI中文摘要": analysis.summaryZh,
    "报价": quoteText(analysis)
  };
}

export function providerErrorCode(input: {
  status?: number;
  code?: string | null;
  message?: string;
}): string {
  const code = input.code?.trim().toLowerCase() ?? "";
  const message = input.message?.trim().toLowerCase() ?? "";
  if (input.status === 401) return "OPENAI_AUTH_FAILED";
  if (input.status === 403) {
    if (
      code === "insufficient_user_quota" ||
      message.includes("balance is insufficient") ||
      message.includes("insufficient quota")
    ) return "OPENAI_QUOTA_EXHAUSTED";
    if (message.includes("approved ip")) return "OPENAI_IP_RESTRICTED";
    if (
      message.includes("not authorized") &&
      message.includes("model")
    ) return "OPENAI_MODEL_FORBIDDEN";
    if (message.includes("account suspended")) return "OPENAI_ACCOUNT_SUSPENDED";
    return "OPENAI_FORBIDDEN";
  }
  if (input.status === 429) return "OPENAI_RATE_LIMITED";
  if (input.status !== undefined && input.status >= 500) {
    return "OPENAI_UNAVAILABLE";
  }
  return "OPENAI_ANALYSIS_FAILED";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return "OPENAI_TIMEOUT";
  }
  if (error instanceof OpenAI.APIError) {
    return providerErrorCode({
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      message: error.message
    });
  }
  return "OPENAI_ANALYSIS_FAILED";
}

const RETRYABLE_AI_ERROR_CODES = new Set([
  "OPENAI_TIMEOUT",
  "OPENAI_RATE_LIMITED",
  "OPENAI_UNAVAILABLE"
]);

export function automaticRetryDelayMs(
  errorCode: string,
  failedAttemptCount: number
): number | undefined {
  if (!RETRYABLE_AI_ERROR_CODES.has(errorCode)) return undefined;
  if (failedAttemptCount === 1) return 30 * 60 * 1_000;
  if (failedAttemptCount === 2) return 2 * 60 * 60 * 1_000;
  if (failedAttemptCount === 3) return 12 * 60 * 60 * 1_000;
  return undefined;
}

export class DefaultEmailAnalysisProcessor implements EmailAnalysisProcessor {
  private readonly active = new Map<string, Promise<EmailAnalysis>>();
  private readonly retryStateWriteCooldown = new Map<string, number>();

  constructor(
    private readonly client: EmailAnalysisClient,
    private readonly repository: MailboxRepository,
    private readonly secretBox: SecretBox,
    private readonly feishuClient: FeishuClient
  ) {}

  async testConnection(): Promise<{ status: "ok"; model: string }> {
    try {
      await this.client.analyze({
        project: "connection-test",
        mailboxEmail: "test@example.invalid",
        subject: "AI connection test",
        from: ["System Test <test@example.invalid>"],
        text: "This is a connectivity test. There is no creator quote."
      });
      return { status: "ok", model: this.client.model };
    } catch (error) {
      throw new Error(safeErrorCode(error));
    }
  }

  async process(message: MessageSummary, force = false): Promise<EmailAnalysis> {
    const suppressedUntil = this.retryStateWriteCooldown.get(message.id);
    if (!force && suppressedUntil !== undefined) {
      if (suppressedUntil > Date.now()) {
        throw new Error("AI_RETRY_STATE_UNAVAILABLE");
      }
      this.retryStateWriteCooldown.delete(message.id);
    }
    const existing = this.active.get(message.id);
    if (existing) return existing;
    const job = this.processOnce(message, force).finally(() => {
      this.active.delete(message.id);
    });
    this.active.set(message.id, job);
    return job;
  }

  async translateDraft(
    _message: MessageSummary,
    _draftZh: string
  ): Promise<EmailAnalysis> {
    throw new Error("REPLY_DRAFTS_DISABLED");
  }

  async saveDrafts(
    _message: MessageSummary,
    _draftZh: string,
    _draftEn: string
  ): Promise<EmailAnalysis> {
    throw new Error("REPLY_DRAFTS_DISABLED");
  }

  async syncSentState(message: MessageSummary, _sentAt: Date): Promise<void> {
    if (!message.matchedRecordId) {
      message.sendFeishuSyncStatus = "not_required";
      return;
    }
    try {
      await this.feishuClient.updateBaseRecord(message.matchedRecordId, {
        "邮件同步状态": "已发送"
      });
      await this.repository.markMessageSendFeishuSynced(message.id);
      message.sendFeishuSyncStatus = "synced";
    } catch (error) {
      message.sendFeishuSyncStatus = "pending";
      console.error(JSON.stringify({
        event: "feishu_sent_state_writeback_failed",
        messageId: message.id,
        message: error instanceof Error ? error.message : "Internal error"
      }));
    }
  }

  private async processOnce(
    message: MessageSummary,
    force: boolean
  ): Promise<EmailAnalysis> {
    let analysis = message.analysis;
    if (
      force ||
      message.aiAnalysisStatus !== "completed" ||
      (message.aiAnalysisSchemaVersion ?? 1) < 2 ||
      !analysis
    ) {
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
        message.aiAnalysisSchemaVersion = 2;
        message.aiAttemptCount = 0;
        delete message.aiNextRetryAt;
        message.aiBaseSyncStatus = "pending";
        delete message.aiErrorCode;
      } catch (error) {
        const errorCode = safeErrorCode(error);
        message.aiAnalysisStatus = "failed";
        message.aiAnalyzedAt = new Date().toISOString();
        message.aiErrorCode = errorCode;
        message.aiAttemptCount = (message.aiAttemptCount ?? 0) + 1;
        const retryDelay = automaticRetryDelayMs(
          errorCode,
          message.aiAttemptCount
        );
        if (retryDelay !== undefined) {
          message.aiNextRetryAt = new Date(Date.now() + retryDelay).toISOString();
        } else {
          delete message.aiNextRetryAt;
        }
        try {
          await this.repository.recordMessageAnalysisFailure(message.id, errorCode);
          this.retryStateWriteCooldown.delete(message.id);
        } catch (persistenceError) {
          this.retryStateWriteCooldown.set(
            message.id,
            Date.now() + 30 * 60 * 1_000
          );
          console.error(JSON.stringify({
            event: "ai_failure_state_persist_failed",
            messageId: message.id,
            originalCode: errorCode,
            message: persistenceError instanceof Error
              ? persistenceError.message
              : "Database error"
          }));
        }
        throw new Error(errorCode);
      }
    }

    await this.syncToFeishu(message, analysis);
    return analysis;
  }

  private async syncToFeishu(
    message: MessageSummary,
    analysis: EmailAnalysis
  ): Promise<void> {
    if (message.matchedRecordId && message.aiBaseSyncStatus !== "synced") {
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
    if (
      !message.matchedRecordId &&
      message.matchStatus === "unmatched" &&
      this.feishuClient.isUnmatchedTableConfigured()
    ) {
      try {
        const queueRecordId = await this.repository.getUnmatchedRecordId(message.id);
        if (queueRecordId) {
          await this.feishuClient.updateUnmatchedRecord(
            queueRecordId,
            unmatchedAnalysisFields(analysis)
          );
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: "feishu_unmatched_ai_writeback_failed",
          messageId: message.id,
          message: error instanceof Error ? error.message : "Internal error"
        }));
      }
    }
  }
}
