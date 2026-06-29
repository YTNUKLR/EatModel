import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ReceiptParseResult } from "../shared/types";
import { imageBlock } from "./image";
import type { ReceiptParser } from "./types";

const PROMPT = `You are reading a photo of a grocery store receipt. Extract every purchased product line.

Return:
- store: the store/brand name if visible, else null
- purchasedAt: the purchase date as ISO 8601 (YYYY-MM-DD) if legible, else null
- total: the final order total as a number, else null
- currency: the ISO currency code (e.g. "USD"); default "USD" if not shown
- lines: one entry per purchased product

For each line item:
- rawText: the line exactly as printed (keep abbreviations, e.g. "GV CHKN THGH 2.49")
- description: a cleaned, human-readable product name (expand abbreviations)
- quantity + unit: if the line shows a weight or count (e.g. "1.24 lb", "2 @"), else null
- unitPrice and lineTotal as numbers where shown, else null

Only include actual products. Ignore subtotals, tax, discounts, coupons, loyalty savings, payment/tender, and change lines.`;

export class LLMReceiptParser implements ReceiptParser {
  readonly name = "llm";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    // Anthropic() reads ANTHROPIC_API_KEY from the env when no key is passed.
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
    this.model = opts.model ?? "claude-opus-4-8";
  }

  async parse(imagePath: string): Promise<ReceiptParseResult> {
    // messages.parse + zodOutputFormat constrains the response to our schema and
    // returns it already validated — no hand-parsing of model text.
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [imageBlock(imagePath), { type: "text", text: PROMPT }],
        },
      ],
      output_config: { format: zodOutputFormat(ReceiptParseResult) },
    });

    if (!res.parsed_output) {
      throw new Error(`model returned no structured output (stop_reason: ${res.stop_reason})`);
    }
    return res.parsed_output;
  }
}
