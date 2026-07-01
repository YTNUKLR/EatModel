import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { FoodLinker, FoodLinkerInput, FoodLinkChoice } from "./food-linker";

const Choice = z.object({
  foodId: z
    .number()
    .int()
    .nullable()
    .describe("the id of the best-matching candidate, or null if none is a good match"),
  reason: z.string().describe("one short sentence explaining the choice or the abstention"),
});

const INSTRUCTIONS = `You link a recipe ingredient to its best USDA reference food for nutrition purposes.

You are given the ingredient name and a numbered shortlist of candidate foods (id + description).
Pick the ONE candidate whose nutrition best represents the ingredient as a recipe would use it:
- Prefer the plain, raw/basic form (recipes list raw ingredients) over cooked, canned, or prepared/branded entries, unless the ingredient itself names a prepared form.
- Match the cut/variety when it matters (e.g. "chicken thighs" → a thigh entry, not breast or ground).
- If NONE of the candidates is a genuinely good match, return foodId: null. Do not force a weak match — abstaining is correct and leaves the ingredient unlinked for a human.

Return only a candidate id from the list, or null.`;

/**
 * Claude-backed linker. Picks among the shortlist or abstains. A returned id
 * that isn't in the shortlist (a hallucinated id) is coerced to an abstain
 * rather than trusted — we never propose a food the ranker didn't surface.
 */
export class LlmFoodLinker implements FoodLinker {
  readonly name = "llm";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
    this.model = opts.model ?? "claude-opus-4-8";
  }

  async choose(input: FoodLinkerInput): Promise<FoodLinkChoice> {
    if (input.candidates.length === 0) return { foodId: null, reason: "no candidates" };

    const list = input.candidates.map((c) => `  ${c.id}: ${c.description}`).join("\n");
    const prompt = `${INSTRUCTIONS}\n\nIngredient: ${input.ingredientName}\nCandidates:\n${list}`;

    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      output_config: { format: zodOutputFormat(Choice) },
    });

    if (!res.parsed_output) {
      throw new Error(`linker returned no structured output (stop_reason: ${res.stop_reason})`);
    }
    const choice = res.parsed_output;
    if (choice.foodId != null && !input.candidates.some((c) => c.id === choice.foodId)) {
      return { foodId: null, reason: `model picked id ${choice.foodId} not in the shortlist — abstaining` };
    }
    return choice;
  }
}
