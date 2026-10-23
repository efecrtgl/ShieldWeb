module.exports = {
  port: process.env.GATEWAY_PORT || 3000,
  version: "v2.0 - UPDATE",
  title: "Şu Anda Bakımdayız!",
  subtitle: "Sizlere daha iyi ve kesintisiz bir deneyim sunabilmek amacıyla altyapımızı güncelliyoruz.",
  reason: "Sistem güncellemeleri, performans iyileştirmeleri ve yeni güvenlik katmanları entegre edilmektedir.",
  // Tahmini bakım bitiş zamanı (Geri sayım sayacı için)
  // Gelecek bir zaman girilmelidir. Örnek: "2026-08-03T18:30:00+03:00" veya boş bırakılabilir.
  endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  progressPercent: 4,
  discordUrl: "https://discord.gg/arcanium",
  footer: "Developed by realflexd & kai7m",
  allowedIPs: ["127.0.0.1", "::1"]
};
