import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RecipeParseResult } from "../shared/recipe-types";
import { imageBlock } from "./image";
import type { RecipeParser } from "./recipe-types";

const PROMPT = `You are reading a photo of a recipe, often a page from a cookbook. Extract the recipe's identity and its ingredient list ONLY — do not transcribe the step-by-step instructions.

Return:
- title: the recipe title if visible, else null
- sourceNote: where it's from (book title + page number, website, etc.) if visible, else null
- servings: the number of servings/yield as a number if stated, else null
- ingredients: one entry per ingredient line

For each ingredient line:
- rawText: the line exactly as printed (e.g. "2 cloves garlic, minced")
- ingredient: a cleaned, canonical ingredient name (e.g. "garlic") — drop quantities, units, and prep notes
- quantity + unit: the amount if given (e.g. 2 + "clove", 1.5 + "cup"), else null. Convert simple fractions to decimals (½ → 0.5).
- prepNote: preparation instructions on the line ("minced", "to taste", "softened"), else null
- optional: true if the line marks the ingredient as optional ("optional", "if desired"), else false

Only include actual ingredients. Ignore the method/instructions, headnotes, equipment lists, and nutrition panels.`;

export class LLMRecipeParser implements RecipeParser {
  readonly name = "llm";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    // Anthropic() reads ANTHROPIC_API_KEY from the env when no key is passed.
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
    this.model = opts.model ?? "claude-opus-4-8";
  }

  async parse(imagePath: string): Promise<RecipeParseResult> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [imageBlock(imagePath), { type: "text", text: PROMPT }],
        },
      ],
      output_config: { format: zodOutputFormat(RecipeParseResult) },
    });

    if (!res.parsed_output) {
      throw new Error(`model returned no structured output (stop_reason: ${res.stop_reason})`);
    }
    return res.parsed_output;
  }
}
