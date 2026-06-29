import path from "node:path";
import type { ReceiptParseResult } from "../shared/types";
import type { ReceiptParser } from "./types";

/**
 * Returns canned data regardless of the image. Lets the whole pipeline
 * (matching → SQLite → price history) run with no API key or cost, so the
 * plumbing can be verified before pointing real receipts at the LLM parser.
 */
export class MockReceiptParser implements ReceiptParser {
  readonly name = "mock";

  async parse(imagePath: string): Promise<ReceiptParseResult> {
    void path.basename(imagePath); // image content is ignored in mock mode
    return {
      store: "Demo Market",
      purchasedAt: "2026-06-28",
      total: 12.02,
      currency: "USD",
      lines: [
        {
          rawText: "GV CHKN THGH 2.49",
          description: "Chicken thighs, boneless skinless",
          quantity: 1.5,
          unit: "lb",
          unitPrice: 2.49,
          lineTotal: 3.74,
        },
        {
          rawText: "ORG SPINACH 3.99",
          description: "Organic baby spinach",
          quantity: 1,
          unit: "each",
          unitPrice: 3.99,
          lineTotal: 3.99,
        },
        {
          rawText: "BROWN RICE 2LB 4.29",
          description: "Brown rice",
          quantity: 1,
          unit: "bag",
          unitPrice: 4.29,
          lineTotal: 4.29,
        },
      ],
    };
  }
}
