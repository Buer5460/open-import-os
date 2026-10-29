/**
 * Growth / CRM contracts, including the external-agent (Grok Bot) task
 * package and result schemas.
 */
import { z } from "zod";

export const LeadTypeSchema = z.enum([
  "SELLER",
  "IMPORTER",
  "FREIGHT_FORWARDER",
  "CUSTOMS_BROKER",
  "ECOMMERCE_SERVICE",
  "INTEGRATION_PARTNER",
]);

export const LeadStatusSchema = z.enum([
  "NEW",
  "VERIFIED",
  "QUALIFIED",
  "DRAFT_READY",
  "APPROVED",
  "CONTACTED",
  "REPLIED",
  "TRIAL_INVITED",
  "SKU_RECEIVED",
  "CALCULATED",
  "REUSED",
  "PAID_PILOT",
  "DISQUALIFIED",
  "NO_RESPONSE",
  "DO_NOT_CONTACT",
  "ARCHIVED",
]);

/** Only the minimum public business data we are willing to collect. */
export const LeadInputSchema = z.object({
  leadType: LeadTypeSchema.default("SELLER"),
  companyName: z.string().min(1).max(300),
  website: z.string().url().nullish(),
  country: z.string().nullish(),
  language: z.string().nullish(),
  businessType: z.string().nullish(),
  categories: z.array(z.string()).default([]),
  salesChannels: z.array(z.string()).default([]),
  publicBusinessContact: z.string().nullish(),
  sourceUrls: z.array(z.string().url()).default([]),
  evidenceExcerpt: z.string().max(4000).nullish(),
  observedAt: z.coerce.date().nullish(),
  fitReason: z.string().nullish(),
  unknowns: z.array(z.string()).default([]),
  doNotContact: z.boolean().default(false),
});
export type LeadInput = z.infer<typeof LeadInputSchema>;

/** Score dimensions. Each must carry evidence or be marked unknown. */
export const ScoreDimensionSchema = z.enum([
  "US_IMPORT_RELEVANCE",
  "COST_PAIN",
  "REPEAT_PURCHASE",
  "PRODUCT_FIT",
  "CONTACTABLE",
]);

export const ScoreBreakdownItemSchema = z.object({
  dimension: ScoreDimensionSchema,
  maxPoints: z.number().int().positive(),
  points: z.number().int().nonnegative(),
  // "unknown" scores 0 and is flagged, never guessed.
  state: z.enum(["SCORED", "UNKNOWN", "NOT_APPLICABLE"]),
  evidence: z.string().nullish(),
  sourceUrl: z.string().url().nullish(),
});

export const LeadScoreSchema = z.object({
  total: z.number().int().nonnegative(),
  breakdown: z.array(ScoreBreakdownItemSchema),
  rulesVersion: z.string(),
});

/** Lead import (CSV/JSON) - imported leads must carry a source declaration. */
export const LeadImportRowSchema = LeadInputSchema.extend({
  sourceDeclaration: z.string().min(1).max(500),
});

// ---------------------------------------------------------------------------
// External research agent (Grok Bot) task package & result
// ---------------------------------------------------------------------------

export const ExternalTaskPackageSchema = z.object({
  task_id: z.string(),
  tenant_id: z.string(),
  campaign_id: z.string().nullish(),
  target_profile: z.object({
    leadTypes: z.array(LeadTypeSchema).default([]),
    countries: z.array(z.string()).default([]),
    description: z.string(),
  }),
  keywords: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  language: z.string().default("zh"),
  target_count: z.number().int().positive().default(20),
  max_count: z.number().int().positive().default(50),
  source_restrictions: z.array(z.string()).default([]),
  budget: z.object({
    max_candidates: z.number().int().positive(),
    notes: z.string().nullish(),
  }),
  return_schema: z.object({
    format: z.literal("JSON"),
    schema_url: z.string().url().nullish(),
    notes: z.string().nullish(),
  }),
  instructions: z.string(),
  idempotency_key: z.string(),
});
export type ExternalTaskPackage = z.infer<typeof ExternalTaskPackageSchema>;

export const ExternalLeadResultSchema = z.object({
  company_name: z.string().min(1),
  website: z.string().url().nullish(),
  normalized_domain: z.string().nullish(),
  country: z.string().nullish(),
  business_type: z.string().nullish(),
  categories: z.array(z.string()).default([]),
  sales_channels: z.array(z.string()).default([]),
  public_business_contact: z.string().nullish(),
  lead_type: LeadTypeSchema.nullish(),
  evidence: z
    .array(
      z.object({
        source_url: z.string().url(),
        excerpt: z.string().max(2000),
        observed_at: z.coerce.date().nullish(),
      }),
    )
    .default([]),
  unknowns: z.array(z.string()).default([]),
  fit_reason: z.string().nullish(),
});
export type ExternalLeadResult = z.infer<typeof ExternalLeadResultSchema>;

export const ExternalResultSchema = z.object({
  task_id: z.string(),
  external_run_id: z.string(),
  sources: z.array(z.string()).default([]),
  leads: z.array(ExternalLeadResultSchema).default([]),
  errors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        detail: z.string().nullish(),
      }),
    )
    .default([]),
  started_at: z.coerce.date().nullish(),
  finished_at: z.coerce.date().nullish(),
});
export type ExternalResult = z.infer<typeof ExternalResultSchema>;

/** Outreach draft generation. */
export const OutreachDraftInputSchema = z.object({
  leadId: z.string(),
  channel: z.enum(["EMAIL", "LINKEDIN", "X", "REDDIT", "PHONE", "WEBSITE_FORM"]).default("EMAIL"),
  language: z.enum(["zh", "en"]).default("zh"),
  // The offer must be honest: trial-recruit vs live.
  offerKind: z.enum(["TRIAL_RECRUIT", "SAMPLE_DEMO"]).default("TRIAL_RECRUIT"),
});

export const OutreachDraftSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  channel: z.string(),
  language: z.string(),
  subject: z.string(),
  body: z.string(),
  // Every factual claim traced to a source; unknown facts are not invented.
  claims: z.array(
    z.object({
      text: z.string(),
      sourceUrl: z.string().nullish(),
      kind: z.enum(["SOURCED", "UNKNOWN_PLACEHOLDER"]),
    }),
  ),
  version: z.number().int().positive(),
  state: z.string(),
  createdAt: z.coerce.date(),
});
