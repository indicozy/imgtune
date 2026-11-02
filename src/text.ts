// Text that goes to the terminal, a file or a Markdown comment: control characters removed and length capped
// (safeText), and the escapes that stop page-derived text from formatting, linking or mentioning (mdText, mdCode).
// Page text is untrusted: every path that prints it goes through one of these.

// C0 and C1 controls, bidi embeddings, overrides and isolates, zero-width marks and the BOM: none of them may reach a reader
// of page-derived text (a bidi override reorders what follows it on screen).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** An ANSI escape sequence (a colour or cursor code): ESC, the parameter bytes, the final byte. Removed whole, not just ESC. */
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TEXT_LIMIT = 200;

/**
 * Page-derived text as it may be printed: ANSI escape sequences and C0 and C1 control characters removed (no escape
 * sequence reaches the terminal, and none leaves its parameters behind), and at most TEXT_LIMIT characters, the last
 * three of them "...". JSON output is not passed through here.
 */
export function stripControls(text: string): string {
  return text.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

/**
 * The first non-empty line of an error message, as it may be printed in a report or a terminal line. A browser error
 * carries more: Playwright adds a "Call log:" block of lines with ANSI colour codes, which a one-line report cannot hold.
 * The full message stays in the page's JSON.
 */
export function errorLine(text: string, limit = TEXT_LIMIT): string {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  return safeText(first.trim(), limit);
}

export function safeText(text: string, limit = TEXT_LIMIT): string {
  const clean = stripControls(text);
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

/**
 * A shell word for a printed command: the text as it is when it has only characters a shell reads literally, else
 * single-quoted with each embedded quote closed, escaped and reopened. Every path or value a printed command interpolates
 * goes through this, so a name in a run directory or a manifest cannot run anything when an agent pastes the command.
 */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
