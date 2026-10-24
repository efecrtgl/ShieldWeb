const { marked, Marked } = require("marked");
const { sanitizeRichText } = require("./html");

const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#)/i;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

// Update notes are written by staff and shown on public pages: raw HTML in the markdown is shown as text, and links or
// images may only point to http(s), mailto, site-relative or in-page targets (no javascript: / data: URLs).
marked.use({
  breaks: true,
  gfm: true,
  walkTokens(token) {
    if (token.type === "html") {
      token.type = "text";
      token.text = escapeHtml(token.raw);
      token.escaped = true;
      delete token.tokens;
    } else if ((token.type === "link" || token.type === "image") && !SAFE_URL.test(String(token.href || "").trim())) {
      token.href = "#";
    }
  }
});

function renderMarkdown(text) {
  return marked.parse(text || "");
}

// Rich text that may mix markdown with the admin editor's HTML: rendered with HTML allowed, then reduced to an
// allowlist of formatting tags (see utils/html.js).
const richMarked = new Marked({ breaks: true, gfm: true });
function renderRichText(text) {
  return sanitizeRichText(richMarked.parse(text || ""));
}

module.exports = { renderMarkdown, renderRichText };
