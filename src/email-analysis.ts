import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { AppConfig } from "./config.js";

export const ReplyTypeSchema = z.enum([
  "interested_with_quote",
  "interested_without_quote",
  "counteroffer",
  "declined",
  "manager_reply",
  "needs_clarification",
  "unrelated"
]);

export const RecommendedActionSchema = z.enum([
  "review_quote",
  "ask_for_quote",
  "answer_questions",
  "clarify_requirements",
  "close_as_declined",
  "manual_review"
]);

export const EmailAnalysisSchema = z.object({
  replyType: ReplyTypeSchema,
  detectedLanguage: z.string().min(1).max(40),
  summaryZh: z.string().min(1).max(2_000),
  quotedAmount: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  deliverables: z.array(z.string().max(300)).max(20),
  timeline: z.string().max(500).nullable(),
  rightsRequests: z.array(z.string().max(500)).max(20),
  paymentRequests: z.array(z.string().max(500)).max(20),
  riskFlags: z.array(z.string().max(500)).max(20),
  recommendedAction: RecommendedActionSchema,
  replyDraftEn: z.string().max(4_000)
});

export type EmailAnalysis = z.infer<typeof EmailAnalysisSchema>;

export type EmailAnalysisInput = {
  project?: string;
  mailboxEmail?: string;
  subject: string;
  from: string[];
  receivedAt?: string;
  text: string;
};

export interface EmailAnalysisClient {
  analyze(input: EmailAnalysisInput): Promise<EmailAnalysis>;
  readonly model: string;
}

const ANALYSIS_INSTRUCTIONS = `You analyze inbound creator partnership emails for an agency BD team.

Tasks:
- Focus on the newest sender-authored reply. Quoted history is context only.
- Produce a concise but complete Chinese summary.
- Extract only facts explicitly present in the email. Never invent a quote, currency, deliverable, date, right, payment term, or commitment.
- quotedAmount is the total collaboration quote when one is explicit. Otherwise return null.
- currency must be an uppercase ISO 4217 code when explicit or unambiguous; otherwise null.
- Flag requests involving prepayment, perpetual or broad content rights, whitelisting, exclusivity, AI training, sublicensing, contract changes, or uncertain legal/payment terms.
- A reply draft must be in professional English. It may acknowledge receipt, ask for missing information, or say the team will confirm internally. It must never accept a quote, change a budget, promise payment, agree to rights, or bind the agency without human approval.
- If the email is unrelated, still return the required structure with empty arrays and a short explanation.

Reply type guidance:
- interested_with_quote: interested and gives a concrete rate.
- interested_without_quote: interested but no concrete rate.
- counteroffer: negotiating against a prior offer or proposing changed commercial terms.
- declined: clearly refuses or is unavailable.
- manager_reply: a manager or agency representative replies for the creator.
- needs_clarification: asks questions or cannot be safely classified above.
- unrelated: not a creator partnership reply.

Recommended action guidance:
- Never recommend accepting a price without project budget rules.
- Use review_quote for any concrete rate or commercial counteroffer.
- Use ask_for_quote when interested without a rate.
- Use answer_questions for straightforward questions that still require human-approved wording.
- Use manual_review for legal, payment, rights, ambiguity, or manager cases.`;

function safeEmailText(value: string): string {
  return value.replace(/\u0000/gu, "").trim().slice(0, 12_000);
}

export class OpenAIEmailAnalysisClient implements EmailAnalysisClient {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: AppConfig["openai"]) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 2,
      timeout: 45_000
    });
  }

  async analyze(input: EmailAnalysisInput): Promise<EmailAnalysis> {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      max_output_tokens: 2_000,
      input: [
        { role: "developer", content: ANALYSIS_INSTRUCTIONS },
        {
          role: "user",
          content: JSON.stringify({
            project: input.project ?? "",
            receivingMailbox: input.mailboxEmail ?? "",
            subject: input.subject,
            from: input.from,
            receivedAt: input.receivedAt ?? "",
            emailText: safeEmailText(input.text)
          })
        }
      ],
      text: {
        format: zodTextFormat(EmailAnalysisSchema, "creator_email_analysis")
      }
    });
    if (!response.output_parsed) {
      throw new Error("OpenAI response did not contain structured analysis");
    }
    return response.output_parsed;
  }
}
