// Renders an email signature (F5.31) from a plain-text template.
//
// The template is NOT HTML. It is plain text with three things in it:
//   {{variable}}        replaced from the mailbox profile (fixed allowlist)
//   **bold**            bold text
//   [label](https://…)  a link; only https:, mailto: and tel: are accepted
// Everything else is escaped, so user input can never put markup, script or an
// unexpected URL scheme into the output. Variable values are inserted after the
// template is parsed, as literal text, so a value like "**x**" or "[a](b)" stays
// inert. The same renderer feeds the dashboard preview, the Roundcube plugin's
// files and the mail-server filter, so all three always agree.

export const SIGNATURE_VARIABLES = [
  "name",
  "title",
  "department",
  "phone",
  "mobile",
  "email",
  "company",
  "website",
] as const;
export type SignatureVariable = (typeof SIGNATURE_VARIABLES)[number];
export type SignatureVars = Partial<Record<SignatureVariable, string | null | undefined>>;

export interface RenderedBlock {
  html: string;
  text: string;
}

export interface RenderOptions {
  /** HTTPS URL of a logo shown above the text. */
  logoUrl?: string | null;
  /** Alt text for the logo, shown by clients that block remote images. */
  logoAlt?: string | null;
  /** Short per-sender token embedded as an HTML comment so a filter can tell the signature is already present. */
  marker?: string | null;
}

const VARIABLE_SET: ReadonlySet<string> = new Set(SIGNATURE_VARIABLES);
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/y;
const ANY_VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
// One level of nested parentheses is allowed in the URL, e.g. https://example.com/page_(info).
const LINK_PATTERN = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/y;
// Control characters except tab and newline, plus the bidirectional and zero-width
// characters that can disguise a link's real destination.
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const MAX_VALUE_LENGTH = 200;
const MAX_URL_LENGTH = 2000;
const MARKER_PATTERN = /^[a-z0-9]{4,32}$/;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normaliseTemplate(template: string): string {
  return template.replace(/\r\n?/g, "\n").replace(INVISIBLE_CHARS, "").replace(/\t/g, " ");
}

/** Makes a profile value safe to place in a single line: no control characters, collapsed whitespace, capped length. */
function cleanValue(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
}

export interface UrlOptions {
  /** Accept plain http only for localhost, so a development panel can still show its own logos. */
  allowHttpLocalhost?: boolean;
}

/**
 * Returns a normalised URL if it is safe to place in a link or image, otherwise null.
 * Accepts https:, mailto: and tel: only, and refuses credentials in the URL,
 * which are a common way to dress a hostile link up as a trusted one.
 */
export function sanitizeUrl(raw: string, options: UrlOptions = {}): string | null {
  const value = raw.replace(INVISIBLE_CHARS, "").trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  const lower = value.toLowerCase();

  if (lower.startsWith("mailto:")) {
    const address = value.slice(7);
    return /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(address)
      ? `mailto:${address}`
      : null;
  }

  if (lower.startsWith("tel:")) {
    const digits = value.slice(4).replace(/[^\d+]/g, "");
    return /^\+?\d{3,20}$/.test(digits) ? `tel:${digits}` : null;
  }

  if (/[\s"'<>\\`]/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && options.allowHttpLocalhost) {
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url.href : null;
  }
  return null;
}

export function isSafeLogoUrl(raw: string): boolean {
  return sanitizeUrl(raw, { allowHttpLocalhost: true }) !== null;
}

/** Checks a template at write time. Returns a list of problems, empty when it is acceptable. */
export function validateSignatureTemplate(template: string, maxLength: number): string[] {
  const problems: string[] = [];
  if (template.length > maxLength) problems.push(`Must be at most ${maxLength} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(template)) {
    problems.push("Contains control characters");
  }
  const unknown = new Set<string>();
  for (const match of template.matchAll(ANY_VARIABLE_PATTERN)) {
    const name = (match[1] ?? "").trim().toLowerCase();
    if (!VARIABLE_SET.has(name)) unknown.add(match[0]);
  }
  if (unknown.size > 0) {
    problems.push(`Unknown variable ${[...unknown].join(", ")}. Use: ${SIGNATURE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Part = { t: "text"; text: string } | { t: "var"; name: SignatureVariable };

type Inline =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "var"; name: SignatureVariable; bold: boolean }
  | { kind: "link"; label: Part[]; url: Part[]; bold: boolean };

function parseParts(source: string): Part[] {
  const parts: Part[] = [];
  let buffer = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "{") {
      VARIABLE_PATTERN.lastIndex = i;
      const match = VARIABLE_PATTERN.exec(source);
      const name = match?.[1]?.toLowerCase();
      if (match && name && VARIABLE_SET.has(name)) {
        if (buffer) parts.push({ t: "text", text: buffer });
        buffer = "";
        parts.push({ t: "var", name: name as SignatureVariable });
        i += match[0].length;
        continue;
      }
    }
    buffer += source[i];
    i += 1;
  }
  if (buffer) parts.push({ t: "text", text: buffer });
  return parts;
}

function parseLine(line: string): Inline[] {
  const nodes: Inline[] = [];
  // An odd number of ** means the last one has nothing to close, so it is shown literally.
  const boldMarkers = line.split("**").length - 1;
  const literalBoldAt = boldMarkers % 2 === 1 ? line.lastIndexOf("**") : -1;

  let bold = false;
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ kind: "text", text: buffer, bold });
    buffer = "";
  };

  let i = 0;
  while (i < line.length) {
    if (line.startsWith("**", i) && i !== literalBoldAt) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (line[i] === "[") {
      LINK_PATTERN.lastIndex = i;
      const match = LINK_PATTERN.exec(line);
      if (match) {
        flush();
        nodes.push({ kind: "link", label: parseParts(match[1] ?? ""), url: parseParts(match[2] ?? ""), bold });
        i += match[0].length;
        continue;
      }
    }
    if (line[i] === "{") {
      VARIABLE_PATTERN.lastIndex = i;
      const match = VARIABLE_PATTERN.exec(line);
      const name = match?.[1]?.toLowerCase();
      if (match && name && VARIABLE_SET.has(name)) {
        flush();
        nodes.push({ kind: "var", name: name as SignatureVariable, bold });
        i += match[0].length;
        continue;
      }
    }
    buffer += line[i];
    i += 1;
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// Resolving a line to display segments
// ---------------------------------------------------------------------------

interface Segment {
  text: string;
  bold: boolean;
  href?: string;
}

interface ResolvedLine {
  segments: Segment[];
  /** The line mentions at least one variable. */
  usesVariables: boolean;
  /** At least one variable on the line had a value. */
  hasValue: boolean;
  /** At least one variable on the line was empty. */
  hasEmpty: boolean;
}

function resolveLine(nodes: Inline[], vars: SignatureVars): ResolvedLine {
  const state = { usesVariables: false, hasValue: false, hasEmpty: false };

  const valueOf = (name: SignatureVariable): string => {
    const value = cleanValue(vars[name]);
    state.usesVariables = true;
    if (value) state.hasValue = true;
    else state.hasEmpty = true;
    return value;
  };
  const join = (parts: Part[]) => parts.map((part) => (part.t === "text" ? part.text : valueOf(part.name))).join("");

  const segments: Segment[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      segments.push({ text: node.text, bold: node.bold });
    } else if (node.kind === "var") {
      const value = valueOf(node.name);
      if (value) segments.push({ text: value, bold: node.bold });
    } else {
      const label = join(node.label).trim();
      const href = sanitizeUrl(join(node.url));
      if (label && href) segments.push({ text: label, bold: node.bold, href });
      else if (label) segments.push({ text: label, bold: node.bold });
      else if (href) segments.push({ text: href.replace(/^(mailto:|tel:)/, ""), bold: node.bold, href });
    }
  }
  return { segments, ...state };
}

/** Joins neighbouring plain segments, so separators on either side of an omitted variable end up in one string. */
function mergeSegments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && !previous.href && !segment.href && previous.bold === segment.bold) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * When a variable on a line was empty, tidies what it leaves behind:
 * "Ada |  | R&D" -> "Ada | R&D" and "Ada, " -> "Ada".
 */
function tidySegments(segments: Segment[]): Segment[] {
  const tidy = mergeSegments(segments).map((segment) => {
    if (segment.href) return segment;
    const text = segment.text
      .replace(/ {2,}/g, " ")
      .replace(/(?:\s*[|·•,;]\s*){2,}/g, (run) => {
        const separator = run.trim()[0] ?? "";
        return separator === "," || separator === ";" ? `${separator} ` : ` ${separator} `;
      });
    return { ...segment, text };
  });
  const first = tidy[0];
  const last = tidy[tidy.length - 1];
  if (first && !first.href) first.text = first.text.replace(/^[\s,;|·•\-–—]+/, "");
  if (last && !last.href) last.text = last.text.replace(/[\s,;|·•\-–—]+$/, "");
  return tidy.filter((segment) => segment.text !== "");
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const bare = (value: string) =>
  value.replace(/^(https?:\/\/|mailto:|tel:)/i, "").replace(/\/$/, "").toLowerCase();

function segmentsToHtml(segments: Segment[]): string {
  return segments
    .map((segment) => {
      const inner = segment.bold ? `<strong>${escapeHtml(segment.text)}</strong>` : escapeHtml(segment.text);
      return segment.href ? `<a href="${escapeHtml(segment.href)}">${inner}</a>` : inner;
    })
    .join("");
}

function segmentsToText(segments: Segment[]): string {
  return segments
    .map((segment) => {
      if (!segment.href || bare(segment.text) === bare(segment.href)) return segment.text;
      return `${segment.text} (${segment.href})`;
    })
    .join("");
}

interface RenderedLines {
  html: string[];
  text: string[];
}

/** Turns template text into display lines: variables filled in, lines whose variables are all empty dropped, blank lines collapsed. */
function renderLines(template: string, vars: SignatureVars): RenderedLines {
  const out: RenderedLines = { html: [], text: [] };

  for (const rawLine of normaliseTemplate(template).split("\n")) {
    const resolved = resolveLine(parseLine(rawLine.trimEnd()), vars);
    if (resolved.usesVariables && !resolved.hasValue) continue;

    const segments = resolved.hasEmpty ? tidySegments(resolved.segments) : resolved.segments;
    const html = segmentsToHtml(segments);
    const text = segmentsToText(segments);

    if (html === "" && text === "") {
      // A genuinely blank line: keep one for spacing, never two in a row.
      if (out.html.length > 0 && out.html[out.html.length - 1] !== "") {
        out.html.push("");
        out.text.push("");
      }
      continue;
    }
    out.html.push(html);
    out.text.push(text);
  }

  while (out.html.length > 0 && out.html[out.html.length - 1] === "") {
    out.html.pop();
    out.text.pop();
  }
  return out;
}

const SIGNATURE_STYLE = "font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45";
const NOTICE_STYLES = {
  banner: "margin-top:10px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4",
  compliance: "margin-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;color:#64748b",
} as const;

function linesToHtml(lines: string[]): string {
  return lines.join("<br>");
}

/**
 * Renders the personal signature. The text part has no "-- " delimiter;
 * composeSignature() adds it once in front of everything.
 * Returns null when there is nothing to show.
 */
export function renderSignatureTemplate(
  template: string,
  vars: SignatureVars,
  options: RenderOptions = {},
): RenderedBlock | null {
  const lines = renderLines(template, vars);
  const logoUrl = options.logoUrl ? sanitizeUrl(options.logoUrl, { allowHttpLocalhost: true }) : null;
  if (lines.html.length === 0 && !logoUrl) return null;

  const marker = options.marker && MARKER_PATTERN.test(options.marker) ? `<!--vx-sig:${options.marker}-->` : "";
  const alt = escapeHtml(cleanValue(options.logoAlt) || cleanValue(vars.company) || "Logo");
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${alt}" style="display:block;border:0;max-width:240px;max-height:80px;margin:0 0 8px 0">`
    : "";

  return {
    html: `${marker}<div style="${SIGNATURE_STYLE}">${logo}${linesToHtml(lines.html)}</div>`,
    text: lines.text.join("\n"),
  };
}

/** Renders a banner or the legal footer: the same text rules, without a logo. Null when empty. */
export function renderNoticeBlock(
  text: string,
  vars: SignatureVars,
  kind: keyof typeof NOTICE_STYLES,
): RenderedBlock | null {
  const lines = renderLines(text, vars);
  if (lines.html.length === 0) return null;
  return {
    html: `<div style="${NOTICE_STYLES[kind]}">${linesToHtml(lines.html)}</div>`,
    text: lines.text.join("\n"),
  };
}

export interface ComposeParts {
  signature?: RenderedBlock | null;
  banners?: RenderedBlock[];
  compliance?: RenderedBlock | null;
}

/** Joins the signature, any active banners and the legal footer into the final HTML and plain-text pair. Null when all are empty. */
export function composeSignature(parts: ComposeParts): RenderedBlock | null {
  const blocks = [parts.signature, ...(parts.banners ?? []), parts.compliance].filter(
    (block): block is RenderedBlock => !!block,
  );
  if (blocks.length === 0) return null;
  return {
    html: blocks.map((block) => block.html).join(""),
    text: `-- \n${blocks.map((block) => block.text).filter((t) => t !== "").join("\n\n")}`,
  };
}
