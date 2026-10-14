import { describe, expect, it } from "vitest";
import {
  composeSignature,
  renderNoticeBlock,
  renderSignatureTemplate,
  sanitizeUrl,
  validateSignatureTemplate,
} from "@vexlyx/shared";

const VARS = {
  name: "Ada Lovelace",
  title: "Engineer",
  department: "R&D",
  phone: "+44 20 7946 0000",
  mobile: "+44 7700 900123",
  email: "ada@example.com",
  company: "Analytical Engines Ltd",
  website: "example.com",
};

/** Everything the renderer may emit. After removing these, no markup characters may remain. */
const ALLOWED_TAGS = new Set(["div", "br", "strong", "a", "img"]);

function assertOnlyOurMarkup(html: string): void {
  const withoutMarker = html.replace(/<!--vx-sig:[a-z0-9]+-->/g, "");
  for (const match of withoutMarker.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, , tag = "", attrs = ""] = match;
    expect(ALLOWED_TAGS.has(tag.toLowerCase()), `unexpected <${tag}>`).toBe(true);
    const names = [...attrs.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
    const allowed: Record<string, string[]> = { a: ["href"], img: ["src", "alt", "style"], div: ["style"], br: [], strong: [] };
    for (const name of names) expect(allowed[tag.toLowerCase()], `${tag} has ${name}`).toContain(name);
    for (const url of attrs.matchAll(/(?:href|src)="([^"]*)"/g)) {
      expect(url[1]).toMatch(/^(https:|mailto:|tel:|http:\/\/localhost)/);
      expect(url[1]).not.toMatch(/^(javascript|data|vbscript):/i);
    }
  }
  const leftovers = withoutMarker.replace(/<\/?[a-zA-Z0-9]+[^>]*>/g, "");
  expect(leftovers, "raw angle bracket left in text").not.toMatch(/[<>]/);
}

describe("variables", () => {
  it("fills every variable and produces matching HTML and plain text", () => {
    const out = renderSignatureTemplate("{{name}}\n{{title}}, {{department}}\n{{company}}\n{{email}} | {{phone}} | {{mobile}}\n{{website}}", VARS)!;
    expect(out.text).toBe(
      ["Ada Lovelace", "Engineer, R&D", "Analytical Engines Ltd", "ada@example.com | +44 20 7946 0000 | +44 7700 900123", "example.com"].join("\n"),
    );
    expect(out.html).toContain("Ada Lovelace<br>Engineer, R&amp;D<br>Analytical Engines Ltd");
    assertOnlyOurMarkup(out.html);
  });

  it("accepts spacing and case inside the braces", () => {
    expect(renderSignatureTemplate("{{ Name }} / {{TITLE}}", VARS)!.text).toBe("Ada Lovelace / Engineer");
  });

  it("drops a line whose variables are all empty, but keeps lines with no variables", () => {
    const out = renderSignatureTemplate("Best regards\n{{name}}\nMobile: {{mobile}}\nTel: {{phone}}", { name: "Ada", phone: "123" })!;
    expect(out.text).toBe("Best regards\nAda\nTel: 123");
  });

  it("tidies separators left dangling by an empty variable", () => {
    expect(renderSignatureTemplate("{{name}}, {{title}}", { name: "Ada" })!.text).toBe("Ada");
    expect(renderSignatureTemplate("{{title}} - {{name}}", { name: "Ada" })!.text).toBe("Ada");
    expect(renderSignatureTemplate("{{name}} | {{title}} | {{department}}", { name: "Ada", department: "R&D" })!.text).toBe("Ada | R&D");
  });

  it("leaves punctuation alone when every variable on the line has a value", () => {
    expect(renderSignatureTemplate("-- {{name}} --", { name: "Ada" })!.text).toBe("-- Ada --");
  });

  it("leaves an unknown variable as literal text", () => {
    expect(renderSignatureTemplate("Hi {{nope}}", VARS)!.text).toBe("Hi {{nope}}");
  });

  it("collapses repeated blank lines and trims blank lines at the ends", () => {
    const out = renderSignatureTemplate("\n\nAda\n\n\n\nLovelace\n\n", {})!;
    expect(out.text).toBe("Ada\n\nLovelace");
  });

  it("returns null when nothing is left to show", () => {
    expect(renderSignatureTemplate("{{name}}\n{{title}}", {})).toBeNull();
    expect(renderSignatureTemplate("", VARS)).toBeNull();
  });
});

describe("markup", () => {
  it("renders **bold** as <strong> and plain text", () => {
    const out = renderSignatureTemplate("**{{name}}**, Engineer", VARS)!;
    expect(out.html).toContain("<strong>Ada Lovelace</strong>, Engineer");
    expect(out.text).toBe("Ada Lovelace, Engineer");
  });

  it("pairs ** markers left to right and shows a leftover one literally", () => {
    expect(renderSignatureTemplate("5 ** 3", {})!.text).toBe("5 ** 3");
    expect(renderSignatureTemplate("**oops", {})!.text).toBe("**oops");
    const out = renderSignatureTemplate("a **b** c ** d", {})!;
    expect(out.html).toContain("a <strong>b</strong> c ** d");
    expect(out.text).toBe("a b c ** d");
  });

  it("renders https, mailto and tel links, with the URL in the plain-text version", () => {
    const out = renderSignatureTemplate("[Our site](https://example.com/about) [Mail](mailto:ada@example.com) [Call](tel:+44 20 7946 0000)", {})!;
    expect(out.html).toContain('<a href="https://example.com/about">Our site</a>');
    expect(out.html).toContain('<a href="mailto:ada@example.com">Mail</a>');
    expect(out.html).toContain('<a href="tel:+442079460000">Call</a>');
    expect(out.text).toBe("Our site (https://example.com/about) Mail (mailto:ada@example.com) Call (tel:+442079460000)");
  });

  it("does not repeat a URL that is already the link text", () => {
    const out = renderSignatureTemplate("[{{website}}](https://{{website}})", VARS)!;
    expect(out.html).toContain('<a href="https://example.com/">example.com</a>');
    expect(out.text).toBe("example.com");
  });

  it("builds a link from variables and drops it when the variable is empty", () => {
    expect(renderSignatureTemplate("[Email me](mailto:{{email}})", VARS)!.html).toContain('href="mailto:ada@example.com"');
    expect(renderSignatureTemplate("Web: [{{website}}](https://{{website}})", {})).toBeNull();
  });

  it("shows the label without a link when the URL is not acceptable", () => {
    for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "ftp://example.com", "//example.com", "example.com"]) {
      const out = renderSignatureTemplate(`[click](${url})`, {})!;
      expect(out.html, url).not.toContain("<a ");
      expect(out.text, url).toBe("click");
    }
  });
});

describe("injection corpus", () => {
  const PAYLOADS = [
    "<script>alert(1)</script>",
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "<svg/onload=alert(1)>",
    "<iframe src=javascript:alert(1)>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<style>body{display:none}</style>",
    "<div style=\"background:url(javascript:alert(1))\">x</div>",
    "<!--<script>-->",
    "<math><mi xlink:href=\"data:x,\">",
    "javascript:alert(1)",
    "' onmouseover='alert(1)",
    "\" onfocus=\"alert(1)\" autofocus=\"",
    "&lt;script&gt;",
    "<body onload=alert(1)>",
    "<form action=https://evil.example><input name=pw></form>",
  ];

  it.each(PAYLOADS)("keeps %j inert when it is a variable value", (payload) => {
    const out = renderSignatureTemplate("{{name}}\n{{title}}\n[Site](https://{{website}})", { name: payload, title: payload, website: payload })!;
    assertOnlyOurMarkup(out.html);
    // The payload is shown as escaped text; what must never appear is a real tag opener.
    expect(out.html).not.toMatch(/<(script|iframe|svg|style|form|body|math|input)/i);
  });

  it.each(PAYLOADS)("keeps %j inert when it is written into the template", (payload) => {
    const out = renderSignatureTemplate(`${payload}\n**${payload}**\n[${payload}](${payload})\n[x](https://example.com/${payload})`, {})!;
    assertOnlyOurMarkup(out.html);
  });

  it.each(PAYLOADS)("keeps %j inert as a logo URL, alt text and company", (payload) => {
    const out = renderSignatureTemplate("Hi", { company: payload }, { logoUrl: `https://example.com/${payload}`, logoAlt: payload })!;
    assertOnlyOurMarkup(out.html);
  });

  it("does not interpret markup that arrives inside a variable value", () => {
    const out = renderSignatureTemplate("{{name}}", { name: "**bold** [x](https://evil.example) {{title}}", title: "SECRET" })!;
    expect(out.html).not.toContain("<strong>");
    expect(out.html).not.toContain("<a ");
    expect(out.html).not.toContain("SECRET");
    expect(out.text).toBe("**bold** [x](https://evil.example) {{title}}");
  });

  it("cannot be used to inject headers or extra lines through a value", () => {
    const out = renderSignatureTemplate("{{name}}", { name: "Ada\r\nBcc: victim@example.com\nSubject: x" })!;
    expect(out.text).toBe("Ada Bcc: victim@example.com Subject: x");
    expect(out.html).not.toMatch(/\r|\n/);
  });

  it("removes bidirectional and zero-width characters that can disguise a destination", () => {
    const out = renderSignatureTemplate("{{name}}", { name: "good‮evil​.com﻿" })!;
    expect(out.text).toBe("goodevil.com");
  });

  it("caps very long values", () => {
    expect(renderSignatureTemplate("{{name}}", { name: "a".repeat(5000) })!.text).toHaveLength(200);
  });
});

describe("sanitizeUrl", () => {
  it("accepts https, mailto and tel", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com/");
    expect(sanitizeUrl("https://example.com/a?b=1&c=2")).toBe("https://example.com/a?b=1&c=2");
    expect(sanitizeUrl("mailto:ada@example.com")).toBe("mailto:ada@example.com");
    expect(sanitizeUrl("tel:+44 (20) 7946-0000")).toBe("tel:+442079460000");
  });

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:x",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://good.com@evil.com",
    "https://exa mple.com",
    'https://example.com/"onmouseover="x',
    "https://example.com/<script>",
    "mailto:not-an-address",
    "mailto:a@b",
    "tel:abc",
    "tel:12",
    "",
  ])("rejects %j", (url) => {
    expect(sanitizeUrl(url)).toBeNull();
  });

  it("allows plain http only for localhost, and only when asked", () => {
    expect(sanitizeUrl("http://localhost:5000/logo.png")).toBeNull();
    expect(sanitizeUrl("http://localhost:5000/logo.png", { allowHttpLocalhost: true })).toBe("http://localhost:5000/logo.png");
    expect(sanitizeUrl("http://evil.example/logo.png", { allowHttpLocalhost: true })).toBeNull();
  });
});

describe("logo, marker, banners, compliance", () => {
  it("adds the logo with alt text and the marker comment", () => {
    const out = renderSignatureTemplate("{{name}}", VARS, { logoUrl: "https://example.com/logo.png", marker: "ab12cd34" })!;
    expect(out.html.startsWith("<!--vx-sig:ab12cd34-->")).toBe(true);
    expect(out.html).toContain('<img src="https://example.com/logo.png" alt="Analytical Engines Ltd"');
    assertOnlyOurMarkup(out.html);
  });

  it("ignores an unsafe logo URL and an invalid marker", () => {
    const out = renderSignatureTemplate("{{name}}", VARS, { logoUrl: "javascript:alert(1)", marker: "--><script>" })!;
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toContain("<!--");
  });

  it("renders a logo-only signature", () => {
    const out = renderSignatureTemplate("", {}, { logoUrl: "https://example.com/logo.png" })!;
    expect(out.html).toContain("<img");
    expect(out.text).toBe("");
  });

  it("composes signature, banners and compliance with one -- delimiter", () => {
    const signature = renderSignatureTemplate("{{name}}", VARS)!;
    const banner = renderNoticeBlock("Closed **24 Dec**", VARS, "banner")!;
    const compliance = renderNoticeBlock("Registered in England No. 123", VARS, "compliance")!;
    const out = composeSignature({ signature, banners: [banner], compliance })!;
    expect(out.text).toBe("-- \nAda Lovelace\n\nClosed 24 Dec\n\nRegistered in England No. 123");
    expect(out.html.indexOf("Ada Lovelace")).toBeLessThan(out.html.indexOf("Closed"));
    expect(out.html.indexOf("Closed")).toBeLessThan(out.html.indexOf("Registered"));
    assertOnlyOurMarkup(out.html);
  });

  it("shows the compliance footer even when there is no personal signature", () => {
    const compliance = renderNoticeBlock("Confidential", {}, "compliance")!;
    expect(composeSignature({ signature: null, compliance })!.text).toBe("-- \nConfidential");
  });

  it("returns null when every part is empty", () => {
    expect(composeSignature({ signature: null, banners: [], compliance: null })).toBeNull();
    expect(renderNoticeBlock("{{phone}}", {}, "banner")).toBeNull();
  });
});

describe("validateSignatureTemplate", () => {
  it("accepts a normal template", () => {
    expect(validateSignatureTemplate("**{{name}}**\n[{{website}}](https://{{website}})", 4000)).toEqual([]);
  });

  it("reports unknown variables, with the allowed list", () => {
    const [problem] = validateSignatureTemplate("Hi {{nmae}} and {{ phone }}", 4000);
    expect(problem).toContain("{{nmae}}");
    expect(problem).toContain("{{name}}");
    expect(problem).not.toContain("{{ phone }}");
  });

  it("enforces the length and rejects control characters", () => {
    expect(validateSignatureTemplate("a".repeat(11), 10)[0]).toContain("at most 10");
    expect(validateSignatureTemplate("a\u0000b", 100)[0]).toContain("control");
    expect(validateSignatureTemplate("tabs\tand\nnewlines are fine", 100)).toEqual([]);
  });
});
