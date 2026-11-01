// Text that goes to the terminal, a file or a Markdown comment: control characters removed and length capped
// (safeText), and the escapes that stop page-derived text from formatting, linking or mentioning (mdText, mdCode).
// Page text is untrusted: every path that prints it goes through one of these.

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const TEXT_LIMIT = 200;

/**
 * Page-derived text as it may be printed: C0 and C1 control characters removed (no escape sequences reach the
 * terminal), and at most TEXT_LIMIT characters, the last three of them "...". JSON output is not passed through here.
 */
export function safeText(text: string, limit = TEXT_LIMIT): string {
  const clean = text.replace(CONTROL_CHARS, "");
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

/** Markdown-significant characters of plain text, replaced by HTML entities so they cannot format, link or mention. */
const MD_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "[": "&#91;",
  "]": "&#93;",
  "`": "&#96;",
  "*": "&#42;",
  _: "&#95;",
  "|": "&#124;",
  "\\": "&#92;",
  "@": "&#64;",
  "#": "&#35;",
  "~": "&#126;",
  "$": "&#36;",
  ":": "&#58;",
};

/**
 * Plain text for a Markdown cell or list line, for text this module writes itself: control characters removed, then
 * escaped. The colon and the "www." prefix are escaped too, so GitHub does not autolink a URL typed in a page's text.
 */
export function mdText(text: string, limit?: number): string {
  return safeText(text, limit).replace(/www\.|[&<>[\]`*_|\\@#~$:]/gi, (match) => (match === "." || match.toLowerCase() === "www." ? "www&#46;" : MD_ENTITIES[match]));
}

/**
 * Page-derived text as an inline code span. A code span does not autolink, mention, link or format its content, so
 * this is what every page-derived field uses. Inside: backticks become an apostrophe-like modifier, `<` becomes a
 * single-angle quote (no HTML comment can open), and pipes are escaped so the table cell does not split.
 */
export function mdCode(text: string): string {
  const clean = safeText(text).replace(/`/g, "ʼ").replace(/</g, "‹").replace(/\|/g, "\\|");
  return `\`${clean === "" ? "-" : clean}\``;
}
