const { FivemCharacter } = require("../models/ServerInfo");
const { findOnlinePlayer } = require("./fivemState");
const { formatDateTr } = require("../utils/format");

function stripDiscordPrefix(id) {
  return String(id || "").replace(/^discord:/, "");
}

// Rank order ascending (lower = higher rank); members without a rank go last, then by username.
function sortByRank(members) {
  const rankOrder = m => (m.rankId && typeof m.rankId.order === "number" ? m.rankId.order : Infinity);
  return members.sort((a, b) => {
    const diff = rankOrder(a) - rankOrder(b);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return (a.username || "").localeCompare(b.username || "");
  });
}

function characterTimestamp(character) {
  return character.lastUpdated || character.updatedAt || (character._id && typeof character._id.getTimestamp === "function" ? character._id.getTimestamp() : null);
}

// Adds isOnline/fivemId (live FiveM status) and totalPlayHours/lastSeen (from characters) to team or business members.
async function describeGroupMembers(memberDocs) {
  const discordIds = memberDocs.map(m => m.discordId);
  const characters = await FivemCharacter.find({
    discordId: { $in: [...discordIds, ...discordIds.map(id => `discord:${id}`)] }
  }).lean();

  const charactersByOwner = new Map();
  for (const character of characters) {
    const owner = stripDiscordPrefix(character.discordId);
    if (!charactersByOwner.has(owner)) charactersByOwner.set(owner, []);
    charactersByOwner.get(owner).push(character);
  }

  return memberDocs.map(member => {
    const mObj = member.toObject();
    const onlinePlayer = findOnlinePlayer({ discordId: member.discordId });
    mObj.isOnline = !!onlinePlayer;
    mObj.fivemId = onlinePlayer ? onlinePlayer.id : null;

    let totalPlaytimeMinutes = 0;
    let latestLastSeen = null;
    for (const c of charactersByOwner.get(member.discordId) || []) {
      if (typeof c.playtime === "number") totalPlaytimeMinutes += c.playtime;
      const timestamp = characterTimestamp(c);
      if (!timestamp) continue;
      const seen = new Date(timestamp);
      if (!isNaN(seen.getTime()) && (!latestLastSeen || seen > latestLastSeen)) latestLastSeen = seen;
    }

    mObj.totalPlayHours = parseFloat((totalPlaytimeMinutes / 60).toFixed(1));
    mObj.lastSeen = latestLastSeen ? formatDateTr(latestLastSeen) : "Girmedi";
    return mObj;
  });
}

module.exports = { sortByRank, describeGroupMembers };
