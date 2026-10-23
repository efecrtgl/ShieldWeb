const express = require("express");
const { adminModuleGuard } = require("../../middleware/siteContext");

const router = express.Router();

router.use("/admin", adminModuleGuard);

for (const name of [
  "dashboard", "streamers", "users", "moderation", "characters", "staff", "bots", "content", "donate", "ranks",
  "developer", "fivemServer", "businesses", "teams", "punishments", "applications", "icName"
]) {
  router.use(require(`./${name}`));
}

module.exports = router;
