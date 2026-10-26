/**
 * Turns fetched documentation into plain text so the build can check that
 * every quote and user-agent token really appears on the page it cites.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  zwj: "",
  zwnj: "",
  shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul";

/** Plain text of an HTML page, with whitespace collapsed. Plain text input passes through. */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const blocks = withoutCode.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), " ");
  const inline = blocks.replace(/<[^>]+>/g, "");
  return collapse(decodeEntities(inline));
}

export function collapse(text: string): string {
  return text.replace(/[\s ​]+/g, " ").trim();
}

/** Folds typographic punctuation and Markdown emphasis so near-identical renderings compare equal. */
export function looseForm(text: string): string {
  return collapse(
    text
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/…/g, "...")
      .replace(/[*`]/g, ""),
  );
}

export type MatchResult = "verbatim" | "punctuation" | "not_found";

/**
 * Looks for `needle` in `haystack` (already plain text). `verbatim` means an
 * exact match after collapsing whitespace. `punctuation` means it matches only
 * after folding quotes, dashes and Markdown emphasis.
 */
export function findText(needle: string, haystack: string): MatchResult {
  if (haystack.includes(collapse(needle))) return "verbatim";
  if (looseForm(haystack).includes(looseForm(needle))) return "punctuation";
  return "not_found";
}
