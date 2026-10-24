const mongoose = require("mongoose");

const ServerStatsSchema = new mongoose.Schema({
  // Counted from DiscordUser records by the sync bot and the user routes; 0 until the first count.
  totalWhitelist: { type: Number, default: 0 },
  // Legacy fields: live player counts now come from the FiveM bridge (services/fivemState), never from here.
  activePlayers: { type: Number, default: null },
  maxPlayers: { type: Number, default: null },

  guildId: { type: String, default: "1537239453578567690" },
  loggerGuildId: { type: String, default: "1502209084881895504" },
  whitelistRoleId: { type: String, default: "1521293367151956009" },
  unregisteredRoleId: { type: String, default: "1521293367496147034" },
  staffRoleId: { type: String, default: "1521293367151956009" },
  voiceSupportRoleId: { type: String, default: "1556072625879650425" },
  illegalCategoryId: { type: String, default: "1556072968214417488" },
  legalCategoryId: { type: String, default: "1556072957300973679" },
  businessCategoryId: { type: String, default: "1502209685468610620" },
  bossRoleId: { type: String, default: "1556072668262965359" },
  highCommandRoleId: { type: String, default: "1556072785594286201" },
  characterApprovalRoleId: { type: String, default: "none" },
  wlPunishedRoleId: { type: String, default: "1502209526084927610" },
  wipePunishRoleId: { type: String, default: "1502209526084927610" },
  warning1RoleId: { type: String, default: "1556072726987276309" },
  warning2RoleId: { type: String, default: "1556072732666634331" },
  warning3RoleId: { type: String, default: "1556072738609823824" },
  warning4RoleId: { type: String, default: "1556072744595095692" },
  warning5RoleId: { type: String, default: "1556072749884112957" },
  warning6RoleId: { type: String, default: "1556072755101835314" },
  warning7RoleId: { type: String, default: "1556072760164356097" },
  warning8RoleId: { type: String, default: "1556072765797179412" },
  warning9RoleId: { type: String, default: "1556304144544043048" },
  applicationLogChannelId: { type: String, default: "1537288949712560148" },
  punishmentLogChannelId: { type: String, default: "1532361071967600720" },
  streamerAnnounceChannelId: { type: String, default: "1556073949010460702" },
  themeColor: { type: String, default: "#e0a98b" },
  errorMode: { type: Boolean, default: false },
  fivemStartCommand: { type: String, default: "" },
  serverCfgPath: { type: String, default: "" },
  serverCfgContent: { type: String, default: "" },
  serverResourcesPath: { type: String, default: "" }
});

module.exports = mongoose.model("ServerStats", ServerStatsSchema);
