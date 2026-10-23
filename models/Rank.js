const mongoose = require("mongoose");

const RankSchema = new mongoose.Schema({
  name: { type: String, required: true },
  color: { type: String, default: "#3B82F6" },
  discordRoleId: { type: String, default: "" },
  order: { type: Number, default: 0 },
  permissions: {
    viewOverview: { type: Boolean, default: true },
    // Users
    viewUsers: { type: Boolean, default: false },
    editUsers: { type: Boolean, default: false },
    deleteUsers: { type: Boolean, default: false },
    syncUsers: { type: Boolean, default: false },
    
    // New Granular User Permissions
    wlGive: { type: Boolean, default: true },
    wlTake: { type: Boolean, default: true },
    voiceSupportToggle: { type: Boolean, default: false },
    discordBan: { type: Boolean, default: false },
    discordUnban: { type: Boolean, default: false },
    discordKick: { type: Boolean, default: false },
    blacklistAdd: { type: Boolean, default: false },
    blacklistRemove: { type: Boolean, default: false },
    removeAllRoles: { type: Boolean, default: false },
    dbDeleteUser: { type: Boolean, default: false },

    // Teams
    viewTeams: { type: Boolean, default: true },
    createTeams: { type: Boolean, default: true },
    createDepartment: { type: Boolean, default: true },
    editTeams: { type: Boolean, default: true },
    deleteTeams: { type: Boolean, default: true },

    // Granular Team Permissions
    teamAddMember: { type: Boolean, default: true },
    teamRemoveMember: { type: Boolean, default: true },
    teamDiscordBan: { type: Boolean, default: false },
    teamDiscordKick: { type: Boolean, default: false },
    teamSendDm: { type: Boolean, default: true },
    teamWlGive: { type: Boolean, default: true },
    teamWlTake: { type: Boolean, default: true },
    teamGiveRole: { type: Boolean, default: true },
    teamRevive: { type: Boolean, default: true },
    teamBlacklistAdd: { type: Boolean, default: false },
    teamBlacklistRemove: { type: Boolean, default: false },
    teamWipe: { type: Boolean, default: false },
    teamVoiceSupportToggle: { type: Boolean, default: true },

    // Granular Business Permissions
    businessCreate: { type: Boolean, default: true },
    businessDelete: { type: Boolean, default: true },
    businessKick: { type: Boolean, default: false },
    businessBan: { type: Boolean, default: false },
    businessSendDm: { type: Boolean, default: true },
    businessWlGive: { type: Boolean, default: true },
    businessWlTake: { type: Boolean, default: true },
    businessGiveRole: { type: Boolean, default: true },
    businessRevive: { type: Boolean, default: true },
    businessBlacklistAdd: { type: Boolean, default: false },
    businessWipe: { type: Boolean, default: false },
    businessAddMember: { type: Boolean, default: true },
    businessRemoveMember: { type: Boolean, default: true },

    // Character Management Permissions
    charEditModal: { type: Boolean, default: true },
    charEditName: { type: Boolean, default: true },
    charEditBirthdate: { type: Boolean, default: true },
    charEditMoney: { type: Boolean, default: true },
    charEditJob: { type: Boolean, default: true },
    charClearInventory: { type: Boolean, default: false },
    charDeleteItem: { type: Boolean, default: false },

    // Punishments
    viewPunishments: { type: Boolean, default: false },
    applyPunishments: { type: Boolean, default: false },
    clearPunishments: { type: Boolean, default: false },
    provideInitiative: { type: Boolean, default: false },

    // Banned Users
    unbanUser: { type: Boolean, default: false },
    banUser: { type: Boolean, default: false },

    // Blacklist Users
    blacklistUserAdd: { type: Boolean, default: false },
    blacklistUserRemove: { type: Boolean, default: false },
    // Applications
    viewApplications: { type: Boolean, default: false },
    editApplications: { type: Boolean, default: false },
    deleteApplications: { type: Boolean, default: false },
    reviewApplications: { type: Boolean, default: false },
    // Updates
    viewUpdates: { type: Boolean, default: false },
    createUpdates: { type: Boolean, default: false },
    editUpdates: { type: Boolean, default: false },
    deleteUpdates: { type: Boolean, default: false },
    // Donate
    viewDonate: { type: Boolean, default: false },
    editDonate: { type: Boolean, default: false },
    deleteDonate: { type: Boolean, default: false },
    giveCredits: { type: Boolean, default: false },
    // Ranks
    viewRanks: { type: Boolean, default: false },
    createRanks: { type: Boolean, default: false },
    editRanks: { type: Boolean, default: false },
    deleteRanks: { type: Boolean, default: false },
    // Bots
    viewBots: { type: Boolean, default: false },
    manageBots: { type: Boolean, default: false },
    // Website
    viewWebsite: { type: Boolean, default: false },
    editWebsite: { type: Boolean, default: false },
    // Developer
    viewDeveloper: { type: Boolean, default: false },
    editDeveloper: { type: Boolean, default: false },
    fivemBridgeCommands: { type: Boolean, default: false },
    manageFivemServer: { type: Boolean, default: false }
  }
});

module.exports = mongoose.model("Rank", RankSchema);
