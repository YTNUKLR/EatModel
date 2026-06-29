import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/** Claude vision accepts these; iPhone HEIC must be converted first (see prepare-image). */
const MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Read an image off disk into a base64 vision content block. Shared by every
 * LLM parser (receipts, recipes) so the supported-format list lives in one place.
 */
export function imageBlock(imagePath: string): Anthropic.ImageBlockParam {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) {
    throw new Error(
      `unsupported image type "${ext}" (use jpg/png/gif/webp; convert iPhone HEIC to JPEG)`,
    );
  }
  const data = fs.readFileSync(imagePath).toString("base64");
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}
