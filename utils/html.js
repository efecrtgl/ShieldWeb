// Allowlist sanitizer for the small rich-text fields written with the admin editor (application descriptions).
// Allowed tags are rebuilt from scratch with no attributes except a checked href on <a>; every other tag is dropped and
// any remaining "<" / ">" in the text is escaped, so nothing the author typed can become markup or script.
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "del", "br", "hr", "p", "div", "span", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "blockquote", "code", "pre"]);
const VOID_TAGS = new Set(["br", "hr"]);
const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

function escapeText(text) {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hrefOf(attrs) {
  const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if (!m) return null;
  const raw = (m[2] ?? m[3] ?? m[4] ?? "").trim().replace(/&amp;/g, "&");
  if (!SAFE_HREF.test(raw)) return null;
  return raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeRichText(html) {
  const input = String(html || "");
  let out = "";
  let last = 0;
  for (const m of input.matchAll(TAG)) {
    out += escapeText(input.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
      continue;
    }
    if (tag === "a") {
      const href = hrefOf(m[3]);
      out += href ? `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank">` : "<a>";
    } else {
      out += `<${tag}>`;
    }
  }
  return out + escapeText(input.slice(last));
}

module.exports = { sanitizeRichText };
