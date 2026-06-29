/**
 * Name a file is given once moved out of an inbox. Prefixing with the content
 * hash keeps two *different* images that happen to share a basename (e.g. two
 * phones both producing `IMG_0001.jpg`) from overwriting each other in the
 * processed/failed folder — we promised to keep originals for re-parsing.
 */
export function processedName(imageSha256: string, file: string): string {
  return `${imageSha256.slice(0, 12)}-${file}`;
}
