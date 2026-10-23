const DEFAULT_THEME_RGB = "0, 113, 227";

function formatDateTr(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeTr(date = new Date()) {
  return date.toLocaleTimeString("tr-TR");
}

function hexToRgb(hex) {
  const fullHex = String(hex || "").replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : DEFAULT_THEME_RGB;
}

module.exports = { formatDateTr, timeTr, hexToRgb };
