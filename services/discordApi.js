const axios = require("axios");
const config = require("../config");
const { ServerStats, DiscordUser } = require("../models/ServerInfo");
const { CDN, FALLBACK_AVATAR, defaultAvatarUrl, userAvatarUrl } = require("../utils/discordAvatar");
const { isSnowflake } = require("../utils/http");

const API = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 5000;
const MEMBER_PAGE_SIZE = 1000;
const MEMBER_PAGE_TIMEOUT_MS = 10000;
const ALL_MEMBERS_CACHE_MS = 10 * 60 * 1000;
const ROLE_MEMBERS_CACHE_MS = 5 * 60 * 1000;
const NOT_IN_GUILD_MESSAGE = "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır! Sunucuda olmayan kişilere işlem yapılamaz.";

// Token preference for read-only REST calls made by the web process.
const TOKEN_PREFERENCE = ["verification", "moderation", "logger", "sync", "management"];

function primaryBotToken() {
  const botId = TOKEN_PREFERENCE.find(id => config.hasBotToken(id));
  return botId ? config.bots[botId].token : null;
}

function allBotTokens() {
  return [...new Set(TOKEN_PREFERENCE.filter(id => config.hasBotToken(id)).map(id => config.bots[id].token))];
}

function botHeaders(token) {
  return { Authorization: `Bot ${token}` };
}

// Avatar for a guild member or user object; also understands stored { discordId } records.
function getDiscordAvatarUrl(discordUserOrMember) {
  if (!discordUserOrMember) return FALLBACK_AVATAR;
  const u = discordUserOrMember.user || discordUserOrMember;
  const userId = u.id || discordUserOrMember.discordId;

  if (u && u.avatar) {
    return userAvatarUrl({ id: userId, avatar: u.avatar });
  }
  if (discordUserOrMember.avatar && userId && config.discord.guildId) {
    const ext = discordUserOrMember.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN}/guilds/${config.discord.guildId}/users/${userId}/avatars/${discordUserOrMember.avatar}.${ext}`;
  }
  if (userId && /^\d+$/.test(String(userId))) {
    return defaultAvatarUrl(userId, u.discriminator);
  }
  return FALLBACK_AVATAR;
}

// Raw Discord profile ({ username, avatarUrl }) or null when the user cannot be fetched.
async function fetchDiscordUserProfile(discordId) {
  const token = primaryBotToken();
  if (!token || !isSnowflake(discordId)) return null;
  try {
    const { data } = await axios.get(`${API}/users/${discordId}`, { headers: botHeaders(token), timeout: REQUEST_TIMEOUT_MS });
    if (!data) return null;
    return {
      username: data.username,
      displayName: data.global_name || data.username,
      avatarHash: data.avatar,
      avatarUrl: data.avatar ? `${CDN}/avatars/${discordId}/${data.avatar}.png` : ""
    };
  } catch (err) {
    console.error(`[Discord API] User fetch failed for ${discordId}:`, err.message);
    return null;
  }
}

// Display name + avatar with placeholder fallbacks, used where a value is always needed.
async function fetchDiscordUserInfo(discordId) {
  const profile = await fetchDiscordUserProfile(discordId);
  if (profile) {
    return {
      username: profile.displayName || `Kullanıcı (${discordId})`,
      avatarUrl: profile.avatarHash ? userAvatarUrl({ id: discordId, avatar: profile.avatarHash }) : FALLBACK_AVATAR
    };
  }
  return { username: `Kullanıcı (${discordId})`, avatarUrl: FALLBACK_AVATAR };
}

async function verifyDiscordGuildMember(discordId) {
  if (!isSnowflake(discordId)) {
    return { inGuild: false, error: "Geçerli bir Discord ID giriniz." };
  }
  const token = primaryBotToken();
  const guildId = config.discord.guildId;

  if (token && guildId) {
    try {
      const { data: m } = await axios.get(`${API}/guilds/${guildId}/members/${discordId}`, { headers: botHeaders(token), timeout: REQUEST_TIMEOUT_MS });
      if (m) {
        const u = m.user || {};
        return {
          inGuild: true,
          username: m.nick || u.global_name || u.username || `Kullanıcı (${discordId})`,
          avatarUrl: u.avatar ? userAvatarUrl({ id: discordId, avatar: u.avatar }) : FALLBACK_AVATAR,
          roles: m.roles || []
        };
      }
    } catch (err) {
      if (err.response && err.response.status === 404) {
        return { inGuild: false, error: NOT_IN_GUILD_MESSAGE };
      }
      console.error(`[Discord Check] Guild member check failed for ${discordId}:`, err.message);
    }
  }

  // Discord API unreachable: trust a previously stored, non-placeholder record.
  const existingUser = await DiscordUser.findOne({ discordId });
  if (existingUser && existingUser.username && !existingUser.username.startsWith("Kullanıcı (") && existingUser.username !== "Bilinmeyen Kullanıcı") {
    return { inGuild: true, username: existingUser.username, avatarUrl: existingUser.avatarUrl };
  }
  return { inGuild: false, error: NOT_IN_GUILD_MESSAGE };
}

let allGuildMembersCache = null;
let allGuildMembersCacheTime = 0;
const roleMembersCache = {};

async function firstGuildIdOfBot(token) {
  const { data } = await axios.get(`${API}/users/@me/guilds`, { headers: botHeaders(token), timeout: MEMBER_PAGE_TIMEOUT_MS });
  return data && data.length > 0 ? data[0].id : null;
}

async function fetchMemberPage(token, guildId, after) {
  const { data } = await axios.get(`${API}/guilds/${guildId}/members?limit=${MEMBER_PAGE_SIZE}&after=${after}`, {
    headers: botHeaders(token),
    timeout: MEMBER_PAGE_TIMEOUT_MS
  });
  return data || [];
}

// Every member of the main guild (paginated REST), cached for 10 minutes. Tries each bot token in turn.
async function getAllGuildMembers(force = false) {
  const now = Date.now();
  if (!force && allGuildMembersCache && now - allGuildMembersCacheTime < ALL_MEMBERS_CACHE_MS) {
    return allGuildMembersCache;
  }

  const tokens = allBotTokens();
  if (tokens.length === 0) {
    console.error("getAllGuildMembers: No bot tokens available.");
    return [];
  }

  let targetGuildId = config.discord.guildId;
  if (!isSnowflake(targetGuildId)) {
    try {
      const stats = await ServerStats.findOne();
      if (stats && isSnowflake(stats.guildId)) targetGuildId = stats.guildId;
    } catch (err) {
      console.error("getAllGuildMembers: ServerStats lookup failed:", err.message);
    }
  }

  for (const token of tokens) {
    try {
      let activeGuildId = isSnowflake(targetGuildId) ? targetGuildId : await firstGuildIdOfBot(token);
      if (!activeGuildId) continue;

      let members = [];
      let after = "0";
      let fetchFailed = false;
      let retriedWithFallbackGuild = false;

      while (true) {
        let page;
        try {
          page = await fetchMemberPage(token, activeGuildId, after);
        } catch (pageErr) {
          // Configured guild unknown to this bot: retry once with the first guild the bot is in.
          if (!retriedWithFallbackGuild && pageErr.response && pageErr.response.status === 404) {
            retriedWithFallbackGuild = true;
            const fallbackGuildId = await firstGuildIdOfBot(token);
            if (fallbackGuildId) {
              activeGuildId = fallbackGuildId;
              continue;
            }
          }
          fetchFailed = true;
          break;
        }
        if (page.length === 0) break;
        members = members.concat(page);
        if (page.length < MEMBER_PAGE_SIZE) break;
        after = page[page.length - 1].user.id;
      }

      if (!fetchFailed) {
        if (activeGuildId !== config.discord.guildId) {
          config.discord.guildId = activeGuildId;
          ServerStats.findOneAndUpdate({}, { guildId: activeGuildId }, { upsert: true }).catch(() => {});
        }
        allGuildMembersCache = members;
        allGuildMembersCacheTime = now;
        return members;
      }
    } catch (tokenErr) {
      console.error("getAllGuildMembers token attempt failed:", tokenErr.message);
    }
  }
  return [];
}

function toMemberSummary(member) {
  return { id: member.user.id, username: member.user.username, avatarUrl: userAvatarUrl(member.user) };
}

function membersWithRole(allMembers, roleId) {
  return allMembers.filter(m => m.roles && m.roles.includes(roleId)).map(toMemberSummary);
}

async function getGuildMembersWithRole(roleId, forceFetch = false) {
  const now = Date.now();
  const cached = roleMembersCache[roleId];
  if (!forceFetch && cached && now - cached.timestamp < ROLE_MEMBERS_CACHE_MS) {
    return cached.data;
  }
  try {
    const allMembers = await getAllGuildMembers(forceFetch);
    if (!allMembers || allMembers.length === 0) return [];
    const data = membersWithRole(allMembers, roleId);
    roleMembersCache[roleId] = { data, timestamp: now };
    return data;
  } catch (err) {
    console.error("getGuildMembersWithRole error:", err.message);
    return [];
  }
}

module.exports = {
  API,
  botHeaders,
  primaryBotToken,
  getDiscordAvatarUrl,
  fetchDiscordUserProfile,
  fetchDiscordUserInfo,
  verifyDiscordGuildMember,
  getAllGuildMembers,
  getGuildMembersWithRole,
  membersWithRole
};
