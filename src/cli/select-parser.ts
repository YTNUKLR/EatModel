import { LLMReceiptParser } from "../parser/llm";
import { MockReceiptParser } from "../parser/mock";
import type { ReceiptParser } from "../parser/types";

/**
 * Choose the parser from the environment, **failing loudly rather than silently
 * downgrading**. The default is the real LLM parser; the mock is used only when
 * explicitly requested (`EATMODEL_PARSER=mock` / `npm run process:mock`). This
 * way a missing API key can never quietly save canned demo data over a real run.
 */
export function selectParser(env: NodeJS.ProcessEnv = process.env): ReceiptParser {
  const choice = env.EATMODEL_PARSER ?? "llm";

  if (choice === "mock") return new MockReceiptParser();

  if (choice === "llm") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — set it (e.g. in .env) to run the real OCR, " +
          "or use `npm run process:mock` for canned demo data.",
      );
    }
    return new LLMReceiptParser({ apiKey: env.ANTHROPIC_API_KEY, model: env.EATMODEL_MODEL });
  }

  throw new Error(`unknown EATMODEL_PARSER "${choice}" — use "llm" or "mock"`);
}
