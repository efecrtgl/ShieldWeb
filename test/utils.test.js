const test = require("node:test");
const assert = require("node:assert");
const { wantsJson, escapeRegex, searchRegex, clientIp, isSnowflake } = require("../utils/http");
const { formatDateTr, hexToRgb } = require("../utils/format");
const { userAvatarUrl, defaultAvatarUrl } = require("../utils/discordAvatar");

test("escapeRegex neutralizes regex metacharacters", () => {
  const input = "a.b*c(d)[e]{f}+?^$|\\/-";
  assert.ok(new RegExp(escapeRegex(input)).test(input));
  assert.ok(!new RegExp(escapeRegex("a.b")).test("axb"));
  assert.deepStrictEqual(searchRegex("(x"), { $regex: "\\(x", $options: "i" });
});

test("wantsJson detects XHR, JSON accept and JSON bodies", () => {
  assert.strictEqual(wantsJson({ xhr: true, headers: {} }), true);
  assert.strictEqual(wantsJson({ headers: { accept: "application/json" } }), true);
  assert.strictEqual(wantsJson({ headers: { "content-type": "application/json; charset=utf-8" } }), true);
  assert.strictEqual(wantsJson({ headers: { accept: "text/html" } }), false);
});

test("clientIp strips the IPv4-mapped IPv6 prefix", () => {
  assert.strictEqual(clientIp({ ip: "::ffff:10.0.0.5" }), "10.0.0.5");
  assert.strictEqual(clientIp({ ip: "::1" }), "::1");
});

test("isSnowflake accepts only 17-20 digit ids", () => {
  assert.strictEqual(isSnowflake("444578261494661122"), true);
  assert.strictEqual(isSnowflake(" 444578261494661122 "), true);
  assert.strictEqual(isSnowflake("1234"), false);
  assert.strictEqual(isSnowflake("none"), false);
  assert.strictEqual(isSnowflake(undefined), false);
});

test("formatDateTr and hexToRgb", () => {
  assert.strictEqual(formatDateTr(new Date(2026, 0, 5, 7, 3)), "05.01.2026 07:03");
  assert.strictEqual(formatDateTr("not a date"), null);
  assert.strictEqual(hexToRgb("#0071e3"), "0, 113, 227");
  assert.strictEqual(hexToRgb("#fff"), "255, 255, 255");
  assert.strictEqual(hexToRgb("bogus"), "0, 113, 227");
});

test("Discord avatar URLs", () => {
  assert.strictEqual(userAvatarUrl({ id: "1", avatar: "a_abc" }), "https://cdn.discordapp.com/avatars/1/a_abc.gif");
  assert.strictEqual(userAvatarUrl({ id: "1", avatar: "abc" }), "https://cdn.discordapp.com/avatars/1/abc.png");
  assert.match(defaultAvatarUrl("444578261494661122"), /embed\/avatars\/[0-5]\.png$/);
  assert.strictEqual(defaultAvatarUrl("not-a-number"), "https://cdn.discordapp.com/embed/avatars/0.png");
});

test("update-note markdown shows raw HTML as text and drops unsafe link targets", () => {
  const { renderMarkdown } = require("../utils/markdown");
  assert.ok(!renderMarkdown("<img src=x onerror=alert(1)>").includes("<img"));
  assert.ok(!renderMarkdown("a <script>alert(1)</script>").includes("<script"));
  assert.ok(renderMarkdown("[x](javascript:alert(1))").includes('href="#"'));
  assert.ok(renderMarkdown("**ok** [l](https://example.com)").includes('<a href="https://example.com">'));
});

test("rich-text sanitizer keeps formatting and removes everything executable", () => {
  const { sanitizeRichText } = require("../utils/html");
  assert.strictEqual(sanitizeRichText("<b>a</b><i>b</i><br><ul><li>c</li></ul>"), "<b>a</b><i>b</i><br><ul><li>c</li></ul>");
  assert.strictEqual(sanitizeRichText("<img src=x onerror=alert(1)>"), "");
  assert.strictEqual(sanitizeRichText('<div onclick="x" style="y">d</div>'), "<div>d</div>");
  assert.strictEqual(sanitizeRichText('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
  assert.ok(sanitizeRichText('<a href="https://x.com">x</a>').startsWith('<a href="https://x.com" rel='));
  assert.strictEqual(sanitizeRichText("tail <img src=x onerror=alert(1)"), "tail &lt;img src=x onerror=alert(1)");
  // Nested tag tricks leave text only: no "<" survives.
  assert.ok(!sanitizeRichText("<scr<script>ipt>alert(1)</script>").includes("<"));
});
