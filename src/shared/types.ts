import { z } from "zod";

/**
 * The validated shape a ReceiptParser must return. This is the contract between
 * the parser (OCR) and everything downstream (matching, persistence). Define it
 * once here so the LLM parser, the mock parser, and the DB layer all agree.
 *
 * Fields the model can't read are `null` rather than omitted — structured
 * outputs require every property, so "unknown" is expressed as null.
 */
export const ParsedLineItem = z.object({
  /** The line exactly as printed on the receipt, e.g. "GV CHKN THGH 2.49". */
  rawText: z.string(),
  /** A cleaned, human-readable product name, e.g. "Chicken thighs, boneless skinless". */
  description: z.string(),
  quantity: z.number().nullable(),
  /** Unit for the quantity, e.g. "lb", "each", "bag". */
  unit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  lineTotal: z.number().nullable(),
});
export type ParsedLineItem = z.infer<typeof ParsedLineItem>;

export const ReceiptParseResult = z.object({
  store: z.string().nullable(),
  /** Purchase date, ISO 8601 if legible, else null. */
  purchasedAt: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string(),
  lines: z.array(ParsedLineItem),
});
export type ReceiptParseResult = z.infer<typeof ReceiptParseResult>;
