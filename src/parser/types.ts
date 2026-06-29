import type { ReceiptParseResult } from "../shared/types";

/**
 * The swap point for OCR. Today the only real implementation is LLMReceiptParser
 * (Claude vision). A Python OCR microservice, AWS Textract, etc. can implement
 * this same interface later with zero downstream changes — see ARCHITECTURE.md.
 */
export interface ReceiptParser {
  readonly name: string;
  /** Turn a receipt image on disk into structured, validated line items. */
  parse(imagePath: string): Promise<ReceiptParseResult>;
}
