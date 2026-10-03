require("dotenv").config();

const { readFile, rename, writeFile } = require("node:fs/promises");
const { randomInt } = require("node:crypto");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  Collection,
  Events,
} = require("discord.js");

const TICKET_ROLE_CONFIG_PATH = path.join(__dirname, "ticket-roles.json");
const WELCOME_SETTINGS_PATH = path.join(__dirname, "welcome-settings.json");
const GIVEAWAY_STORE_PATH = path.join(__dirname, "giveaways.json");
let ticketRoleUpdates = Promise.resolve();
let welcomeSettingUpdates = Promise.resolve();
let giveawayStoreUpdates = Promise.resolve();
const giveawayStore = new Map();
const giveawayTimers = new Map();
const giveawayLocks = new Set();
const partnershipReviewLocks = new Set();

const {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
} = process.env;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing TOKEN, CLIENT_ID, or GUILD_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const COLORS = {
  owner: 0xED4245,
  management: 0xF47B67,
  admin: 0xFEE75C,
  senior: 0x9B59B6,
  moderator: 0x3498DB,
  developer: 0x2ECC71,
  artist: 0xE91E63,
  creator: 0x00BCD4,
  supporter: 0x57F287,
  premium: 0xF1C40F,
  affiliate: 0x95A5A6,
  verified: 0x5865F2,
  member: 0x7289DA,
  bot: 0x2B2D31,
  accent: 0x5865F2,
};

const ROLE_DEFS = [
  { name: "👑 Founder", color: COLORS.owner, permissions: [PermissionFlagsBits.Administrator] },
  { name: "🛡️ Management", color: COLORS.management, permissions: [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ViewAuditLog,
  ]},
  { name: "⚙️ Administrator", color: COLORS.admin, permissions: [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ViewAuditLog,
  ]},
  { name: "🔨 Senior Staff", color: COLORS.senior, permissions: [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ViewAuditLog,
  ]},
  { name: "🛡️ Moderator", color: COLORS.moderator, permissions: [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
  ]},
  { name: "💻 Developer", color: COLORS.developer, permissions: [] },
  { name: "🎨 Artist", color: COLORS.artist, permissions: [] },
  { name: "🎬 Creator", color: COLORS.creator, permissions: [] },
  { name: "💎 Supporter", color: COLORS.supporter, permissions: [] },
  { name: "⭐ Premium", color: COLORS.premium, permissions: [] },
  { name: "🤝 Affiliate", color: COLORS.affiliate, permissions: [] },
  { name: "✅ Verified", color: COLORS.verified, permissions: [] },
  { name: "👤 Member", color: COLORS.member, permissions: [] },
];

const SELF_ROLE_DEFS = [
  { name: "Vhila SMP | SSU Ping", label: "SSU Announcements", emoji: "🔔", description: "Get notified about SSU sessions." },
  { name: "Vhila SMP | Event Ping", label: "Events", emoji: "🎉", description: "Get notified about community events." },
  { name: "Vhila SMP | Community Poll Ping", label: "Community Polls", emoji: "🗳️", description: "Get notified when a community poll is posted." },
  { name: "Vhila SMP | Announcement Ping", label: "Announcements", emoji: "📢", description: "Get notified about important server announcements." },
  { name: "Vhila SMP | Giveaway Ping", label: "Giveaways", emoji: "🎁", description: "Get notified about giveaways." },
  { name: "Vhila SMP | Media Ping", label: "Media", emoji: "📱", description: "Get notified about new media posts." },
  { name: "Vhila SMP | Chat Revive Ping", label: "Chat Revival", emoji: "💬", description: "Get notified when the community chat needs activity." },
  { name: "Vhila SMP | Department Announcement", label: "Department Announcements", emoji: "👮", description: "Get notified about department news." },
  { name: "Vhila SMP | QOTD Ping", label: "Question of the Day", emoji: "❓", description: "Get notified about the question of the day." },
  { name: "Vhila SMP | ROTD Ping", label: "Roleplay of the Day", emoji: "👀", description: "Get notified about roleplay of the day." },
  { name: "Vhila SMP | FOTD Ping", label: "Fact of the Day", emoji: "🌎", description: "Get notified about the fact of the day." },
];

const TEXT_CHANNELS = [
  {
    category: "📌 Information",
    channels: [
      { name: "📣・announcements", readOnly: true, panel: "announcements" },
      { name: "🖼️・showcase", readOnly: false },
      { name: "🆘・help-desk", readOnly: false },
      { name: "📜・server-rules", readOnly: true, panel: "rules" },
      { name: "🎁・events", readOnly: true },
      { name: "🤝・affiliates", readOnly: true },
      { name: "💎・premium-info", readOnly: true },
      { name: "🚀・supporters", readOnly: true },
      { name: "✅・verification", readOnly: true, panel: "verification" },
    ],
  },
  {
    category: "🧰 Resources",
    channels: [
      { name: "📌・usage-guide", readOnly: true },
      { name: "🎮・game-pack", readOnly: false },
      { name: "🧩・preset-library", readOnly: false },
      { name: "🥚・collection-pack", readOnly: false },
      { name: "🌸・anime-pack", readOnly: false },
    ],
  },
  {
    category: "🛠️ Projects",
    channels: [
      { name: "📁・community-projects", readOnly: false },
      { name: "📁・game-releases", readOnly: false },
      { name: "📁・game-assets", readOnly: false },
      { name: "🎨・graphics", readOnly: false },
      { name: "🖥️・interface", readOnly: false },
      { name: "📦・resources", readOnly: false },
      { name: "🗺️・worlds", readOnly: false },
      { name: "🚗・models", readOnly: false },
    ],
  },
  {
    category: "🎬 Creators",
    channels: [
      { name: "🎥・creator-zone", readOnly: false },
      { name: "📝・creator-apply", readOnly: false },
      { name: "📕・creator-guidelines", readOnly: true },
    ],
  },
  {
    category: "🌐 Network",
    channels: [
      { name: "🚀・server-boosts", readOnly: true },
      { name: "👋・member-invites", readOnly: true },
    ],
  },
  {
    category: "💬 Community",
    channels: [
      { name: "🛍️・market", readOnly: false },
      { name: "💻・coding-help", readOnly: false },
      { name: "📸・showcase-media", readOnly: false },
      { name: "💼・job-board", readOnly: false },
      { name: "🤖・bot-commands", readOnly: false },
      { name: "💬・general-chat", readOnly: false },
    ],
  },
];

const VOICE_PUBLIC = [
  { name: "🔊・Lounge 01", limit: 15 },
  { name: "🔊・Lounge 02", limit: 15 },
  { name: "🔊・Lounge 03", limit: 15 },
  { name: "🔊・Lounge 04", limit: 15 },
  { name: "🔊・Lounge 05", limit: 15 },
];

const VOICE_PRIVATE = [
  { name: "🔐・Private 01", limit: 2 },
  { name: "🔐・Private 02", limit: 2 },
  { name: "🔐・Private 03", limit: 3 },
  { name: "🔐・Private 04", limit: 4 },
  { name: "🔐・Private 05", limit: 4 },
];

const channelLockSnapshots = new Map();
const TICKET_TYPES = [
  {
    label: "General Support",
    value: "general-support",
    description: "Ask for support or about VhilaSMP.",
    emoji: "💬",
  },
  {
    label: "Partnership Support",
    value: "partnership-support",
    description: "Ask about partnering with us.",
    emoji: "🤝",
  },
  {
    label: "Media Apply",
    value: "media-apply",
    description: "Apply to become a creator.",
    emoji: "✨",
  },
  {
    label: "Report A Bug",
    value: "report-a-bug",
    description: "Report a bug on the server.",
    emoji: "🐛",
  },
  {
    label: "Payment Support",
    value: "payment-support",
    description: "Get help with a payment.",
    emoji: "💳",
  },
  {
    label: "Player Report",
    value: "player-report",
    description: "Report a player to the staff team.",
    emoji: "🚩",
  },
  {
    label: "Other",
    value: "other",
    description: "Get help with another appropriate topic.",
    emoji: "💬",
  },
];
const STAFF_APPLICATION_TEMPLATE = [
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "## Basic Information",
  "",
  "**1. Discord Username:**",
  "> ",
  "",
  "**2. Roblox Username:**",
  "> ",
  "",
  "**3. Age:**",
  "> ",
  "",
  "**4. Timezone:**",
  "> ",
  "",
  "**5. How long have you been in Vhila SMP?**",
  "> ",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "## Experience",
  "",
  "**6. Have you been Staff in another server before?**",
  "> ",
  "",
  "**7. If yes, what server(s) and what position did you hold?**",
  "> ",
  "",
  "**8. Do you have any moderation or administrative experience?**",
  "> ",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "## Activity",
  "",
  "**9. How active are you on Discord?**",
  "> ",
  "",
  "**10. How active are you in Vhila SMP?**",
  "> ",
  "",
  "**11. How many hours can you dedicate to Staff each week?**",
  "> ",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "## Scenarios",
  "",
  "**12. A player is breaking rules while your friend is involved. What would you do?**",
  "> ",
  "",
  "**13. A player insults you after you punish them. How would you handle it?**",
  "> ",
  "",
  "**14. You see another Staff member abusing their permissions. What would you do?**",
  "> ",
  "",
  "**15. Two players are arguing and both claim the other is at fault. How would you handle the situation?**",
  "> ",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "## Final Questions",
  "",
  "**16. Why should we choose you for Staff?**",
  "> ",
  "",
  "**17. What makes a good Staff member?**",
  "> ",
  "",
  "**18. What would you bring to the Vhila SMP Staff Team?**",
  "> ",
  "",
  "**19. Is there anything else you would like Management to know?**",
  "> ",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "**Applicant Agreement**",
  "",
  "By submitting this application, I confirm that the information provided is truthful and that I agree to follow all Vhila SMP Staff Rules and guidelines.",
].join("\n");
const STAFF_ROLE_NAMES = [
  "👑 Founder",
  "🛡️ Management",
  "⚙️ Administrator",
  "🔨 Senior Staff",
  "🛡️ Moderator",
];
const STAFF_ROLE_DISPLAY_NAMES = [
  "Owner",
  "Xenon",
  "2 Owner",
  "Owner 3",
  "Founder",
  "Ownership",
  "Manager",
  "Staff Supervisory",
  "Lead Management",
  "Senior Management",
  "Management",
  "Trial Management",
  "Management team",
  "Lead Internal Affairs",
  "Senior Internal Affairs",
  "Internal Affairs",
  "Junior Internal Affairs",
  "Trial Internal Affairs",
  "Lead Administrator",
  "Senior Administrator",
  "Administrator",
  "Junior Administrator",
  "Trail Administrator",
  "Trial Administrator",
  "Lead Moderator",
  "Senior Moderator",
  "Moderator",
  "Junior Moderator",
  "Trial Moderator",
  "Staff Trainee",
  "Vhila SMP Staff Team",
];
const STAFF_ROLE_DISPLAY_NAME_SET = new Set(
  STAFF_ROLE_DISPLAY_NAMES.map(name => name.toLowerCase())
);

const IN_GAME_RULES = [
  {
    title: "Rule 1 | Random Deathmatch",
    description: "Do not shoot or attack or kill anyone without a reason, encouraging other people to RDM is considered mass RDM and will result in a 30 minute kick.",
  },
  {
    title: "Rule 2 | Fail Roleplay",
    description: "All roleplays must be realistic, and you must not do actions that are deemed unrealistic. If you drive in a manner that is not possible in real life, it is also considered FRP.",
  },
  {
    title: "Rule 3 | Vehicle Death Match",
    description: "Do not hit or ram anyone with your car for no reason. Doing so will result in a kick.",
  },
  {
    title: "Rule 4 | Weapons",
    description: "When using a long gun, you must roleplay getting it out of your trunk.",
  },
  {
    title: "Rule 5 | Avatars",
    description: [
      "Your avatar must be realistic and must not have anything that would not be worn in real life.",
      "• Extra-small avatars are forbidden.",
      "• Animal avatars and suits are forbidden.",
      "• Avatars must be R6/R15.",
      "• Body proportions must be within a realistic range.",
      "• Non-classic avatar items may be moderated if deemed to break realism.",
    ].join("\n"),
  },
  {
    title: "Rule 6 | Roleplays and Interference",
    description: [
      "Do not interfere with roleplays that you are not involved with.",
      "• Allowed roleplays: hostage situations and kidnapping.",
      "• Not allowed: Gang RP with 4+ people (except Civilian Operations crews in a criminal organization), bomb roleplay, suicide roleplay, and hitman roleplay.",
    ].join("\n"),
  },
  {
    title: "Rule 7 | Detain Requests & Cuff Rushing",
    description: "You must always accept a detain request, as it would be unrealistic to decline it. Type cuffs before arresting someone. You may also say this in voice chat due to Roblox restrictions. If the person you are arresting or someone in the scene cannot see your chat, try text first for moderation purposes.",
  },
  {
    title: "Rule 8 | Cop Baiting",
    description: "Do not try to get police attention for no reason or start a pointless pursuit. Doing so will result in a kick.",
  },
  {
    title: "Rule 9 | Robberies",
    description: "Do not go on a robbery spree, as this is completely unrealistic.",
  },
  {
    title: "Rule 10 | New Life Rule and Fear Roleplay",
    description: "Once your character has died, you have no memory or knowledge of your past life. If someone points a weapon at you, you must comply with Fear Roleplay.",
  },
  {
    title: "Rule 11 | Stopping and Pulling Over to Emergency Vehicles",
    description: "Always pull over or stop for an emergency vehicle for realism unless you have a valid reason not to. Drive on the correct side of the road (the right side).",
  },
  {
    title: "Rule 12 | Priority Timer",
    description: [
      "When a Priority Timer is active, do not commit priority roleplays:",
      "• Shots fired",
      "• Robbing the bank or jewellery store",
      "• Pursuits",
      "• Hostage situations",
      "Priority timers occur after a big RP or whenever a staff member deems it necessary.",
    ].join("\n"),
  },
  {
    title: "Rule 13 | Kick Cooldown",
    description: "If you are kicked, you must wait 1 hour to rejoin.",
  },
  {
    title: "Rule 14 | Stolen Radios/Scanners",
    description: "Even if you steal or buy a scanner, you are not allowed inside the RTO.",
  },
  {
    title: "Rule 15 | SRB",
    description: "You cannot roleplay as SRB unless you are trained and are in the corresponding Discord server.",
  },
  {
    title: "Rule 16 | Protests/Riots",
    description: "Protests and riots are allowed but must be peaceful. No shooting or crimes may be committed. Protests cannot cover an unreasonable amount of road. Staff may shut down or move a protest if it gets out of hand or is deemed unsuitable.",
  },
  {
    title: "Rule 17 | Out of Roleplay",
    description: "Going out of roleplay during an active scene is not allowed unless there is an urgent reason. You will be moderated if you do this.",
  },
  {
    title: "Rule 18 | Roleplaying IRL Characters",
    description: "Do not roleplay as real-life characters such as serial killers or world leaders. These roleplays create drama and usually end in FRP.",
  },
  {
    title: "Rule 19 | !Mod & !Help Usage",
    description: "Misusing !mod commands, spamming, or calling staff when not required will result in moderation.",
  },
];

const DISCORD_RULES = [
  {
    title: "1. Be respectful",
    description: "Treat members and staff with respect. Harassment, discrimination, threats, bullying, and targeted abuse are not allowed.",
  },
  {
    title: "2. Keep content appropriate",
    description: "Do not post explicit, hateful, graphic, or otherwise inappropriate content. Follow Discord's Terms of Service and Community Guidelines.",
  },
  {
    title: "3. No spam or disruption",
    description: "Avoid message flooding, repeated mentions, excessive caps, soundboard spam, and anything else that disrupts the community.",
  },
  {
    title: "4. Use the right channels",
    description: "Keep conversations on topic and use the appropriate channels for roleplay, support, media, and announcements.",
  },
  {
    title: "5. No unauthorized advertising",
    description: "Do not advertise servers, products, or services without permission. Use designated promotion channels when available.",
  },
  {
    title: "6. Protect privacy",
    description: "Do not share anyone's personal information, private messages, or private server content without their consent.",
  },
  {
    title: "7. No impersonation or evasion",
    description: "Do not impersonate members or staff, evade moderation, or use alternate accounts to bypass a restriction.",
  },
  {
    title: "8. Keep disagreements civil",
    description: "Do not turn disagreements into public arguments or harassment. Move on or ask staff for help.",
  },
  {
    title: "9. Follow staff directions",
    description: "Follow reasonable moderator instructions. If you disagree with a moderation decision, appeal calmly through the proper support channel.",
  },
  {
    title: "10. Keep accounts and links safe",
    description: "Do not post scams, malicious links, malware, or requests for passwords, tokens, or other sensitive account information.",
  },
];

const STAFF_RULES_INTRO = [
  "> ⚠️ **These rules apply to all Vhila SMP Staff Members.**",
  "> Failure to follow these rules may result in a warning, strike, suspension, demotion, or removal from the Staff Team.",
].join("\n");
const STAFF_RULES = [
  {
    title: "🚗 Rule 1 | Staff Team Without Car",
    description: "Driving around on the **Staff Team** without proper **Staff Livery** on your vehicle while on duty is prohibited.\n> **Punishment:** Verbal Warning",
  },
  {
    title: "🛠️ Rule 2 | Using Commands Off Duty",
    description: [
      "Staff commands may only be used while you are properly **on duty as Staff**.",
      "",
      "Do **NOT** use Staff commands while on:",
      "🚔 **PD**",
      "🚒 **FD**",
      "🚧 **DOT**",
      "👤 **Civilian**",
      "Any other non-Staff team",
    ].join("\n"),
  },
  {
    title: "🚫 Rule 3 | Staff Abuse",
    description: "Do not abuse your Staff permissions, commands, or rank.\n\nUsing Staff powers to benefit yourself, friends, or other players is strictly prohibited.",
  },
  {
    title: "⚖️ Rule 4 | No Favoritism",
    description: "All members must be treated fairly and equally.\n\nDo not give friends, Staff members, or specific players special treatment.",
  },
  {
    title: "💼 Rule 5 | Staff Professionalism",
    description: [
      "Staff members are expected to remain professional while representing Vhila SMP.",
      "",
      "Do not:",
      "• Harass members",
      "• Start unnecessary arguments",
      "• Be excessively toxic",
      "• Abuse your position",
      "• Disrespect other Staff or members",
    ].join("\n"),
  },
  {
    title: "🎭 Rule 6 | Do Not Interfere With RP",
    description: "Do not use Staff powers to interfere with an active roleplay situation unless Staff intervention is required.",
  },
  {
    title: "📸 Rule 7 | Evidence",
    description: "Whenever possible, Staff should have evidence before taking disciplinary action.\n\nDo not punish someone based solely on assumptions or personal disagreements.",
  },
  {
    title: "⚖️ Rule 8 | Appropriate Punishments",
    description: "Punishments must be appropriate for the situation.\n\nDo not give excessive punishments or use punishments as retaliation.",
  },
  {
    title: "🔒 Rule 9 | Confidential Information",
    description: [
      "Staff-only information must remain confidential.",
      "",
      "Do not leak:",
      "• Staff discussions",
      "• Private tickets",
      "• Reports",
      "• Logs",
      "• Investigations",
      "• Staff announcements",
      "• Other confidential information",
    ].join("\n"),
  },
  {
    title: "👑 Rule 10 | Respect Higher Staff",
    description: "Respect the decisions of higher-ranking Staff.\n\nIf you disagree with a decision, discuss it privately and professionally rather than causing an argument publicly.",
  },
  {
    title: "👤 Rule 11 | No Self-Moderation",
    description: "If you are personally involved in a situation, allow another Staff member to handle the situation whenever possible.",
  },
  {
    title: "⚠️ Rule 12 | Permission Abuse",
    description: [
      "Do not use Staff commands such as:",
      "",
      "`/ban` • `/kick` • `/mute` • `/warn` • `/timeout`",
      "",
      "or other administrative commands as jokes or without a legitimate reason.",
    ].join("\n"),
  },
  {
    title: "🤝 Rule 13 | Respect Everyone",
    description: [
      "Being Staff does not make you better than other members.",
      "",
      "Treat everyone with respect regardless of their:",
      "• Rank",
      "• Role",
      "• Department",
      "• Position",
      "• Experience",
    ].join("\n"),
  },
  {
    title: "📜 Rule 14 | Follow Vhila SMP Rules",
    description: "Staff members must follow the same Vhila SMP rules as everyone else unless a specific Staff duty requires otherwise.",
  },
  {
    title: "🚨 Rule 15 | Report Staff Misconduct",
    description: "If you witness another Staff member abusing their permissions or breaking Staff rules, report it to Staff Management with evidence.\n\nDo not start arguments or confront the Staff member publicly.",
  },
  {
    title: "🚫 Rule 16 | No Retaliation",
    description: [
      "Do not punish, demote, harass, or target someone because they:",
      "> • Reported you",
      "> • Disagreed with you",
      "> • Received a punishment from you",
      "> • Submitted a complaint against you",
    ].join("\n"),
  },
  {
    title: "🧠 Rule 17 | Use Common Sense",
    description: "Not every situation can be covered by a written rule.\n\nUse common sense and make decisions that protect the fairness, professionalism, and quality of **Vhila SMP**.",
  },
];
const STAFF_PUNISHMENT_SYSTEM = [
  "# 🔴 STAFF PUNISHMENT SYSTEM",
  "",
  "Staff violations may result in:",
  "",
  "🟡 **Verbal Warning**",
  "🟠 **Staff Warning**",
  "🔴 **Staff Strike**",
  "⏸️ **Suspension**",
  "📉 **Demotion**",
  "❌ **Staff Removal**",
  "",
  "> **Punishments are determined based on the severity and frequency of the violation. Management may skip punishment levels for serious violations.**",
  "",
  "### 🔴 LOS ANGELES STAFF",
  "**Professional • Fair • Active • Responsible**",
].join("\n");
const STAFF_DISCORD_RULES_INTRO = [
  "> **These rules apply to all Vhila SMP Staff Members.**",
  "> The Staff Discord is for official Vhila SMP Staff business. Keep it professional and respectful.",
].join("\n");
const STAFF_DISCORD_RULES = [
  {
    title: "Rule 1 | Confidentiality",
    description: [
      "Do not share or leak anything from the Staff Discord.",
      "",
      "❌ Staff chats",
      "❌ Applications",
      "❌ Reports",
      "❌ Tickets",
      "❌ Logs",
      "❌ Private information",
    ].join("\n"),
  },
  {
    title: "Rule 2 | Respect Everyone",
    description: "Treat all Staff members with respect.\n\nNo harassment, bullying, arguing, or unnecessary drama.",
  },
  {
    title: "Rule 3 | Staff Pings",
    description: "Do not abuse Staff role pings, @everyone, or @here.\n\nOnly ping Staff when necessary.",
  },
  {
    title: "Rule 4 | Use Correct Channels",
    description: "Use each Staff channel for its intended purpose.\n\nDo not spam or post unrelated content in Staff channels.",
  },
  {
    title: "Rule 5 | Tickets & Reports",
    description: "Use the correct ticket or report channel for Staff issues.\n\nProvide accurate information and evidence when possible.",
  },
  {
    title: "Rule 6 | Bot Commands",
    description: "Use Staff bots and commands only for their intended purpose.\n\nDo not spam or abuse bot commands.",
  },
  {
    title: "Rule 7 | Staff VC",
    description: "Keep Staff voice channels professional.\n\nNo mic spam, screaming, or intentionally disrupting meetings.",
  },
  {
    title: "Rule 8 | Management",
    description: "Respect Staff Management and their decisions.\n\nDisagreements should be handled privately and professionally.",
  },
  {
    title: "Rule 9 | No Staff Drama",
    description: "Do not bring personal arguments or player drama into Staff channels.\n\nKeep Staff discussions focused on Vhila SMP.",
  },
  {
    title: "Rule 10 | Common Sense",
    description: "Use common sense and act professionally.\n\nManagement may take action when behavior negatively affects the Staff Team or Vhila SMP.",
  },
];
const STAFF_DISCORD_RULES_SIGNOFF = [
  "**VHILA SMP STAFF**",
  "",
  "**Respect • Professionalism • Teamwork • Confidentiality**",
].join("\n");

const commands = [
  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show server configuration information.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("infopanel")
    .setDescription("Post the Vhila SMP server information panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("partnershippanel")
    .setDescription("Post the Vhila SMP partnership application panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("paidadpanel")
    .setDescription("Post the paid advertisement submission panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("serverstatus")
    .setDescription("Post a server start or shutdown status message.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("start")
        .setDescription("Post a server start status message.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("shutdown")
        .setDescription("Post a server shutdown status message.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("stop")
        .setDescription("Post a server stop status message.")
    )
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock the current text channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock the current text channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Post the ticket selection menu in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("ssuinfo")
    .setDescription("Post the SSU information panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("welcomepanel")
    .setDescription("Post the Vhila SMP welcome panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("rolepanel")
    .setDescription("Post the Vhila SMP notification self-role panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("verifybot")
    .setDescription("Post the Vhila SMP member verification panel in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("welcomemessages")
    .setDescription("Turn automatic welcome messages on or off.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("start")
        .setDescription("Enable automatic welcome messages.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("stop")
        .setDescription("Disable automatic welcome messages.")
    )
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("Post the Vhila SMP in-game rules in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("discordrules")
    .setDescription("Post the Vhila SMP Discord server rules in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("staffrules")
    .setDescription("Post the Vhila SMP staff rules in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("staffroles")
    .setDescription("Post the staff roles currently configured in this server.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("staffdiscordrules")
    .setDescription("Post the Vhila SMP staff Discord rules in this channel.")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("ticketroles")
    .setDescription("Manage the roles pinged and added to new tickets.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Add a role to ticket notifications.")
        .addRoleOption(option =>
          option
            .setName("role")
            .setDescription("The role to ping and give ticket access.")
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Remove a role from ticket notifications.")
        .addRoleOption(option =>
          option
            .setName("role")
            .setDescription("The role to stop pinging and giving ticket access.")
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("List the extra roles configured for tickets.")
    )
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Create and manage server giveaways.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("start")
        .setDescription("Start a giveaway members can join with a button.")
        .addStringOption(option =>
          option
            .setName("prize")
            .setDescription("What the winner(s) will receive.")
            .setMaxLength(200)
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName("duration")
            .setDescription("How long it runs (for example: 30m, 2h, 1d).")
            .setMaxLength(16)
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName("winners")
            .setDescription("Number of winners.")
            .setMinValue(1)
            .setMaxValue(20)
            .setRequired(true)
        )
        .addChannelOption(option =>
          option
            .setName("channel")
            .setDescription("Where to post the giveaway (defaults to this channel).")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("end")
        .setDescription("End an active giveaway early.")
        .addStringOption(option =>
          option
            .setName("message_id")
            .setDescription("The giveaway message ID.")
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("reroll")
        .setDescription("Pick a replacement winner for an ended giveaway.")
        .addStringOption(option =>
          option
            .setName("message_id")
            .setDescription("The giveaway message ID.")
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true)
        )
    )
    .setDMPermission(false),
].map(command => command.toJSON());

async function registerCommands(botUser) {
  if (botUser.id !== CLIENT_ID) {
    throw new Error(
      `CLIENT_ID (${CLIENT_ID}) does not match the logged-in bot ID (${botUser.id}). ` +
      "Set CLIENT_ID in .env to this bot application's ID."
    );
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

async function readTicketRoleConfig() {
  let rawConfig;
  try {
    rawConfig = await readFile(TICKET_ROLE_CONFIG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const config = JSON.parse(rawConfig);
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.values(config).some(
      roleIds => !Array.isArray(roleIds) ||
        roleIds.some(roleId => typeof roleId !== "string")
    )
  ) {
    throw new Error("ticket-roles.json has an invalid format.");
  }

  return config;
}

async function configuredTicketRoleIds(guildId) {
  const config = await readTicketRoleConfig();
  return config[guildId] || [];
}

function updateConfiguredTicketRoles(guildId, update) {
  const operation = ticketRoleUpdates.then(async () => {
    const config = await readTicketRoleConfig();
    const roleIds = update(config[guildId] || []);
    config[guildId] = roleIds;

    const temporaryPath = `${TICKET_ROLE_CONFIG_PATH}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporaryPath, TICKET_ROLE_CONFIG_PATH);
    return roleIds;
  });

  ticketRoleUpdates = operation.catch(() => {});
  return operation;
}

async function readWelcomeSettings() {
  let rawSettings;
  try {
    rawSettings = await readFile(WELCOME_SETTINGS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const settings = JSON.parse(rawSettings);
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.values(settings).some(enabled => typeof enabled !== "boolean")
  ) {
    throw new Error("welcome-settings.json has an invalid format.");
  }

  return settings;
}

async function automaticWelcomeEnabled(guildId) {
  const settings = await readWelcomeSettings();
  return settings[guildId] !== false;
}

function setAutomaticWelcomeEnabled(guildId, enabled) {
  const operation = welcomeSettingUpdates.then(async () => {
    const settings = await readWelcomeSettings();
    settings[guildId] = enabled;

    const temporaryPath = `${WELCOME_SETTINGS_PATH}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, WELCOME_SETTINGS_PATH);
  });

  welcomeSettingUpdates = operation.catch(() => {});
  return operation;
}

function isStaff(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(role =>
      STAFF_ROLE_NAMES.includes(role.name) ||
      STAFF_ROLE_DISPLAY_NAME_SET.has(role.name.toLowerCase())
    );
}

function roleByName(guild, name) {
  return guild.roles.cache.find(role => role.name === name);
}

async function ensureSelfAssignableRoles(guild) {
  await guild.roles.fetch();
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("I need Manage Roles permission to set up the notification roles.");
  }

  const roles = [];
  for (const definition of SELF_ROLE_DEFS) {
    let role = roleByName(guild, definition.name);
    if (role) {
      if (role.managed || role.permissions.bitfield !== 0n) {
        throw new Error(`The existing "${definition.name}" role has permissions or is managed. Rename it or remove its permissions before posting this panel.`);
      }
      if (!role.editable) {
        throw new Error(`My role must be above "${definition.name}" to manage it.`);
      }
      if (!role.mentionable) {
        role = await role.setMentionable(true, "Enable notification role pings");
      }
    } else {
      role = await guild.roles.create({
        name: definition.name,
        permissions: [],
        mentionable: true,
        reason: "Create Vhila SMP self-assignable notification role",
      });
    }
    roles.push({ definition, role });
  }
  return roles;
}

async function ensureVerifiedRole(guild) {
  await guild.roles.fetch();
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("I need Manage Roles permission to set up verification.");
  }

  let role = roleByName(guild, "✅ Verified");
  if (!role) {
    role = await guild.roles.create({
      name: "✅ Verified",
      colors: { primaryColor: COLORS.verified },
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: "Create Vhila SMP verification role",
    });
  }

  if (role.managed || role.permissions.bitfield !== 0n) {
    throw new Error('The "✅ Verified" role must be unmanaged and have no permissions before it can be granted by the verify button.');
  }
  if (!role.editable) {
    throw new Error('My role must be above "✅ Verified" to assign it.');
  }
  return role;
}

async function configureVerificationAccess(guild, verifiedRole, verificationChannel) {
  await guild.channels.fetch();
  const arrivalsChannel = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "arrivals"
  );
  if (!arrivalsChannel) {
    throw new Error('Could not find the "arrivals" text channel. Create it before setting up verification.');
  }
  if (verificationChannel.id === arrivalsChannel.id) {
    throw new Error('Run /verifybot in a verification channel separate from the "arrivals" channel.');
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("I need Manage Channels permission to restrict access until verification.");
  }

  const everyoneRole = guild.roles.everyone;
  const publicChannels = [...guild.channels.cache.values()].filter(channel =>
    channel.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel)
  );
  const channelsToConfigure = new Map(
    publicChannels.map(channel => [channel.id, channel])
  );
  channelsToConfigure.set(arrivalsChannel.id, arrivalsChannel);
  channelsToConfigure.set(verificationChannel.id, verificationChannel);

  const errors = [];
  let configuredCount = 0;
  for (const channel of channelsToConfigure.values()) {
    const isOnboardingChannel =
      channel.id === arrivalsChannel.id ||
      channel.id === verificationChannel.id;
    const everyonePermissions = isOnboardingChannel
      ? {
          ViewChannel: true,
          ReadMessageHistory: true,
          ...(channel.isTextBased()
            ? {
                SendMessages: false,
                SendMessagesInThreads: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
              }
            : {}),
        }
      : { ViewChannel: false };
    const verifiedPermissions = {
      ViewChannel: true,
      ReadMessageHistory: true,
    };

    try {
      await channel.permissionOverwrites.edit(verifiedRole, verifiedPermissions, {
        reason: "Allow verified members to access this channel",
      });
      await channel.permissionOverwrites.edit(everyoneRole, everyonePermissions, {
        reason: isOnboardingChannel
          ? "Keep onboarding channels available but read-only before verification"
          : "Require verification before accessing public channels",
      });
      configuredCount++;
    } catch (error) {
      errors.push(`${channel.name}: ${error.message}`);
    }
  }

  return { arrivalsChannel, configuredCount, errors };
}

async function ensureRole(guild, def) {
  let role = roleByName(guild, def.name);

  if (!role) {
    role = await guild.roles.create({
      name: def.name,
      colors: { primaryColor: def.color },
      permissions: def.permissions,
      hoist: false,
      mentionable: false,
      reason: "Server setup",
    });
    return role;
  }

  // Sync color/permissions for roles created by this setup.
  await role.edit({
    colors: { primaryColor: def.color },
    permissions: def.permissions,
    reason: "Server setup sync",
  });

  return role;
}

async function createRoles(guild) {
  const roles = {};

  for (const def of ROLE_DEFS) {
    roles[def.name] = await ensureRole(guild, def);
  }

  // Discord only lets a bot manage roles below its highest role.
  // Put our custom hierarchy directly below the bot's highest manageable role.
  const botMember = guild.members.me;
  if (!botMember) throw new Error("Bot member was not found in this guild.");

  const manageable = Object.values(roles)
    .filter(role => !role.managed && role.id !== guild.id)
    .filter(role => role.position < botMember.roles.highest.position)
    .sort((a, b) => b.position - a.position);

  let nextPosition = Math.max(1, botMember.roles.highest.position - 1);

  for (const role of manageable) {
    try {
      await role.setPosition(nextPosition, "Server setup role hierarchy");
      nextPosition--;
    } catch (error) {
      console.warn(`Could not position role ${role.name}: ${error.message}`);
    }
  }

  return roles;
}

function baseChannelOverwrites(guild, roles) {
  const staffRoles = [
    roles["👑 Founder"],
    roles["🛡️ Management"],
    roles["⚙️ Administrator"],
    roles["🔨 Senior Staff"],
    roles["🛡️ Moderator"],
  ].filter(Boolean);

  return [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.UseApplicationCommands,
      ],
      deny: [
        PermissionFlagsBits.MentionEveryone,
      ],
    },
    ...staffRoles.map(role => ({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    })),
  ];
}

function makeTextOverwrites(guild, roles, { readOnly = false, privateRoleNames = [] } = {}) {
  const overwrites = baseChannelOverwrites(guild, roles);

  if (readOnly) {
    const everyone = overwrites.find(o => o.id === guild.roles.everyone.id);
    everyone.deny.push(
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.SendMessagesInThreads
    );
  }

  for (const roleName of privateRoleNames) {
    const role = roles[roleName];
    if (!role) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.UseApplicationCommands,
      ],
    });
  }

  return overwrites;
}

async function ensureCategory(guild, name) {
  let category = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildCategory && ch.name === name
  );

  if (!category) {
    category = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      reason: "Server setup",
    });
  }

  return category;
}

async function ensureTextChannel(guild, category, spec, roles) {
  let channel = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText &&
      ch.name === spec.name &&
      ch.parentId === category.id
  );

  if (!channel) {
    channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: makeTextOverwrites(guild, roles, {
        readOnly: spec.readOnly,
      }),
      topic: spec.name.includes("support")
        ? "Need help? Use the ticket button below."
        : undefined,
      reason: "Server setup",
    });
  } else {
    await channel.permissionOverwrites.set(
      makeTextOverwrites(guild, roles, { readOnly: spec.readOnly }),
      "Server setup sync"
    );
  }

  return channel;
}

async function ensureVoiceChannel(guild, category, spec, roles, privateRoom) {
  let channel = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildVoice &&
      ch.name === spec.name &&
      ch.parentId === category.id
  );

  const commonAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.UseVAD,
  ];

  const staffRoles = [
    "👑 Founder",
    "🛡️ Management",
    "⚙️ Administrator",
    "🔨 Senior Staff",
    "🛡️ Moderator",
  ];

  const overwrites = [];

  if (privateRoom) {
    overwrites.push({
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    });

    for (const roleName of ["⭐ Premium", "💎 Supporter", ...staffRoles]) {
      const role = roles[roleName];
      if (!role) continue;
      overwrites.push({
        id: role.id,
        allow: commonAllow,
      });
    }
  } else {
    overwrites.push({
      id: guild.roles.everyone.id,
      allow: commonAllow,
    });

    for (const roleName of staffRoles) {
      const role = roles[roleName];
      if (!role) continue;
      overwrites.push({
        id: role.id,
        allow: commonAllow,
      });
    }
  }

  if (!channel) {
    channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: spec.limit,
      permissionOverwrites: overwrites,
      reason: "Server setup",
    });
  } else {
    await channel.setUserLimit(spec.limit, "Server setup sync");
    await channel.permissionOverwrites.set(overwrites, "Server setup sync");
  }

  return channel;
}

function buildRulesEmbed(guild) {
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("📜 Server Rules")
    .setDescription(
      [
        "Welcome to the community. Keep the server useful, friendly, and organized.",
        "",
        "**1. Respect people**",
        "No harassment, discrimination, threats, or targeted abuse.",
        "",
        "**2. Keep content appropriate**",
        "No illegal, malicious, or unsafe content.",
        "",
        "**3. Keep channels on-topic**",
        "Use the right channel for projects, coding, media, marketplace posts, and general chat.",
        "",
        "**4. No spam or unsolicited advertising**",
        "Use the appropriate networking channels for legitimate partnerships or promotions.",
        "",
        "**5. Follow staff instructions**",
        "Moderation decisions should be handled calmly through the support system.",
        "",
        "**6. Protect your account**",
        "Never post private credentials, tokens, personal information, or malware.",
      ].join("\n")
    )
    .setFooter({ text: `${guild.name} • Please read before chatting` })
    .setTimestamp();
}

function buildDiscordRulesEmbed(guild) {
  const description = [
    `Welcome to **${guild.name}**. These rules apply to everyone in the Vhila SMP Discord.`,
    "",
    ...DISCORD_RULES.flatMap(rule => [`**${rule.title}**`, rule.description, ""]),
  ].join("\n").trim();

  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("📜 Vhila SMP Discord Rules")
    .setDescription(description)
    .setFooter({ text: `${guild.name} • Respect • Roleplay • Community` })
    .setTimestamp();
}

function buildAnnouncementEmbed(guild) {
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("📣 Community Hub")
    .setDescription(
      "Announcements, important updates, releases, events, and server news will be posted here."
    )
    .addFields(
      { name: "🛠️ Projects", value: "Share development work and resources.", inline: true },
      { name: "🎬 Creators", value: "Creator resources and applications.", inline: true },
      { name: "💬 Community", value: "Chat, coding, marketplace, and media.", inline: true },
    )
    .setFooter({ text: `${guild.name}` })
    .setTimestamp();
}

function buildServerInfoPanelEmbed(guild) {
  const findChannel = fragment => guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.name.toLowerCase().includes(fragment)
  );
  const channelLink = (fragment, fallback) => {
    const channel = findChannel(fragment);
    return channel ? `${channel}` : fallback;
  };

  return new EmbedBuilder()
    .setColor(0xF59E67)
    .setTitle(`🌴 ${guild.name} | Server Information`)
    .setDescription(
      `Welcome to **${guild.name}** — Vhila SMP (**Vhila SMP**), a community for realistic and enjoyable roleplay. Start by verifying, reading the rules, and choosing how you want to participate.`
    )
    .addFields(
      {
        name: "🚦 Start Here",
        value: [
          `1. Verify in ${channelLink("verification", "the verification channel")}.`,
          `2. Read ${channelLink("server-rules", "the server rules")} and ${channelLink("discord-rules", "the Discord rules")}.`,
          "3. Choose optional notification roles from the self-role panel.",
        ].join("\n"),
      },
      {
        name: "🚔 Departments",
        value: [
          "🚓 **Police Department** — law enforcement roleplay.",
          "🚒 **Fire & Rescue** — fire and emergency medical roleplay.",
          "🚧 **Department of Transportation** — roads and transport roleplay.",
          "👤 **Civilian Operations** — civilian characters and scenarios.",
        ].join("\n"),
      },
      {
        name: "📣 Events & SSU",
        value: [
          `Watch ${channelLink("announcements", "announcements")} and select event/SSU pings in the role panel.`,
          "Check the SSU information panel for session guidance and updates.",
        ].join("\n"),
      },
      {
        name: "🎫 Need Help?",
        value: `Use ${channelLink("help-desk", "the help desk")} to contact staff or open a private ticket. Be respectful, protect personal information, and follow staff instructions.`,
      },
    )
    .setFooter({ text: "Vhila SMP • Respect • Realism • Community" })
    .setTimestamp();
}

function buildVerificationEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.verified)
    .setTitle("✅ Vhila SMP Verification")
    .setDescription(
      "Until you verify, you can only view the arrivals and verification channels and cannot chat. Click **Verify** below to receive the **✅ Verified** role and access the community."
    )
    .addFields({
      name: "Need help?",
      value: "Use **🆘・help-desk** or open a support ticket.",
    });
}

function buildVerificationComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("verify_member")
        .setLabel("Verify")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildSelfRoleEmbed(roles) {
  const roleList = roles
    .map(({ definition, role }) => `${definition.emoji} - <@&${role.id}>`)
    .join("\n");
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("Vhila SMP Self Roles 🌴")
    .setDescription(
      [
        "Select a notification role below to add it. Select it again to remove it. You can choose several roles over time.",
        "",
        roleList,
      ].join("\n")
    )
    .setFooter({ text: "Vhila SMP • Opt in to the updates you want" });
}

function buildSelfRoleComponents(roles) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("self_roles_select")
        .setPlaceholder("Choose a notification role")
        .setMaxValues(1)
        .addOptions(
          roles.map(({ definition, role }) => ({
            label: definition.label,
            value: role.id,
            description: definition.description,
            emoji: definition.emoji,
          }))
        )
    ),
  ];
}

function buildWelcomeEmbed(guild, user) {
  const verificationChannel = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.name.includes("verification")
  );
  const rulesChannel = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.name.includes("server-rules")
  );
  const helpChannel = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.name.includes("help-desk")
  );
  const channelLink = channel => channel ? `${channel}` : "the appropriate server channel";

  return new EmbedBuilder()
    .setColor(0xF59E67)
    .setTitle(`Welcome to ${guild.name}! 🚔`)
    .setDescription(
      [
        `Welcome ${user} to **${guild.name}**! You cannot chat or access the other server channels until you verify in ${channelLink(verificationChannel)} and receive the **✅ Verified** role.`,
        `The arrivals and verification channels are available before verification. After verifying, please read ${channelLink(rulesChannel)}.`,
        "",
        "**Departments**",
        "Vhila SMP offers several teams you can join. Check announcements for openings and ask staff if you need help.",
        "",
        "**Our Departments:**",
        "> 🟠 🚔 | Police Department",
        "> 🟠 🚒 | Fire & Rescue",
        "> 🟠 🚧 | Department of Transportation",
        "> 🟠 👤 | Civilian Operations",
        "",
        `Need help? Contact the staff team in ${channelLink(helpChannel)}.`,
        "",
        "*By participating in Vhila SMP, you agree to follow the server rules and staff instructions.*",
      ].join("\n")
    )
    .setFooter({ text: "Vhila SMP • Welcome to the community" })
    .setTimestamp();
}

function buildServerStatusEmbed(status) {
  const isStart = status === "start";

  return new EmbedBuilder()
    .setColor(isStart ? 0x1F2937 : 0x111315)
    .setTitle(isStart ? "Server Is Back Up" : "Server Shut Down")
    .setDescription(
      isStart
        ? "The server is now back online. You can rejoin and continue playing."
        : "Do not rejoin the server as it is shut down.\nCheck back later for when the server is back up."
    )
    .setFooter({ text: isStart ? "SERVER START" : "SSD" })
    .setTimestamp();
}

function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("Support Tickets")
    .setDescription(
      [
        "**Creating A Ticket**",
        "Easily done by just selecting a reason below!",
        "",
        "**Ticket Rules**",
        "Create a ticket to get help with stuff.",
        "**✅ Okay reason to create a ticket**",
        "💬 To Ask For Support",
        "🤝 To Partner With us",
        "✨ To Apply for media",
        "🐛 To report a bug",
        "💳 For Payment support",
        "🚩 To report a player",
        "💬 Other",
        "",
        "Please choose the ticket option that best matches what you need.",
      ].join("\n")
    )
    .setFooter({ text: "mc.vhilsmp.xyz • Support" });
}

function buildSSUInfoEmbed() {
  return new EmbedBuilder()
    .setColor(0x111827)
    .setTitle("🚨 SSU Information")
    .setDescription(
      [
        "Welcome to the SSU! Below is the information you need to get started and understand how operations work.",
        "",
        "**How do I join a SSU?**",
        "Join the SSU application channel, fill out the required form, and wait for an invite from the department team or command staff.",
        "",
        "**When is a SSU hosted?**",
        "SSU events are hosted on a set schedule announced in the community channels and the event announcements.",
        "",
        "**What do I need to know before joining?**",
        "Be respectful, follow all instructions from command staff, and stay active in the server and roleplay community.",
        "",
        "**How do I get help?**",
        "Use the support channels or contact a staff member if you are unsure about placement, eligibility, or event scheduling.",
      ].join("\n")
    )
    .addFields(
      { name: "📌 SSU Rules", value: "Follow all department instructions, maintain professionalism, and only use official SSU channels.", inline: false },
      { name: "🧭 Ready to Join?", value: "Apply through the correct channel and keep an eye on announcements for the next host session.", inline: false }
    )
    .setFooter({ text: "Vhila SMP • SSU Department Info" })
    .setTimestamp();
}

function buildTicketPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket_type_select")
        .setPlaceholder("Choose a ticket type")
        .addOptions(TICKET_TYPES)
    ),
  ];
}

function buildPartnershipPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xF59E67)
    .setTitle("🤝 Partner with Vhila SMP")
    .setDescription(
      [
        "Want to partner with **Vhila SMP**? Submit your server details using the button below.",
        "",
        "Include your Discord invite, ER:LC server code, and a short introduction. Staff will review your submission. Approved ads are posted in our partnerships channel.",
        "",
        "Please only submit legitimate communities and make sure your invite and server code are correct.",
      ].join("\n")
    )
    .setFooter({ text: "Vhila SMP Partnerships • Submissions require staff approval" });
}

function buildPartnershipPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("partnership_apply")
        .setLabel("Submit Partnership")
        .setEmoji("🤝")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildPartnershipModal() {
  return new ModalBuilder()
    .setCustomId("partnership_submit_modal")
    .setTitle("Vhila SMP Partnership Submission")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("partner_server_name")
          .setLabel("Community/server name")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("partner_invite")
          .setLabel("Discord invite link")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setPlaceholder("https://discord.gg/your-invite")
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("partner_erlc_code")
          .setLabel("ER:LC server code")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("partner_description")
          .setLabel("Short community introduction")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(800)
          .setRequired(true)
      )
    );
}

function partnershipPublishChannel(guild) {
  return guild.channels.cache.find(channel => {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      return false;
    }

    const name = channel.name.toLowerCase();
    const reviewLabels = [
      "partnership-review",
      "partnership-applications",
      "partnership-chat",
      "partnerships-chat",
      "partner-review",
      "partner-applications",
      "partnership-submissions",
      "partnership-requests",
    ];
    if (reviewLabels.some(label => name.includes(label))) {
      return false;
    }

    return name.includes("partnership") ||
      name.includes("affiliate") ||
      name.includes("partners");
  });
}

function partnershipReviewChannel(guild) {
  return guild.channels.cache.find(channel => {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      return false;
    }

    const name = channel.name.toLowerCase();
    return [
      "partnership-review",
      "partnership-applications",
      "partnership-chat",
      "partnerships-chat",
      "partnership-submissions",
      "partnership-requests",
      "partner-review",
      "partner-applications",
    ].some(label => name.includes(label));
  });
}

async function ensurePartnershipReviewChannel(guild) {
  const reviewChannel = partnershipReviewChannel(guild);
  if (reviewChannel) return reviewChannel;

  const publicChannel = partnershipPublishChannel(guild);
  if (publicChannel) return publicChannel;

  try {
    return await guild.channels.create({
      name: "partnership-review",
      type: ChannelType.GuildText,
      reason: "Create a staff review channel for partnership applications.",
    });
  } catch {
    return null;
  }
}

function isValidDiscordInvite(invite) {
  try {
    const url = new URL(invite);
    const secure = url.protocol === "https:";
    const validHost = url.hostname === "discord.gg" ||
      url.hostname === "discord.com" ||
      url.hostname === "www.discord.com";
    const validPath = url.hostname === "discord.gg"
      ? url.pathname.length > 1
      : url.pathname.startsWith("/invite/") && url.pathname.length > 8;
    return secure && validHost && validPath;
  } catch {
    return false;
  }
}

function buildPartnershipReviewEmbed(submission, user) {
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle("Partnership Request — Pending Review")
    .setDescription(`Submitted by ${user}`)
    .addFields(
      { name: "Community name", value: submission.serverName },
      { name: "Discord invite", value: submission.invite },
      { name: "ER:LC server code", value: submission.erlcCode },
      { name: "About the community", value: submission.description }
    )
    .setFooter({ text: `Applicant ID: ${user.id}` })
    .setTimestamp();
}

function buildPartnershipReviewComponents(applicantId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`partnership_approve:${applicantId}`)
        .setLabel("Approve & Post")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`partnership_reject:${applicantId}`)
        .setLabel("Reject")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildPaidAdPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle("📣 Vhila SMP Paid Advertisements")
    .setDescription(
      [
        "Want to promote your ER:LC community? Submit your advertisement below.",
        "",
        "Contact Vhila SMP staff for the current price and payment instructions before submitting. Payment is handled privately with staff; the bot does not collect or verify payments.",
        "",
        "Staff will confirm payment and review your ad before it is posted. Do not include payment details or personal information in your submission.",
      ].join("\n")
    )
    .setFooter({ text: "Vhila SMP Paid Ads • Staff approval and payment confirmation required" });
}

function buildPaidAdPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("paid_ad_apply")
        .setLabel("Submit Paid Ad")
        .setEmoji("📣")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildPaidAdModal() {
  return new ModalBuilder()
    .setCustomId("paid_ad_submit_modal")
    .setTitle("Vhila SMP Paid Ad Submission")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("paid_ad_name")
          .setLabel("Community/server name")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("paid_ad_invite")
          .setLabel("Discord invite link")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setPlaceholder("https://discord.gg/your-invite")
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("paid_ad_erlc_code")
          .setLabel("ER:LC server code")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("paid_ad_description")
          .setLabel("Advertisement text")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(800)
          .setRequired(true)
      )
    );
}

function paidAdReviewChannel(guild) {
  return guild.channels.cache.find(channel =>
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
    ["paid-ad-review", "paid-ad-applications"].some(name =>
      channel.name.toLowerCase().includes(name)
    )
  );
}

async function ensurePaidAdReviewChannel(guild) {
  const existing = paidAdReviewChannel(guild);
  if (existing) return existing;

  try {
    return await guild.channels.create({
      name: "paid-ad-review",
      type: ChannelType.GuildText,
      reason: "Create a staff review channel for paid ad submissions.",
    });
  } catch {
    return null;
  }
}

function paidAdPublishChannel(guild) {
  return guild.channels.cache.find(channel =>
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
    ["paid-ads", "paid-advertisements"].some(name =>
      channel.name.toLowerCase().includes(name)
    )
  );
}

function buildPaidAdReviewEmbed(submission, user) {
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle("Paid Advertisement — Payment Pending")
    .setDescription(`Submitted by ${user}. Confirm payment with the advertiser before approving.`)
    .addFields(
      { name: "Community name", value: submission.serverName },
      { name: "Discord invite", value: submission.invite },
      { name: "ER:LC server code", value: submission.erlcCode },
      { name: "Advertisement text", value: submission.description }
    )
    .setFooter({ text: `Applicant ID: ${user.id}` })
    .setTimestamp();
}

function buildPaidAdReviewComponents(applicantId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`paid_ad_approve:${applicantId}`)
        .setLabel("Mark Paid & Post")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`paid_ad_reject:${applicantId}`)
        .setLabel("Reject")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildPaidAdEmbed(fields) {
  const valueFor = name => fields.find(field => field.name === name)?.value;
  const serverName = valueFor("Community name");
  const invite = valueFor("Discord invite");
  const erlcCode = valueFor("ER:LC server code");
  const description = valueFor("Advertisement text");
  if (!serverName || !invite || !erlcCode || !description) {
    throw new Error("The paid advertisement submission is missing required details.");
  }

  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle(`📣 ${serverName}`)
    .setDescription(description)
    .addFields(
      { name: "Discord", value: invite, inline: true },
      { name: "ER:LC Server Code", value: erlcCode, inline: true }
    )
    .setFooter({ text: "Vhila SMP Paid Advertisement" })
    .setTimestamp();
}

function buildApprovedPartnershipEmbed(fields) {
  const valueFor = name => fields.find(field => field.name === name)?.value;
  const serverName = valueFor("Community name");
  const invite = valueFor("Discord invite");
  const erlcCode = valueFor("ER:LC server code");
  const description = valueFor("About the community");
  if (!serverName || !invite || !erlcCode || !description) {
    throw new Error("The partnership submission is missing required details.");
  }

  return new EmbedBuilder()
    .setColor(0xF59E67)
    .setTitle(`🤝 ${serverName}`)
    .setDescription(description)
    .addFields(
      { name: "Discord", value: invite, inline: true },
      { name: "ER:LC Server Code", value: erlcCode, inline: true }
    )
    .setFooter({ text: "Vhila SMP Community Partnership" })
    .setTimestamp();
}

function findExistingTicket(guild, ticketTypeValue, userId) {
  const topic = `Ticket type: ${ticketTypeValue}; Owner: ${userId}`;
  return guild.channels.cache.find(
    channel => channel.type === ChannelType.GuildText &&
      channel.topic === topic &&
      channel.parent &&
      channel.parent.name === "🎫 Support Tickets"
  );
}

function buildInGameRuleEmbeds() {
  const rulesPerEmbed = 4;
  const pageCount = Math.ceil(IN_GAME_RULES.length / rulesPerEmbed);

  return Array.from({ length: pageCount }, (_, page) => {
    const rules = IN_GAME_RULES.slice(
      page * rulesPerEmbed,
      (page + 1) * rulesPerEmbed
    );
    const description = rules
      .map(rule => `**${rule.title}**\n${rule.description}`)
      .join("\n\n");

    return new EmbedBuilder()
      .setColor(0xF59E67)
      .setTitle("Vhila SMP In-game Rules")
      .setDescription(description)
      .setFooter({ text: `Page ${page + 1} of ${pageCount} • Vhila SMP` });
  });
}

function buildStaffRuleEmbeds() {
  const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const blocks = STAFF_RULES.map(
    rule => `**${rule.title}**\n${rule.description}\n\n${separator}`
  );
  blocks.push(STAFF_PUNISHMENT_SYSTEM);

  const pages = [];
  let description = STAFF_RULES_INTRO;

  for (const block of blocks) {
    const candidate = `${description}\n\n${block}`;
    if (candidate.length > 3800 && description !== STAFF_RULES_INTRO) {
      pages.push(description);
      description = block;
    } else {
      description = candidate;
    }
  }
  pages.push(description);

  return pages.map((pageDescription, index) =>
    new EmbedBuilder()
      .setColor(0xE53935)
      .setTitle(index === 0 ? "🔴 Vhila SMP | STAFF RULES" : `🔴 Vhila SMP | STAFF RULES (Page ${index + 1})`)
      .setDescription(pageDescription)
      .setFooter({ text: `Page ${index + 1} of ${pages.length} • Vhila SMP Staff` })
  );
}

function buildStaffDiscordRuleEmbeds() {
  const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const blocks = STAFF_DISCORD_RULES.map(
    rule => `**${rule.title}**\n${rule.description}\n\n${separator}`
  );
  blocks.push(STAFF_DISCORD_RULES_SIGNOFF);

  const pages = [];
  let description = STAFF_DISCORD_RULES_INTRO;
  for (const block of blocks) {
    const candidate = `${description}\n\n${block}`;
    if (candidate.length > 3800 && description !== STAFF_DISCORD_RULES_INTRO) {
      pages.push(description);
      description = block;
    } else {
      description = candidate;
    }
  }
  pages.push(description);

  return pages.map((pageDescription, index) =>
    new EmbedBuilder()
      .setColor(0xE53935)
      .setTitle(index === 0
        ? "🔴 Vhila SMP | STAFF DISCORD RULES"
        : `🔴 Vhila SMP | STAFF DISCORD RULES (Page ${index + 1})`)
      .setDescription(pageDescription)
      .setFooter({ text: `Page ${index + 1} of ${pages.length} • Vhila SMP Staff` })
  );
}

function getStaffRoles(guild) {
  const staffNamePattern = /\b(staff|moderator|mod|admin|management|founder|owner|director|supervisor|helper|command|leadership)\b/i;
  const staffPermissions = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ViewAuditLog,
  ];
  const roles = guild.roles.cache
    .filter(role =>
      role.id !== guild.id &&
      !role.managed &&
      (
        STAFF_ROLE_DISPLAY_NAME_SET.has(role.name.toLowerCase()) ||
        staffNamePattern.test(role.name) ||
        role.permissions.any(staffPermissions)
      )
    )
    .sort((first, second) => second.position - first.position);
  return [...roles.values()];
}

function buildStaffRoleEmbeds(guild) {
  const roles = getStaffRoles(guild);
  if (roles.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(COLORS.accent)
        .setTitle("🌴 Vhila | Staff Roles")
        .setDescription("I couldn't find staff roles by name or moderation permissions in this server.")
        .setTimestamp(),
    ];
  }

  const roleNames = roles.map((role, index) => `**${index + 1}.** ${role.name}`);
  const rolesPerPage = 20;
  const pageCount = Math.ceil(roleNames.length / rolesPerPage);

  return Array.from({ length: pageCount }, (_, page) =>
    new EmbedBuilder()
      .setColor(COLORS.accent)
      .setTitle(page === 0
        ? "🌴 Vhila | Staff Roles"
        : `🌴 Vhila | Staff Roles (Page ${page + 1})`)
      .setDescription(roleNames.slice(page * rolesPerPage, (page + 1) * rolesPerPage).join("\n"))
      .setFooter({ text: `Ordered by role hierarchy • Page ${page + 1} of ${pageCount}` })
      .setTimestamp()
  );
}

async function hasRecentBotPanel(channel, title) {
  try {
    const messages = await channel.messages.fetch({ limit: 25 });
    return messages.some(
      msg => msg.author.id === client.user.id &&
        msg.embeds.some(embed => embed.title === title)
    );
  } catch {
    return false;
  }
}

async function installPanels(guild, channels) {
  const rules = channels.get("📜・server-rules");
  if (rules && !(await hasRecentBotPanel(rules, "📜 Server Rules"))) {
    await rules.send({ embeds: [buildRulesEmbed(guild)] });
  }

  const announcements = channels.get("📣・announcements");
  if (announcements && !(await hasRecentBotPanel(announcements, "📣 Community Hub"))) {
    await announcements.send({ embeds: [buildAnnouncementEmbed(guild)] });
  }

  const verification = channels.get("✅・verification");
  if (verification && !(await hasRecentBotPanel(verification, "✅ Vhila SMP Verification"))) {
    await verification.send({
      embeds: [buildVerificationEmbed()],
      components: buildVerificationComponents(),
    });
  }

  const support = channels.get("🆘・help-desk");
  if (support && !(await hasRecentBotPanel(support, "Vhila SMP | Ticket System"))) {
    await support.send({
      embeds: [buildTicketPanelEmbed()],
      components: buildTicketPanelComponents(),
    });
  }

  const info = channels.get("📌・usage-guide");
  if (info && !(await hasRecentBotPanel(info, "🚨 SSU Information"))) {
    await info.send({ embeds: [buildSSUInfoEmbed()] });
  }

}

async function ensureTicketCategory(guild) {
  return ensureCategory(guild, "🎫 Support Tickets");
}

async function openTicket(interaction, ticketTypeValue = "general-support") {
  const guild = interaction.guild;
  const member = interaction.member;
  const ticketType = TICKET_TYPES.find(type => type.value === ticketTypeValue);
  if (!ticketType) {
    await interaction.reply({
      content: "That ticket type is not available. Please choose an option from the ticket menu.",
      ephemeral: true,
    });
    return;
  }

  const ticketTopic = `Ticket type: ${ticketType.value}; Owner: ${member.id}`;
  const existing = findExistingTicket(guild, ticketType.value, member.id);

  if (existing) {
    await interaction.reply({
      content: `You already have a ticket: ${existing}`,
      ephemeral: true,
    });
    return;
  }

  const roles = {};
  for (const def of ROLE_DEFS) {
    const role = roleByName(guild, def.name);
    if (role) roles[def.name] = role;
  }

  const category = await ensureTicketCategory(guild);
  const safeName = member.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 18) || "member";
  const channelName = `ticket-${ticketType.value}-${safeName}-${member.id.slice(-6)}`;

  const ticketStaffRoles = new Map(
    STAFF_ROLE_NAMES
      .map(name => roles[name])
      .filter(Boolean)
      .map(role => [role.id, role])
  );
  const configuredRoleIds = await configuredTicketRoleIds(guild.id);
  for (const roleId of configuredRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (role && role.id !== guild.roles.everyone.id) {
      ticketStaffRoles.set(role.id, role);
    }
  }
  const staffRoles = [...ticketStaffRoles.values()];

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
      ],
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...staffRoles.map(role => ({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    })),
  ];

  const ticket = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    topic: ticketTopic,
    reason: `${ticketType.label} ticket created`,
  });

  const ticketControls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("Close Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
  if (ticketType.value === "apply-for-staff") {
    ticketControls.addComponents(
      new ButtonBuilder()
        .setCustomId("agree_staff_application")
        .setLabel("Yes I Agree")
        .setStyle(ButtonStyle.Success)
    );
  }

  await ticket.send({
    content: `${staffRoles.map(role => role.toString()).join(" ")} ${member} opened a ticket.`,
    allowedMentions: {
      parse: [],
      roles: staffRoles.map(role => role.id),
      users: [member.id],
    },
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.accent)
        .setTitle(ticketType.value === "apply-for-staff"
          ? "Vhila SMP | STAFF APPLICATION"
          : `🎫 ${ticketType.label}`)
        .setDescription(
          ticketType.value === "apply-for-staff"
            ? STAFF_APPLICATION_TEMPLATE
            : `**${ticketType.label}**\n\n${ticketType.description}\n\nPlease provide the details staff need to help you. A staff member will respond here.`
        )
        .setTimestamp()
    ],
    components: [ticketControls],
  });

  await interaction.reply({
    content: `Your **${ticketType.label}** ticket is ready: ${ticket}`,
    ephemeral: true,
  });
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return;

  if (!isStaff(interaction.member) && !channel.name.startsWith("ticket-")) {
    await interaction.reply({ content: "This is not a ticket channel.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "Closing ticket in 3 seconds...", ephemeral: true });

  setTimeout(async () => {
    try {
      await channel.delete("Ticket closed");
    } catch (error) {
      console.error("Ticket delete failed:", error.message);
    }
  }, 3000);
}


async function lockChannel(channel) {
  if (!channel.isTextBased() || channel.isDMBased()) {
    throw new Error("This command can only be used in a server text channel.");
  }

  const lockPermissions = {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: false,
  };
  const lockablePermissions = [
    [PermissionFlagsBits.SendMessages, "SendMessages"],
    [PermissionFlagsBits.CreatePublicThreads, "CreatePublicThreads"],
    [PermissionFlagsBits.CreatePrivateThreads, "CreatePrivateThreads"],
    [PermissionFlagsBits.SendMessagesInThreads, "SendMessagesInThreads"],
  ];
  const botMember = channel.guild.members.me;
  if (!channelLockSnapshots.has(channel.id)) {
    const snapshots = [...channel.permissionOverwrites.cache.values()].map(overwrite => ({
      id: overwrite.id,
      permissions: Object.fromEntries(
        lockablePermissions.map(([permission, name]) => [
          name,
          overwrite.allow.has(permission)
            ? true
            : overwrite.deny.has(permission)
              ? false
              : null,
        ])
      ),
    }));
    if (!snapshots.some(snapshot => snapshot.id === channel.guild.roles.everyone.id)) {
      snapshots.push({
        id: channel.guild.roles.everyone.id,
        permissions: Object.fromEntries(lockablePermissions.map(([, name]) => [name, null])),
      });
    }
    if (botMember && !snapshots.some(snapshot => snapshot.id === botMember.id)) {
      snapshots.push({
        id: botMember.id,
        permissions: Object.fromEntries(lockablePermissions.map(([, name]) => [name, null])),
      });
    }
    channelLockSnapshots.set(channel.id, snapshots);
  }

  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    lockPermissions,
    { reason: "Channel lock command" }
  );

  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (
      overwrite.id === channel.guild.roles.everyone.id ||
      overwrite.id === botMember?.id
    ) {
      continue;
    }
    await channel.permissionOverwrites.edit(overwrite.id, lockPermissions, {
      reason: "Channel lock command",
    });
  }

  if (botMember) {
    await channel.permissionOverwrites.edit(botMember, {
      SendMessages: true,
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      SendMessagesInThreads: true,
    }, { reason: "Allow bot to report channel lock status" });
  }
}

async function unlockChannel(channel) {
  if (!channel.isTextBased() || channel.isDMBased()) {
    throw new Error("This command can only be used in a server text channel.");
  }

  const snapshots = channelLockSnapshots.get(channel.id);
  if (snapshots) {
    for (const snapshot of snapshots) {
      await channel.permissionOverwrites.edit(snapshot.id, snapshot.permissions, {
        reason: "Channel unlock command",
      });
    }
    channelLockSnapshots.delete(channel.id);
  } else {
    const unlockPermissions = {
      SendMessages: null,
      CreatePublicThreads: null,
      CreatePrivateThreads: null,
      SendMessagesInThreads: null,
    };
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      unlockPermissions,
      { reason: "Channel unlock command" }
    );

    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.id === channel.guild.roles.everyone.id) continue;
      await channel.permissionOverwrites.edit(overwrite.id, unlockPermissions, {
        reason: "Channel unlock command",
      });
    }
  }
}

async function announceChannelLockState(channel, locked, moderator) {
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(locked ? COLORS.moderator : COLORS.supporter)
        .setTitle(locked ? "🔒 Channel Locked" : "🔓 Channel Unlocked")
        .setDescription(
          locked
            ? "Members can no longer send messages in this channel."
            : "Members can send messages in this channel again."
        )
        .addFields({ name: "Changed by", value: `${moderator}` })
        .setTimestamp(),
    ],
  });
}

async function clearChannelMessages(channel, commandMessage) {
  const messages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) break;

    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  if (!messages.some(message => message.id === commandMessage.id)) {
    messages.unshift(commandMessage);
  }

  let deleted = 0;
  const bulkDeleteCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < messages.length; index += 100) {
    const batch = messages.slice(index, index + 100);
    const recentMessages = batch.filter(message => message.createdTimestamp >= bulkDeleteCutoff);
    const oldMessages = batch.filter(message => message.createdTimestamp < bulkDeleteCutoff);

    if (recentMessages.length > 0) {
      const removed = await channel.bulkDelete(recentMessages, true);
      deleted += removed.size;
    }

    for (const message of oldMessages) {
      await message.delete("Channel cleared by moderator");
      deleted++;
    }
  }

  return deleted;
}

async function readGiveaways() {
  let rawData;
  try {
    rawData = await readFile(GIVEAWAY_STORE_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const records = JSON.parse(rawData);
  if (
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    Object.values(records).some(record =>
      !record ||
      typeof record.guildId !== "string" ||
      typeof record.channelId !== "string" ||
      typeof record.prize !== "string" ||
      !Number.isInteger(record.winnerCount) ||
      !Number.isFinite(record.endAt) ||
      !Array.isArray(record.entrantIds) ||
      record.entrantIds.some(id => typeof id !== "string") ||
      !Array.isArray(record.winnerIds) ||
      record.winnerIds.some(id => typeof id !== "string") ||
      !Array.isArray(record.excludedWinnerIds) ||
      record.excludedWinnerIds.some(id => typeof id !== "string") ||
      !["active", "ended"].includes(record.status)
    )
  ) {
    throw new Error("giveaways.json has an invalid format.");
  }

  return records;
}

function persistGiveaways() {
  const operation = giveawayStoreUpdates.then(async () => {
    const records = Object.fromEntries(giveawayStore);
    const temporaryPath = `${GIVEAWAY_STORE_PATH}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, GIVEAWAY_STORE_PATH);
  });

  giveawayStoreUpdates = operation.catch(() => {});
  return operation;
}

function parseGiveawayDuration(input) {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) {
    throw new Error("Use a duration like `30m`, `2h`, or `1d`.");
  }

  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const duration = Number(match[1]) * units[match[2].toLowerCase()];
  if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 30 * 86_400_000) {
    throw new Error("Giveaways must last at least 1 minute and no more than 30 days.");
  }
  return duration;
}

function buildGiveawayEmbed(giveaway) {
  const embed = new EmbedBuilder()
    .setColor(giveaway.status === "active" ? COLORS.accent : COLORS.supporter)
    .setTitle(giveaway.status === "active" ? "🎉 Giveaway" : "🎉 Giveaway Ended")
    .setDescription(`**Prize:** ${giveaway.prize}`)
    .addFields(
      { name: "Winners", value: String(giveaway.winnerCount), inline: true },
      { name: "Entries", value: String(giveaway.entrantIds.length), inline: true },
      {
        name: giveaway.status === "active" ? "Ends" : "Status",
        value: giveaway.status === "active"
          ? `<t:${Math.floor(giveaway.endAt / 1000)}:R>`
          : "Ended",
        inline: true,
      }
    )
    .setFooter({
      text: giveaway.messageId
        ? `Giveaway ID: ${giveaway.messageId}`
        : "Click below to enter",
    });

  if (giveaway.status === "ended") {
    embed.addFields({
      name: "Winner(s)",
      value: giveaway.winnerIds.length > 0
        ? giveaway.winnerIds.map(id => `<@${id}>`).join(", ")
        : "No eligible entries.",
    });
  }

  return embed;
}

function buildGiveawayComponents(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("giveaway_enter")
        .setLabel("Enter Giveaway")
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    ),
  ];
}

function pickGiveawayWinners(entrantIds, winnerCount, excludedIds = []) {
  const excluded = new Set(excludedIds);
  const candidates = entrantIds.filter(id => !excluded.has(id));
  const winners = [];

  while (winners.length < winnerCount && candidates.length > 0) {
    const index = randomInt(candidates.length);
    winners.push(candidates.splice(index, 1)[0]);
  }
  return winners;
}

async function fetchGiveawayMessage(giveaway) {
  const guild = await client.guilds.fetch(giveaway.guildId);
  const channel = await guild.channels.fetch(giveaway.channelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new Error("The giveaway channel is no longer available.");
  }
  return channel.messages.fetch(giveaway.messageId);
}

function scheduleGiveaway(messageId, giveaway) {
  const existingTimer = giveawayTimers.get(messageId);
  if (existingTimer) clearTimeout(existingTimer);
  giveawayTimers.delete(messageId);
  if (giveaway.status !== "active") return;

  const delay = Math.max(0, giveaway.endAt - Date.now());
  const timer = setTimeout(async () => {
    giveawayTimers.delete(messageId);
    const current = giveawayStore.get(messageId);
    if (!current || current.status !== "active") return;
    if (current.endAt > Date.now()) {
      scheduleGiveaway(messageId, current);
      return;
    }

    try {
      await finishGiveaway(messageId);
    } catch (error) {
      console.error(`Could not finish giveaway ${messageId}: ${error.message}`);
      const activeGiveaway = giveawayStore.get(messageId);
      if (activeGiveaway?.status === "active") {
        activeGiveaway.endAt = Date.now() + 60_000;
        try {
          await persistGiveaways();
          scheduleGiveaway(messageId, activeGiveaway);
        } catch (persistError) {
          console.error(`Could not reschedule giveaway ${messageId}: ${persistError.message}`);
        }
      }
    }
  }, Math.min(delay, 2_147_000_000));
  timer.unref();
  giveawayTimers.set(messageId, timer);
}

async function loadGiveaways() {
  const records = await readGiveaways();
  giveawayStore.clear();
  for (const [messageId, giveaway] of Object.entries(records)) {
    giveaway.messageId = messageId;
    giveawayStore.set(messageId, giveaway);
    scheduleGiveaway(messageId, giveaway);
  }
}

async function finishGiveaway(messageId) {
  if (giveawayLocks.has(messageId)) {
    throw new Error("This giveaway is already being updated.");
  }
  const giveaway = giveawayStore.get(messageId);
  if (!giveaway || giveaway.status !== "active") {
    throw new Error("That giveaway is not active.");
  }

  giveawayLocks.add(messageId);
  const previousState = {
    status: giveaway.status,
    winnerIds: [...giveaway.winnerIds],
  };
  try {
    giveaway.status = "ended";
    giveaway.winnerIds = pickGiveawayWinners(
      giveaway.entrantIds,
      giveaway.winnerCount,
      giveaway.excludedWinnerIds
    );
    await persistGiveaways();

    const message = await fetchGiveawayMessage(giveaway);
    await message.edit({
      content: giveaway.winnerIds.length > 0
        ? `🎉 Congratulations ${giveaway.winnerIds.map(id => `<@${id}>`).join(", ")}!`
        : "🎉 Giveaway ended with no eligible entries.",
      embeds: [buildGiveawayEmbed(giveaway)],
      components: buildGiveawayComponents(true),
      allowedMentions: { users: giveaway.winnerIds },
    });
    const timer = giveawayTimers.get(messageId);
    if (timer) clearTimeout(timer);
    giveawayTimers.delete(messageId);
    return giveaway;
  } catch (error) {
    giveaway.status = previousState.status;
    giveaway.winnerIds = previousState.winnerIds;
    await persistGiveaways();
    throw error;
  } finally {
    giveawayLocks.delete(messageId);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await registerCommands(readyClient.user);
  } catch (error) {
    console.error("Command registration failed:", error);
  }

  try {
    await loadGiveaways();
    console.log("Giveaways restored.");
  } catch (error) {
    console.error("Giveaway restore failed:", error);
  }
  console.log("Ready.");
});

client.on(Events.GuildMemberAdd, async member => {
  let welcomeEnabled;
  try {
    welcomeEnabled = await automaticWelcomeEnabled(member.guild.id);
  } catch (error) {
    console.error(`Could not read welcome settings for ${member.guild.name}: ${error.message}`);
    return;
  }
  if (!welcomeEnabled) return;

  const textChannels = member.guild.channels.cache.filter(
    channel => channel.type === ChannelType.GuildText
  );
  const welcomeChannel =
    textChannels.find(channel =>
      channel.name.toLowerCase().replace(/^[^a-z]*/, "") === "arrivals"
    ) ||
    textChannels.find(channel =>
      channel.name.toLowerCase().replace(/^[^a-z]*/, "") === "welcome"
    ) ||
    textChannels.find(channel => channel.name.toLowerCase().includes("welcome")) ||
    textChannels.find(channel => channel.name.toLowerCase().includes("introduction"));
  if (welcomeChannel) {
    try {
      await welcomeChannel.send({
        content: `Welcome ${member}!`,
        embeds: [buildWelcomeEmbed(member.guild, member.user)],
        allowedMentions: { users: [member.id] },
      });
    } catch (error) {
      console.error(`Welcome message failed for ${member.user.tag}: ${error.message}`);
    }
  } else {
    console.warn(`No arrivals, welcome, or introductions channel found in ${member.guild.name}.`);
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.inGuild()) return;

  const command = message.content.trim().toLowerCase();
  if (command === "!lock") {
    if (!message.member || !isStaff(message.member)) {
      await message.reply("You need staff permissions to lock this channel.");
      return;
    }

    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.GuildAnnouncement
    ) {
      await message.reply("Use this command in a server text channel.");
      return;
    }

    try {
      await lockChannel(message.channel);
      await announceChannelLockState(message.channel, true, message.author);
    } catch (error) {
      console.error("Lock command failed:", error);
      await message.reply(`❌ Could not lock the channel: ${error.message}`);
    }
    return;
  }

  if (command === "!unlock") {
    if (!message.member || !isStaff(message.member)) {
      await message.reply("You need staff permissions to unlock this channel.");
      return;
    }

    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.GuildAnnouncement
    ) {
      await message.reply("Use this command in a server text channel.");
      return;
    }

    try {
      await unlockChannel(message.channel);
      await announceChannelLockState(message.channel, false, message.author);
    } catch (error) {
      console.error("Unlock command failed:", error);
      await message.reply(`❌ Could not unlock the channel: ${error.message}`);
    }
    return;
  }

  if (command !== "!cleas" && command !== "!clear") return;

  if (!message.member || !isStaff(message.member)) {
    await message.reply("You need staff permissions to clear this channel.");
    return;
  }

  if (
    message.channel.type !== ChannelType.GuildText &&
    message.channel.type !== ChannelType.GuildAnnouncement
  ) {
    await message.reply("Use this command in a server text channel.");
    return;
  }

  const botMember = message.guild.members.me;
  if (!botMember || !message.channel.permissionsFor(botMember)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.SendMessages,
  ])) {
    await message.reply("I need View Channel, Read Message History, Manage Messages, and Send Messages to clear this channel.");
    return;
  }

  try {
    const deleted = await clearChannelMessages(message.channel, message);
    const confirmation = await message.channel.send(`🧹 Cleared ${deleted} messages.`);
    setTimeout(() => {
      confirmation.delete("Clear command confirmation expired").catch(error => {
        console.error("Clear confirmation cleanup failed:", error);
      });
    }, 5000);
  } catch (error) {
    console.error("Clear command failed:", error);
    await message.reply(`❌ Could not clear the channel completely: ${error.message}`);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "giveaway") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to manage giveaways.",
            ephemeral: true,
          });
          return;
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "start") {
          const prize = interaction.options.getString("prize", true).trim();
          const durationInput = interaction.options.getString("duration", true);
          const winnerCount = interaction.options.getInteger("winners", true);
          const channel = interaction.options.getChannel("channel") || interaction.channel;
          if (!prize) {
            await interaction.reply({
              content: "Please enter a prize for the giveaway.",
              ephemeral: true,
            });
            return;
          }
          const duration = parseGiveawayDuration(durationInput);
          const botMember = guild.members.me;
          if (
            !channel ||
            (channel.type !== ChannelType.GuildText &&
              channel.type !== ChannelType.GuildAnnouncement) ||
            !botMember ||
            !channel.permissionsFor(botMember)?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ])
          ) {
            await interaction.reply({
              content: "Choose a text or announcement channel where I can view, send messages, and embed links.",
              ephemeral: true,
            });
            return;
          }

          await interaction.deferReply({ ephemeral: true });
          const giveaway = {
            guildId: guild.id,
            channelId: channel.id,
            messageId: "",
            prize,
            winnerCount,
            endAt: Date.now() + duration,
            entrantIds: [],
            winnerIds: [],
            excludedWinnerIds: [],
            status: "active",
          };
          const message = await channel.send({
            content: "🎉 Giveaway! Click below to enter.",
            embeds: [buildGiveawayEmbed(giveaway)],
            components: buildGiveawayComponents(),
            allowedMentions: { parse: [] },
          });
          giveaway.messageId = message.id;
          giveawayStore.set(message.id, giveaway);
          try {
            await persistGiveaways();
          } catch (error) {
            giveawayStore.delete(message.id);
            await message.delete("Giveaway could not be saved").catch(deleteError => {
              console.error(`Could not remove unsaved giveaway ${message.id}: ${deleteError.message}`);
            });
            throw error;
          }
          scheduleGiveaway(message.id, giveaway);
          await interaction.editReply({
            content: `✅ Giveaway started in ${channel}: ${message.url}`,
          });
          return;
        }

        const messageId = interaction.options.getString("message_id", true);
        const giveaway = giveawayStore.get(messageId);
        if (
          !giveaway ||
          giveaway.guildId !== guild.id ||
          giveaway.channelId !== interaction.channelId
        ) {
          await interaction.reply({
            content: "I couldn't find that giveaway in this channel. Use the giveaway message ID and run the command in its channel.",
            ephemeral: true,
          });
          return;
        }

        if (subcommand === "end") {
          await interaction.deferReply({ ephemeral: true });
          await finishGiveaway(messageId);
          await interaction.editReply("✅ Giveaway ended and the winner(s) were announced.");
          return;
        }

        if (giveaway.status !== "ended") {
          await interaction.reply({
            content: "That giveaway is still active. End it before rerolling.",
            ephemeral: true,
          });
          return;
        }
        if (giveawayLocks.has(messageId)) {
          await interaction.reply({
            content: "That giveaway is already being updated. Try again in a moment.",
            ephemeral: true,
          });
          return;
        }

        const rerolledWinners = pickGiveawayWinners(
          giveaway.entrantIds,
          giveaway.winnerCount,
          [...giveaway.excludedWinnerIds, ...giveaway.winnerIds]
        );
        if (rerolledWinners.length === 0) {
          await interaction.reply({
            content: "There are no remaining entrants to reroll.",
            ephemeral: true,
          });
          return;
        }

        giveawayLocks.add(messageId);
        const previousWinners = [...giveaway.winnerIds];
        const previousExcludedWinners = [...giveaway.excludedWinnerIds];
        let messageUpdated = false;
        let stateChanged = false;
        try {
          await interaction.deferReply({ ephemeral: true });
          giveaway.excludedWinnerIds = [...new Set([
            ...giveaway.excludedWinnerIds,
            ...previousWinners,
          ])];
          giveaway.winnerIds = rerolledWinners;
          stateChanged = true;
          await persistGiveaways();
          const message = await fetchGiveawayMessage(giveaway);
          await message.edit({
            content: `🎉 Rerolled winner(s): ${rerolledWinners.map(id => `<@${id}>`).join(", ")}`,
            embeds: [buildGiveawayEmbed(giveaway)],
            components: buildGiveawayComponents(true),
            allowedMentions: { users: rerolledWinners },
          });
          messageUpdated = true;
          await interaction.editReply({
            content: `✅ New winner(s): ${rerolledWinners.map(id => `<@${id}>`).join(", ")}`,
            allowedMentions: { users: rerolledWinners },
          });
        } catch (error) {
          if (stateChanged && !messageUpdated) {
            giveaway.winnerIds = previousWinners;
            giveaway.excludedWinnerIds = previousExcludedWinners;
            await persistGiveaways();
          }
          throw error;
        } finally {
          giveawayLocks.delete(messageId);
        }
        return;
      }

      if (interaction.commandName === "ticketpanel") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the ticket menu.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send messages with embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({
          embeds: [buildTicketPanelEmbed()],
          components: buildTicketPanelComponents(),
        });
        await interaction.reply({
          content: `✅ Ticket menu posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "ssuinfo") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the SSU info panel.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({ embeds: [buildSSUInfoEmbed()] });
        await interaction.reply({
          content: `✅ SSU info panel posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "welcomepanel") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the welcome panel.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({ embeds: [buildWelcomeEmbed(guild, interaction.user)] });
        await interaction.reply({
          content: `✅ Welcome panel posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "infopanel") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the server information panel.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({ embeds: [buildServerInfoPanelEmbed(guild)] });
        await interaction.reply({
          content: `✅ Server information panel posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "partnershippanel") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the partnership application panel.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({
          embeds: [buildPartnershipPanelEmbed()],
          components: buildPartnershipPanelComponents(),
        });
        await interaction.reply({
          content: `✅ Partnership application panel posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "paidadpanel") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the paid advertisement panel.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({
          embeds: [buildPaidAdPanelEmbed()],
          components: buildPaidAdPanelComponents(),
        });
        await interaction.reply({
          content: `✅ Paid advertisement panel posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "rolepanel" || interaction.commandName === "verifybot") {
        const isRolePanel = interaction.commandName === "rolepanel";
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: `You need staff permissions to post the ${isRolePanel ? "self-role" : "verification"} panel.`,
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        if (isRolePanel) {
          const roles = await ensureSelfAssignableRoles(guild);
          const panel = await channel.send({
            embeds: [buildSelfRoleEmbed(roles)],
            components: buildSelfRoleComponents(roles),
            allowedMentions: { parse: [] },
          });
          await interaction.reply({
            content: `✅ Vhila SMP self-role panel posted in ${channel}: ${panel.url}`,
            ephemeral: true,
          });
        } else {
          const verifiedRole = await ensureVerifiedRole(guild);
          const panel = await channel.send({
            embeds: [buildVerificationEmbed()],
            components: buildVerificationComponents(),
          });
          const accessSetup = await configureVerificationAccess(
            guild,
            verifiedRole,
            channel
          );
          await interaction.reply({
            content: accessSetup.errors.length === 0
              ? `✅ Vhila SMP verification panel posted in ${channel}: ${panel.url}\n🔒 Configured access for ${accessSetup.configuredCount} channels. Only arrivals and verification are available before members receive the ✅ Verified role.`
              : `⚠️ Vhila SMP verification panel posted in ${channel}: ${panel.url}\nConfigured access for ${accessSetup.configuredCount} channels, but ${accessSetup.errors.length} channel(s) could not be updated:\n${accessSetup.errors.slice(0, 5).join("\n").slice(0, 1200)}`,
            ephemeral: true,
          });
        }
      }

      if (interaction.commandName === "rules") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the in-game rules.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        for (const embed of buildInGameRuleEmbeds()) {
          await channel.send({ embeds: [embed] });
        }
        await interaction.editReply(`✅ Posted all ${IN_GAME_RULES.length} Vhila SMP in-game rules in ${channel}.`);
      }

      if (interaction.commandName === "discordrules") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the Discord rules.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const panel = await channel.send({ embeds: [buildDiscordRulesEmbed(guild)] });
        await interaction.reply({
          content: `✅ Discord rules posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "staffrules") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the staff rules.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        for (const embed of buildStaffRuleEmbeds()) {
          await channel.send({ embeds: [embed] });
        }
        await interaction.editReply(`✅ Posted all ${STAFF_RULES.length} Vhila SMP staff rules and the punishment system in ${channel}.`);
      }

      if (interaction.commandName === "staffroles") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the staff role list.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        await guild.roles.fetch();
        await interaction.deferReply({ ephemeral: true });
        const embeds = buildStaffRoleEmbeds(guild);
        for (const embed of embeds) {
          await channel.send({ embeds: [embed] });
        }
        const roleCount = getStaffRoles(guild).length;
        await interaction.editReply(
          roleCount > 0
            ? `✅ Posted ${roleCount} staff role${roleCount === 1 ? "" : "s"} from this server in ${channel}.`
            : `⚠️ No staff roles were detected by name or permissions in this server.`
        );
      }

      if (interaction.commandName === "staffdiscordrules") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post the staff Discord rules.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        for (const embed of buildStaffDiscordRuleEmbeds()) {
          await channel.send({ embeds: [embed] });
        }
        await interaction.editReply(`✅ Posted all ${STAFF_DISCORD_RULES.length} Vhila SMP staff Discord rules in ${channel}.`);
      }

      if (interaction.commandName === "ticketroles") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to manage ticket roles.",
            ephemeral: true,
          });
          return;
        }

        const subcommand = interaction.options.getSubcommand();
        await guild.roles.fetch();
        const roleIds = await configuredTicketRoleIds(guild.id);

        if (subcommand === "list") {
          const configuredRoles = roleIds.map(roleId =>
            guild.roles.cache.get(roleId)?.toString() || `Deleted role (${roleId})`
          );
          await interaction.reply({
            content: configuredRoles.length > 0
              ? `Extra ticket roles: ${configuredRoles.join(", ")}`
              : "No extra ticket roles are configured. Default staff roles are still pinged and can access tickets.",
            ephemeral: true,
          });
          return;
        }

        const role = interaction.options.getRole("role", true);
        if (STAFF_ROLE_NAMES.includes(role.name)) {
          await interaction.reply({
            content: `${role} is already included as a default staff role for tickets.`,
            ephemeral: true,
          });
          return;
        }

        if (subcommand === "add") {
          if (roleIds.includes(role.id)) {
            await interaction.reply({
              content: `${role} is already configured for tickets.`,
              ephemeral: true,
            });
            return;
          }

          if (roleIds.length >= 20) {
            await interaction.reply({
              content: "You can configure up to 20 extra ticket roles.",
              ephemeral: true,
            });
            return;
          }

          await updateConfiguredTicketRoles(guild.id, currentRoleIds =>
            currentRoleIds.includes(role.id) ? currentRoleIds : [...currentRoleIds, role.id]
          );
          await interaction.reply({
            content: `✅ ${role} will be pinged and given access when a ticket is created.`,
            ephemeral: true,
          });
          return;
        }

        if (subcommand === "remove") {
          if (!roleIds.includes(role.id)) {
            await interaction.reply({
              content: `${role} is not configured as an extra ticket role.`,
              ephemeral: true,
            });
            return;
          }

          await updateConfiguredTicketRoles(guild.id, currentRoleIds =>
            currentRoleIds.filter(roleId => roleId !== role.id)
          );
          await interaction.reply({
            content: `✅ ${role} will no longer be pinged or given access to new tickets.`,
            ephemeral: true,
          });
        }
      }

      if (interaction.commandName === "serverinfo") {
        const guild = interaction.guild;
        const embed = new EmbedBuilder()
          .setColor(COLORS.accent)
          .setTitle(`📊 ${guild.name}`)
          .addFields(
            { name: "Members", value: String(guild.memberCount), inline: true },
            { name: "Channels", value: String(guild.channels.cache.size), inline: true },
            { name: "Roles", value: String(guild.roles.cache.size), inline: true },
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "serverstatus") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to post a server status message.",
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.channel;
        const botMember = guild.members.me;
        if (
          !botMember ||
          !channel?.isTextBased() ||
          channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
        ) {
          await interaction.reply({
            content: "I need permission to view and send embeds in this channel.",
            ephemeral: true,
          });
          return;
        }

        const status = interaction.options.getSubcommand();
        const panel = await channel.send({ embeds: [buildServerStatusEmbed(status)] });
        await interaction.reply({
          content: `✅ ${status === "start" ? "Server start" : "Server stop"} status posted in ${channel}: ${panel.url}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "welcomemessages") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to control automatic welcome messages.",
            ephemeral: true,
          });
          return;
        }

        const enabled = interaction.options.getSubcommand() === "start";
        await setAutomaticWelcomeEnabled(guild.id, enabled);
        await interaction.reply({
          content: enabled
            ? "✅ Automatic welcome messages are on."
            : "✅ Automatic welcome messages are off.",
          ephemeral: true,
        });
      }

      if (interaction.commandName === "lock" || interaction.commandName === "unlock") {
        if (!isStaff(interaction.member)) {
          await interaction.reply({
            content: "You need staff permissions to use this.",
            ephemeral: true,
          });
          return;
        }

        if (interaction.commandName === "lock") {
          await lockChannel(interaction.channel);
          await announceChannelLockState(interaction.channel, true, interaction.user);
        } else {
          await unlockChannel(interaction.channel);
          await announceChannelLockState(interaction.channel, false, interaction.user);
        }
        await interaction.reply({
          content: interaction.commandName === "lock"
            ? "🔒 Channel locked."
            : "🔓 Channel unlocked.",
          ephemeral: true,
        });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_type_select") {
      await openTicket(interaction, interaction.values[0]);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "self_roles_select") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "This role menu can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      await guild.roles.fetch();
      const selectableRoles = SELF_ROLE_DEFS
        .map(definition => ({ definition, role: roleByName(guild, definition.name) }))
        .filter(entry => entry.role);
      const selectableRoleIds = new Set(selectableRoles.map(entry => entry.role.id));
      if (interaction.values.some(roleId => !selectableRoleIds.has(roleId))) {
        await interaction.reply({
          content: "That menu contains an unavailable role. Please use the current self-role panel.",
          ephemeral: true,
        });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const selectedRole = selectableRoles.find(({ role }) => role.id === interaction.values[0])?.role;
      if (!selectedRole) {
        await interaction.reply({
          content: "That notification role is no longer available.",
          ephemeral: true,
        });
        return;
      }

      const botMember = guild.members.me;
      if (
        !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
        !selectedRole.editable
      ) {
        await interaction.reply({
          content: "I need Manage Roles permission and a role position above the notification roles to update your selections.",
          ephemeral: true,
        });
        return;
      }

      const alreadyHasRole = member.roles.cache.has(selectedRole.id);
      if (alreadyHasRole) {
        await member.roles.remove(selectedRole, "Member removed a Vhila SMP notification role");
      } else {
        await member.roles.add(selectedRole, "Member selected a Vhila SMP notification role");
      }
      await interaction.reply({
        content: alreadyHasRole
          ? `✅ Removed **${selectedRole.name}**.`
          : `✅ Added **${selectedRole.name}**.`,
        ephemeral: true,
      });
    }

    if (interaction.isModalSubmit() && interaction.customId === "partnership_submit_modal") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Partnership submissions can only be sent from a server.",
          ephemeral: true,
        });
        return;
      }

      const submission = {
        serverName: interaction.fields.getTextInputValue("partner_server_name").trim(),
        invite: interaction.fields.getTextInputValue("partner_invite").trim(),
        erlcCode: interaction.fields.getTextInputValue("partner_erlc_code").trim(),
        description: interaction.fields.getTextInputValue("partner_description").trim(),
      };
      if (!isValidDiscordInvite(submission.invite)) {
        await interaction.reply({
          content: "Please enter a valid HTTPS Discord invite, such as https://discord.gg/your-invite.",
          ephemeral: true,
        });
        return;
      }

      const reviewChannel = await ensurePartnershipReviewChannel(guild);
      const botMember = guild.members.me;
      if (
        !reviewChannel ||
        !botMember ||
        !reviewChannel.permissionsFor(botMember)?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ])
      ) {
        await interaction.reply({
          content: "I could not access the partnership channel. Please make sure the bot can view and post embeds there.",
          ephemeral: true,
        });
        return;
      }

      await reviewChannel.send({
        embeds: [buildPartnershipReviewEmbed(submission, interaction.user)],
        components: [buildPartnershipReviewComponents(interaction.user.id)[0]],
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: "✅ Your partnership request was sent to staff for review. If approved, your ad will be posted in the partnerships channel.",
        ephemeral: true,
      });
    }

    if (interaction.isModalSubmit() && interaction.customId === "paid_ad_submit_modal") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Paid ad submissions can only be sent from a server.",
          ephemeral: true,
        });
        return;
      }

      const submission = {
        serverName: interaction.fields.getTextInputValue("paid_ad_name").trim(),
        invite: interaction.fields.getTextInputValue("paid_ad_invite").trim(),
        erlcCode: interaction.fields.getTextInputValue("paid_ad_erlc_code").trim(),
        description: interaction.fields.getTextInputValue("paid_ad_description").trim(),
      };
      if (!isValidDiscordInvite(submission.invite)) {
        await interaction.reply({
          content: "Please enter a valid HTTPS Discord invite, such as https://discord.gg/your-invite.",
          ephemeral: true,
        });
        return;
      }

      const reviewChannel = await ensurePaidAdReviewChannel(guild);
      const botMember = guild.members.me;
      if (
        !reviewChannel ||
        !botMember ||
        !reviewChannel.permissionsFor(botMember)?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ])
      ) {
        await interaction.reply({
          content: "I could not create or access the `paid-ad-review` channel. Please make sure the bot can manage channels and post embeds there.",
          ephemeral: true,
        });
        return;
      }

      await reviewChannel.send({
        embeds: [buildPaidAdReviewEmbed(submission, interaction.user)],
        components: buildPaidAdReviewComponents(interaction.user.id),
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: "✅ Your paid ad was sent to staff. Staff will confirm payment and review it before posting.",
        ephemeral: true,
      });
    }

    if (interaction.isButton()) {
      if (interaction.customId === "giveaway_enter") {
        const messageId = interaction.message.id;
        const giveaway = giveawayStore.get(messageId);
        if (
          !interaction.guild ||
          !giveaway ||
          giveaway.guildId !== interaction.guild.id ||
          giveaway.channelId !== interaction.channelId ||
          giveaway.status !== "active"
        ) {
          await interaction.reply({
            content: "This giveaway is no longer active.",
            ephemeral: true,
          });
          return;
        }
        if (interaction.user.bot) {
          await interaction.reply({
            content: "Bots cannot enter giveaways.",
            ephemeral: true,
          });
          return;
        }
        if (giveawayLocks.has(messageId)) {
          await interaction.reply({
            content: "This giveaway is being updated. Please try again in a moment.",
            ephemeral: true,
          });
          return;
        }

        giveawayLocks.add(messageId);
        const previousEntrants = [...giveaway.entrantIds];
        const alreadyEntered = giveaway.entrantIds.includes(interaction.user.id);
        let messageUpdated = false;
        let stateChanged = false;
        try {
          await interaction.deferReply({ ephemeral: true });
          giveaway.entrantIds = alreadyEntered
            ? giveaway.entrantIds.filter(id => id !== interaction.user.id)
            : [...giveaway.entrantIds, interaction.user.id];
          stateChanged = true;
          await persistGiveaways();
          await interaction.message.edit({
            embeds: [buildGiveawayEmbed(giveaway)],
            components: buildGiveawayComponents(),
            allowedMentions: { parse: [] },
          });
          messageUpdated = true;
          await interaction.editReply(
            alreadyEntered
              ? "Your giveaway entry has been removed."
              : "🎉 You're entered in the giveaway!"
          );
        } catch (error) {
          if (stateChanged && !messageUpdated) {
            giveaway.entrantIds = previousEntrants;
            await persistGiveaways();
          }
          throw error;
        } finally {
          giveawayLocks.delete(messageId);
        }
        return;
      }

      if (interaction.customId === "partnership_apply") {
        await interaction.showModal(buildPartnershipModal());
      }

      if (interaction.customId === "paid_ad_apply") {
        await interaction.showModal(buildPaidAdModal());
      }

      if (
        interaction.customId.startsWith("partnership_approve:") ||
        interaction.customId.startsWith("partnership_reject:")
      ) {
        const guild = interaction.guild;
        if (!guild || !isStaff(interaction.member)) {
          await interaction.reply({
            content: "Only Vhila SMP staff can review partnership submissions.",
            ephemeral: true,
          });
          return;
        }

        const [action, applicantId] = interaction.customId.split(":");
        const reviewEmbed = interaction.message.embeds[0];
        if (
          !applicantId ||
          reviewEmbed?.title !== "Partnership Request — Pending Review" ||
          reviewEmbed.footer?.text !== `Applicant ID: ${applicantId}`
        ) {
          await interaction.reply({
            content: "This partnership request is invalid or has already been reviewed.",
            ephemeral: true,
          });
          return;
        }

        if (partnershipReviewLocks.has(interaction.message.id)) {
          await interaction.reply({
            content: "This partnership request is already being reviewed.",
            ephemeral: true,
          });
          return;
        }

        partnershipReviewLocks.add(interaction.message.id);
        await interaction.deferUpdate();
        try {
          const approved = action === "partnership_approve";
          let publishedIn = "";
          if (approved) {
            const publishChannel = partnershipPublishChannel(guild) || interaction.channel;
            const botMember = guild.members.me;
            if (
              !botMember ||
              !publishChannel.permissionsFor(botMember)?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
              ])
            ) {
              throw new Error("Create a `partnerships` (or `affiliates`) channel and allow the bot to post embeds there.");
            }

            if (publishChannel.id !== interaction.channelId) {
              const approvedEmbed = buildApprovedPartnershipEmbed(reviewEmbed.fields);
              await publishChannel.send({
                embeds: [approvedEmbed],
                allowedMentions: { parse: [] },
              });
              publishedIn = ` in ${publishChannel}`;
            }
          }

          const resolvedEmbed = EmbedBuilder.from(reviewEmbed)
            .setColor(approved ? COLORS.supporter : COLORS.owner)
            .setTitle(approved ? "Partnership Request — Approved" : "Partnership Request — Rejected")
            .setDescription(
              approved
                ? `Approved by ${interaction.user.username}${publishedIn}.`
                : `Rejected by ${interaction.user.username}.`
            )
            .setFooter({ text: `Reviewed by ${interaction.user.tag}` })
            .setTimestamp();
          await interaction.message.edit({
            embeds: [resolvedEmbed],
            components: [],
            allowedMentions: { parse: [] },
          });
          await interaction.followUp({
            content: approved
              ? `✅ Partnership ad approved and posted${publishedIn}.`
              : "Partnership request rejected.",
            ephemeral: true,
          });
        } finally {
          partnershipReviewLocks.delete(interaction.message.id);
        }
      }

      if (
        interaction.customId.startsWith("paid_ad_approve:") ||
        interaction.customId.startsWith("paid_ad_reject:")
      ) {
        const guild = interaction.guild;
        if (!guild || !isStaff(interaction.member)) {
          await interaction.reply({
            content: "Only Vhila SMP staff can review paid advertisements.",
            ephemeral: true,
          });
          return;
        }

        const [action, applicantId] = interaction.customId.split(":");
        const reviewEmbed = interaction.message.embeds[0];
        if (
          !applicantId ||
          reviewEmbed?.title !== "Paid Advertisement — Payment Pending" ||
          reviewEmbed.footer?.text !== `Applicant ID: ${applicantId}`
        ) {
          await interaction.reply({
            content: "This paid advertisement is invalid or has already been reviewed.",
            ephemeral: true,
          });
          return;
        }

        if (partnershipReviewLocks.has(interaction.message.id)) {
          await interaction.reply({
            content: "This advertisement is already being reviewed.",
            ephemeral: true,
          });
          return;
        }

        partnershipReviewLocks.add(interaction.message.id);
        await interaction.deferUpdate();
        try {
          const approved = action === "paid_ad_approve";
          let publishedIn = "";
          if (approved) {
            const publishChannel = paidAdPublishChannel(guild);
            const botMember = guild.members.me;
            if (
              !publishChannel ||
              !botMember ||
              !publishChannel.permissionsFor(botMember)?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
              ])
            ) {
              throw new Error("Create a `paid-ads` channel and allow the bot to post embeds there.");
            }

            await publishChannel.send({
              embeds: [buildPaidAdEmbed(reviewEmbed.fields)],
              allowedMentions: { parse: [] },
            });
            publishedIn = ` in ${publishChannel}`;
          }

          const resolvedEmbed = EmbedBuilder.from(reviewEmbed)
            .setColor(approved ? COLORS.supporter : COLORS.owner)
            .setTitle(approved ? "Paid Advertisement — Paid & Posted" : "Paid Advertisement — Rejected")
            .setDescription(
              approved
                ? `Payment confirmed and approved by ${interaction.user.username}${publishedIn}.`
                : `Rejected by ${interaction.user.username}.`
            )
            .setFooter({ text: `Reviewed by ${interaction.user.tag}` })
            .setTimestamp();
          await interaction.message.edit({
            embeds: [resolvedEmbed],
            components: [],
            allowedMentions: { parse: [] },
          });
          await interaction.followUp({
            content: approved
              ? `✅ Paid ad marked paid and posted${publishedIn}.`
              : "Paid advertisement rejected.",
            ephemeral: true,
          });
        } finally {
          partnershipReviewLocks.delete(interaction.message.id);
        }
      }

      if (interaction.customId === "verify_member") {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "Verification can only be used in a server.",
            ephemeral: true,
          });
          return;
        }

        const role = roleByName(guild, "✅ Verified");
        const botMember = guild.members.me;
        if (
          !role ||
          role.managed ||
          role.permissions.bitfield !== 0n ||
          !role.editable ||
          !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)
        ) {
          await interaction.reply({
            content: 'Verification is not available right now. Please ask staff to check the "✅ Verified" role and the bot role hierarchy.',
            ephemeral: true,
          });
          return;
        }

        const member = await guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(role.id)) {
          await interaction.reply({
            content: "✅ You are already verified.",
            ephemeral: true,
          });
          return;
        }

        await member.roles.add(role, "Member used the Vhila SMP Verify button");
        await interaction.reply({
          content: "✅ You are verified and can now access the community.",
          ephemeral: true,
        });
      }

      if (interaction.customId === "open_ticket") {
        await openTicket(interaction);
      }

      if (interaction.customId === "agree_staff_application") {
        const ownerId = interaction.channel?.topic?.match(
          /^Ticket type: apply-for-staff; Owner: (\d+)$/
        )?.[1];
        if (ownerId !== interaction.user.id) {
          await interaction.reply({
            content: "Only the applicant who opened this staff application can agree to it.",
            ephemeral: true,
          });
          return;
        }

        const agreedControls = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("Close Ticket")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("agree_staff_application")
            .setLabel("Agreed")
            .setStyle(ButtonStyle.Success)
            .setDisabled(true)
        );
        const agreementConfirmation = `✅ ${interaction.user.username} agreed to the Vhila SMP Staff Rules and guidelines.`;
        const messageContent = interaction.message.content || "";
        await interaction.update({
          content: `${messageContent}\n\n${agreementConfirmation}`,
          components: [agreedControls],
          allowedMentions: { parse: [] },
        });
      }

      if (interaction.customId === "close_ticket") {
        await closeTicket(interaction);
      }

    }
  } catch (error) {
    console.error("Interaction error:", error);

    const payload = {
      content: `❌ Something went wrong: ${error.message}`,
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(TOKEN);
