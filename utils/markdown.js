const { marked } = require("marked");

marked.use({ breaks: true, gfm: true });

function renderMarkdown(text) {
  return marked.parse(text || "");
}

module.exports = { renderMarkdown };
