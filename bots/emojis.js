const letters = {};

const common = {
  yes: "✅",
  no: "❌",
  warning: "⚠️",
  info: "ℹ️",
  passed: "✅",
  failed: "❌",
  ticket: "🎫",
  global: "🌐",
  member: "👤",
  admin: "🛡️",
  activity: "⚡",
  preview: "📋",
  arrow: "➔"
};

function textToLetterEmojis(text) {
  if (!text) return "";
  return String(text).toUpperCase();
}

module.exports = {
  letters,
  common,
  textToLetterEmojis
};
