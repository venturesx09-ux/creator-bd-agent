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

export const QuoteItemSchema = z.object({
  source: z.enum(["latest_reply", "thread_history"]),
  quoteType: z.enum(["unit", "total", "range", "package", "other"]),
  originalText: z.string().min(1).max(1_000),
  normalizedTextZh: z.string().min(1).max(1_000),
  amountMin: z.number().nonnegative().nullable(),
  amountMax: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  unit: z.string().max(200).nullable(),
  packageName: z.string().max(200).nullable()
});

export const EmailAnalysisSchema = z.object({
  replyType: ReplyTypeSchema,
  detectedLanguage: z.string().min(1).max(40),
  summaryZh: z.string().min(1).max(2_000),
  quoteOriginalText: z.string().max(3_000),
  quoteNormalizedZh: z.string().max(3_000),
  quoteItems: z.array(QuoteItemSchema).max(30),
  quotedAmount: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  deliverables: z.array(z.string().max(300)).max(20),
  timeline: z.string().max(500).nullable(),
  rightsRequests: z.array(z.string().max(500)).max(20),
  paymentRequests: z.array(z.string().max(500)).max(20),
  riskFlags: z.array(z.string().max(500)).max(20),
  recommendedAction: RecommendedActionSchema,
  replyDraftZh: z.literal(""),
  replyDraftEn: z.literal("")
});

const DraftedEmailAnalysisSchema = EmailAnalysisSchema.omit({
  replyDraftZh: true,
  replyDraftEn: true
}).extend({
  replyDraftZh: z.string().max(4_000),
  replyDraftEn: z.string().max(4_000)
});

const PreviousEmailAnalysisSchema = EmailAnalysisSchema.omit({
  quoteOriginalText: true,
  quoteNormalizedZh: true,
  quoteItems: true,
  replyDraftZh: true,
  replyDraftEn: true
}).extend({
  replyDraftZh: z.string().max(4_000),
  replyDraftEn: z.string().max(4_000)
});

const LegacyEmailAnalysisSchema = PreviousEmailAnalysisSchema.omit({
  replyDraftZh: true
});

type PreviousEmailAnalysis = z.infer<typeof PreviousEmailAnalysisSchema>;

function upgradePreviousAnalysis(value: PreviousEmailAnalysis): EmailAnalysis {
  const normalized = value.quotedAmount === null
    ? ""
    : `${value.currency ? `${value.currency} ` : ""}${value.quotedAmount}`;
  return {
    ...value,
    replyDraftZh: "",
    replyDraftEn: "",
    quoteOriginalText: "",
    quoteNormalizedZh: normalized,
    quoteItems: value.quotedAmount === null ? [] : [{
      source: "latest_reply",
      quoteType: "total",
      originalText: normalized,
      normalizedTextZh: normalized,
      amountMin: value.quotedAmount,
      amountMax: value.quotedAmount,
      currency: value.currency,
      unit: null,
      packageName: null
    }]
  };
}

export function parseStoredEmailAnalysis(value: unknown): EmailAnalysis | undefined {
  const current = EmailAnalysisSchema.safeParse(value);
  if (current.success) return current.data;
  const drafted = DraftedEmailAnalysisSchema.safeParse(value);
  if (drafted.success) {
    return { ...drafted.data, replyDraftZh: "", replyDraftEn: "" };
  }
  const previous = PreviousEmailAnalysisSchema.safeParse(value);
  if (previous.success) return upgradePreviousAnalysis(previous.data);
  const legacy = LegacyEmailAnalysisSchema.safeParse(value);
  return legacy.success
    ? upgradePreviousAnalysis({ ...legacy.data, replyDraftZh: "" })
    : undefined;
}

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
- Analyze the newest sender-authored reply and the quoted thread history. The newest applicable creator/manager quote takes precedence, but older explicit quotes must still be captured and labeled thread_history.
- Produce a concise but complete Chinese summary.
- Extract only facts explicitly present in the email. Never invent a quote, currency, deliverable, date, right, payment term, or commitment.
- Extract every explicit creator or manager price into quoteItems, including per-deliverable rates, totals, ranges, packages, and multiple options. Preserve the exact relevant wording in originalText and provide a concise Chinese normalization in normalizedTextZh.
- quoteOriginalText combines the exact creator/manager pricing snippets. quoteNormalizedZh summarizes every current and historical option with scope, unit, range, package and source clearly labeled. If no creator/manager price exists, both strings are empty and quoteItems is empty.
- Do not mistake the brand's offer/budget, product value, affiliate commission, invoice for already-completed work, or a number appearing only in the outreach history as the creator's requested quote. Historical creator/manager quotes are valid only when authorship is clear.
- quotedAmount is only the single best-current applicable total when it is explicit and unambiguous. For unit-only pricing, ranges, multiple packages, or ambiguous scopes return null while retaining all details in quoteItems and quoteNormalizedZh.
- currency is the currency for quotedAmount only. Use uppercase ISO 4217 codes when explicit or unambiguous; otherwise null.
- Flag requests involving prepayment, perpetual or broad content rights, whitelisting, exclusivity, AI training, sublicensing, contract changes, or uncertain legal/payment terms.
- Reply drafting is disabled. Always return empty strings for replyDraftZh and replyDraftEn. Do not propose, translate, or generate any outbound reply text.
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
  return value.replace(/\u0000/gu, "").trim().slice(0, 30_000);
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
      max_output_tokens: 2_500,
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
