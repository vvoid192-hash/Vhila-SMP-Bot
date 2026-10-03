require("dotenv").config();

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const express = require("express");

const {
  TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  GUILD_ID,
  ERLC_SERVER_KEY,
  DASHBOARD_BASE_URL,
  DASHBOARD_SESSION_SECRET,
  DASHBOARD_STAFF_ROLE_IDS = "",
  PORT = "3000",
} = process.env;

const requiredEnvironment = {
  TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  GUILD_ID,
  DASHBOARD_BASE_URL,
  DASHBOARD_SESSION_SECRET,
};
const missingEnvironment = Object.entries(requiredEnvironment)
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missingEnvironment.length > 0) {
  console.error(`Missing dashboard environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}

const baseUrl = new URL(DASHBOARD_BASE_URL);
if (!["http:", "https:"].includes(baseUrl.protocol)) {
  throw new Error("DASHBOARD_BASE_URL must use HTTP or HTTPS.");
}
if (DASHBOARD_SESSION_SECRET.length < 32) {
  throw new Error("DASHBOARD_SESSION_SECRET must contain at least 32 characters.");
}
const parsedPort = Number(PORT);
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const OAUTH_CALLBACK_URL = new URL("/auth/callback", baseUrl).toString();
const COOKIE_NAME = "vhila_smp_dashboard_session";
const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const MODERATION_LOG_PATH = path.join(__dirname, "moderation-log.json");
const DEPARTMENT_CONFIG_PATH = path.join(__dirname, "departments.json");
const APPLICATIONS_PATH = path.join(__dirname, "applications.json");
const DISPATCH_LOG_PATH = path.join(__dirname, "dispatch-log.json");
const DASHBOARD_STAFF_NAMES = new Set([
  "owner", "xenon", "2 owner", "owner 3", "founder", "ownership", "manager",
  "staff supervisory", "lead management", "senior management", "management",
  "trial management", "management team", "lead internal affairs",
  "senior internal affairs", "internal affairs", "junior internal affairs",
  "trial internal affairs", "lead administrator", "senior administrator",
  "administrator", "junior administrator", "trail administrator",
  "trial administrator", "lead moderator", "senior moderator", "moderator",
  "junior moderator", "trial moderator", "staff trainee", "vhila smp staff team",
  "👑 founder", "🛡️ management", "⚙️ administrator", "🔨 senior staff",
  "🛡️ moderator",
]);
const configuredStaffRoleIds = new Set(
  DASHBOARD_STAFF_ROLE_IDS.split(",").map(roleId => roleId.trim()).filter(Boolean)
);
const PERMISSIONS = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  MODERATE_MEMBERS: 1n << 40n,
};
const ERLC_API_BASE_URL = "https://api.erlc.gg";
const ERLC_DATA_CACHE_MS = 15_000;
const ERLC_LOG_TYPES = [
  { key: "CommandLogs", label: "Command logs", dateField: "Timestamp", primaryField: "Player", detailField: "Command" },
  { key: "JoinLogs", label: "Join logs", dateField: "Timestamp", primaryField: "Player", detailField: "Join" },
  { key: "KillLogs", label: "Kill logs", dateField: "Timestamp", primaryField: "Killer", detailField: "Killed" },
  { key: "ModCalls", label: "Moderator calls", dateField: "Timestamp", primaryField: "Caller", detailField: "Moderator" },
];

const app = express();
const oauthStates = new Map();
const pendingActions = new Map();
let moderationLogUpdates = Promise.resolve();
let erlcDataCache = null;
let erlcDataExpiresAt = 0;
let erlcDataRequest = null;
let erlcRateLimitUntil = 0;

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.set({
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
});
app.use(express.urlencoded({ extended: false, limit: "8kb" }));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function sign(value) {
  return createHmac("sha256", DASHBOARD_SESSION_SECRET).update(value).digest();
}

function createSessionCookie(session) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = sign(payload).toString("base64url");
  return `${payload}.${signature}`;
}

function readSessionCookie(request) {
  const cookie = request.headers.cookie
    ?.split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!cookie) return null;

  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }

  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !session ||
    typeof session.id !== "string" ||
    typeof session.username !== "string" ||
    typeof session.csrf !== "string" ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= Date.now()
  ) {
    return null;
  }
  return session;
}

function setSessionCookie(response, session) {
  const options = [
    `${COOKIE_NAME}=${createSessionCookie(session)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (baseUrl.protocol === "https:") options.push("Secure");
  response.setHeader("Set-Cookie", options.join("; "));
}

function clearSessionCookie(response) {
  const options = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (baseUrl.protocol === "https:") options.push("Secure");
  response.setHeader("Set-Cookie", options.join("; "));
}

function verifyRequestOrigin(request) {
  const origin = request.get("origin");
  if (origin !== baseUrl.origin || request.get("host") !== baseUrl.host) {
    throw new Error("Request origin did not match the configured dashboard URL.");
  }
}

function verifyCsrf(request, session) {
  verifyRequestOrigin(request);
  const submittedToken = request.body.csrf;
  if (
    typeof submittedToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(submittedToken) ||
    !timingSafeEqual(Buffer.from(submittedToken), Buffer.from(session.csrf))
  ) {
    throw new Error("Your session expired. Refresh the page and try again.");
  }
}

async function discordApi(route, { reason, ...options } = {}) {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    ...options,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(reason
        ? { "X-Audit-Log-Reason": encodeURIComponent(reason) }
        : {}),
      ...options.headers,
    },
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const message = body?.message || `Discord returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

async function erlcApi(route, options = {}) {
  if (!ERLC_SERVER_KEY) {
    throw new Error("ER:LC is not connected yet. Add ERLC_SERVER_KEY to the private .env file.");
  }
  if (Date.now() < erlcRateLimitUntil) {
    const seconds = Math.ceil((erlcRateLimitUntil - Date.now()) / 1000);
    throw new Error(`ER:LC asked the dashboard to slow down. Try again in ${seconds} seconds.`);
  }

  const response = await fetch(`${ERLC_API_BASE_URL}${route}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: {
      "server-key": ERLC_SERVER_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }

  if (response.status === 429) {
    const retryAfter = Number(
      response.headers.get("retry-after") ||
      body?.retry_after ||
      5
    );
    const delayMs = Math.max(1, retryAfter) * 1000;
    erlcRateLimitUntil = Date.now() + delayMs;
    throw new Error(`ER:LC rate limit reached. Please retry after ${Math.ceil(delayMs / 1000)} seconds.`);
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("ER:LC rejected the server key. Check that it is current and belongs to your ER:LC private server.");
    }
    throw new Error(body?.message || `ER:LC returned HTTP ${response.status}.`);
  }
  return body;
}

async function getErlcServerData(forceRefresh = false) {
  if (!ERLC_SERVER_KEY) {
    throw new Error("ER:LC is not connected. Add your private server key as ERLC_SERVER_KEY in .env.");
  }
  if (!forceRefresh && erlcDataCache && Date.now() < erlcDataExpiresAt) {
    return erlcDataCache;
  }
  if (erlcDataRequest) return erlcDataRequest;

  const query = new URLSearchParams({
    Players: "true",
    Staff: "true",
    JoinLogs: "true",
    Queue: "true",
    KillLogs: "true",
    CommandLogs: "true",
    ModCalls: "true",
    EmergencyCalls: "true",
    Vehicles: "true",
  });
  erlcDataRequest = (async () => {
    const data = await erlcApi(`/v2/server?${query}`);
    erlcDataCache = data;
    erlcDataExpiresAt = Date.now() + ERLC_DATA_CACHE_MS;
    return data;
  })();
  try {
    return await erlcDataRequest;
  } finally {
    erlcDataRequest = null;
  }
}

function invalidateErlcServerData() {
  erlcDataExpiresAt = 0;
}

async function getGuildRoles() {
  return discordApi(`/guilds/${GUILD_ID}/roles`);
}

async function getGuildMember(userId) {
  return discordApi(`/guilds/${GUILD_ID}/members/${userId}`);
}

function memberRolePermissions(member, roles) {
  const roleById = new Map(roles.map(role => [role.id, role]));
  return member.roles.reduce((permissions, roleId) => {
    const role = roleById.get(roleId);
    return permissions | BigInt(role?.permissions || "0");
  }, 0n);
}

function hasPermission(permissions, required) {
  return (permissions & required) === required ||
    (permissions & PERMISSIONS.ADMINISTRATOR) !== 0n;
}

function isDashboardStaff(member, roles) {
  if (member.user?.id === member.guild?.owner_id) return true;
  const roleById = new Map(roles.map(role => [role.id, role]));
  const hasConfiguredStaffRole = member.roles.some(roleId => {
    const role = roleById.get(roleId);
    return configuredStaffRoleIds.has(roleId) ||
      DASHBOARD_STAFF_NAMES.has(role?.name?.toLowerCase() || "");
  });
  const permissions = memberRolePermissions(member, roles);
  return hasConfiguredStaffRole ||
    (permissions & (PERMISSIONS.MANAGE_GUILD | PERMISSIONS.ADMINISTRATOR)) !== 0n ||
    (permissions & PERMISSIONS.MODERATE_MEMBERS) !== 0n ||
    (permissions & PERMISSIONS.KICK_MEMBERS) !== 0n ||
    (permissions & PERMISSIONS.BAN_MEMBERS) !== 0n;
}

async function loadDashboardStaff(request, response, next) {
  const session = readSessionCookie(request);
  if (!session) {
    response.redirect("/");
    return;
  }
  try {
    const [member, roles, guild] = await Promise.all([
      getGuildMember(session.id),
      getGuildRoles(),
      discordApi(`/guilds/${GUILD_ID}`),
    ]);
    member.guild = { owner_id: undefined };
    const roleById = new Map(roles.map(role => [role.id, role]));
    member.guild.owner_id = guild.owner_id;
    if (!isDashboardStaff(member, roles)) {
      clearSessionCookie(response);
      response.status(403).send(renderPage({
        title: "Staff access required",
        body: `<section class="card"><h1>Staff access required</h1><p>Your Discord account is not assigned a Vhila SMP staff role.</p><a class="button secondary" href="/">Return</a></section>`,
      }));
      return;
    }
    const permissions = memberRolePermissions(member, roles);
    const isOwner = member.user?.id === guild.owner_id;
    request.dashboard = {
      session,
      member,
      roles,
      roleById,
      canWarn: true,
      canTimeout: isOwner ||
        (permissions & PERMISSIONS.MODERATE_MEMBERS) !== 0n ||
        (permissions & PERMISSIONS.ADMINISTRATOR) !== 0n,
      canKick: isOwner || hasPermission(permissions, PERMISSIONS.KICK_MEMBERS),
      canBan: isOwner || hasPermission(permissions, PERMISSIONS.BAN_MEMBERS),
      canManageErlc: isOwner ||
        (permissions & (PERMISSIONS.MANAGE_GUILD | PERMISSIONS.ADMINISTRATOR)) !== 0n,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function checkActionPermission(dashboard, action) {
  if (action === "warn" && dashboard.canWarn) return;
  if (action === "timeout" && dashboard.canTimeout) return;
  if (action === "kick" && dashboard.canKick) return;
  if (action === "ban" && dashboard.canBan) return;
  throw new Error("Your Discord roles do not have permission for that action.");
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readModerationLog() {
  let rawLog;
  try {
    rawLog = await readFile(MODERATION_LOG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = JSON.parse(rawLog);
  if (
    !Array.isArray(records) ||
    records.some(record =>
      !record ||
      typeof record.guildId !== "string" ||
      typeof record.action !== "string" ||
      typeof record.targetId !== "string" ||
      typeof record.moderatorId !== "string" ||
      typeof record.reason !== "string" ||
      !Number.isFinite(record.timestamp)
    )
  ) {
    throw new Error("moderation-log.json has an invalid format.");
  }
  return records;
}

async function readDepartments() {
  const fallback = [
    { id: "police", name: "Police Department", lead: "Operations Commander", channel: "police", roleList: "Police, Command, Investigations", status: "active", description: "Core public safety and enforcement operations." },
    { id: "fire-rescue", name: "Fire & Rescue", lead: "Fire Chief", channel: "fire-rescue", roleList: "Firefighter, Paramedic, Rescue", status: "active", description: "Emergency response and lifesaving services." },
    { id: "dot", name: "Department of Transportation", lead: "DOT Supervisor", channel: "dot", roleList: "Traffic Officer, Road Crew, Enforcement", status: "active", description: "Traffic management and roadway operations." },
    { id: "civilian-ops", name: "Civilian Operations", lead: "Operations Manager", channel: "civilian-ops", roleList: "Civilian Admin, Event Team, Support", status: "active", description: "Community operations, support, and non-emergency initiatives." },
  ];
  const records = await readJsonFile(DEPARTMENT_CONFIG_PATH, fallback);
  if (!Array.isArray(records) || records.length === 0) return fallback;
  return records.map((record, index) => ({
    id: String(record.id || `department-${index + 1}`),
    name: String(record.name || `Department ${index + 1}`),
    lead: String(record.lead || "To be assigned"),
    channel: String(record.channel || "department-chat"),
    roleList: String(record.roleList || "General access"),
    status: String(record.status || "active"),
    description: String(record.description || "Department operations overview."),
  }));
}

async function saveDepartments(departments) {
  await writeJsonFile(DEPARTMENT_CONFIG_PATH, departments);
}

async function readApplications() {
  const fallback = [];
  const records = await readJsonFile(APPLICATIONS_PATH, fallback);
  if (!Array.isArray(records)) return fallback;
  return records.map((record, index) => ({
    id: String(record.id || `application-${index + 1}`),
    name: String(record.name || "Applicant"),
    department: String(record.department || "General"),
    role: String(record.role || "General interest"),
    experience: String(record.experience || "Not provided"),
    details: String(record.details || "No application notes provided."),
    status: ["pending", "reviewing", "approved", "rejected"].includes(record.status) ? record.status : "pending",
    createdAt: Number(record.createdAt) || Date.now(),
    reviewedBy: String(record.reviewedBy || ""),
    reviewNote: String(record.reviewNote || ""),
  }));
}

async function saveApplications(applications) {
  await writeJsonFile(APPLICATIONS_PATH, applications);
}

async function readDispatchEntries() {
  const fallback = [
    { id: "dispatch-1", title: "Road closure update", unit: "DOT", priority: "medium", status: "monitoring", note: "Traffic flow is being redirected across the active stage area.", createdAt: Date.now() - 1000 * 60 * 12 },
    { id: "dispatch-2", title: "Medical response", unit: "Fire & Rescue", priority: "high", status: "pending", note: "Unit dispatched for emergency support in the market district.", createdAt: Date.now() - 1000 * 60 * 28 },
  ];
  const records = await readJsonFile(DISPATCH_LOG_PATH, fallback);
  if (!Array.isArray(records) || records.length === 0) return fallback;
  return records.map((record, index) => ({
    id: String(record.id || `dispatch-${index + 1}`),
    title: String(record.title || "New dispatch"),
    unit: String(record.unit || "Operations"),
    priority: String(record.priority || "medium"),
    status: String(record.status || "open"),
    note: String(record.note || "No notes recorded."),
    createdAt: Number(record.createdAt) || Date.now(),
  }));
}

async function saveDispatchEntries(entries) {
  await writeJsonFile(DISPATCH_LOG_PATH, entries);
}

async function appendModerationLog(record) {
  const operation = moderationLogUpdates.then(async () => {
    const records = await readModerationLog();
    records.unshift(record);
    const retainedRecords = records.slice(0, 5000);
    const temporaryPath = `${MODERATION_LOG_PATH}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(retainedRecords, null, 2)}\n`, "utf8");
    await rename(temporaryPath, MODERATION_LOG_PATH);
  });
  moderationLogUpdates = operation.catch(() => {});
  return operation;
}

async function readAuditEvents() {
  const response = await discordApi(`/guilds/${GUILD_ID}/audit-logs?limit=50`);
  const actionNames = {
    20: "Kick",
    22: "Ban added",
    23: "Ban removed",
    24: "Member updated",
    25: "Member roles updated",
  };
  return (response.audit_log_entries || [])
    .map(entry => ({
      action: actionNames[entry.action_type] || `Guild action ${entry.action_type}`,
      targetId: entry.target_id || "—",
      moderatorId: entry.user_id || "—",
      reason: entry.reason || "No reason provided",
      timestamp: Number((BigInt(entry.id) >> 22n) + 1_420_070_400_000n),
      source: "Discord audit log",
    }))
    .sort((first, second) => second.timestamp - first.timestamp);
}

function playerIdentity(player) {
  const value = typeof player === "string"
    ? player
    : String(player?.Player || player?.player || "");
  const splitAt = value.lastIndexOf(":");
  if (splitAt < 1) return { name: value || "Unknown player", id: "" };
  return {
    name: value.slice(0, splitAt),
    id: value.slice(splitAt + 1),
  };
}

function formatErlcTimestamp(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return formatTime(value < 10_000_000_000 ? value * 1000 : value);
}

function erlcLocation(player) {
  const location = player?.Location;
  if (!location || typeof location !== "object") return "—";
  const parts = [location.StreetName, location.BuildingNumber, location.PostalCode]
    .filter(value => typeof value === "string" && value.length > 0);
  return parts.length > 0
    ? parts.join(" · ")
    : [location.LocationX, location.LocationZ]
        .filter(Number.isFinite)
        .map(value => Math.round(value))
        .join(", ") || "—";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function erlcStaffRows(staff) {
  if (!isRecord(staff)) return [];
  const ranks = [
    ["Admins", "Administrator"],
    ["Mods", "Moderator"],
    ["Helpers", "Helper"],
  ];
  return ranks.flatMap(([key, label]) => {
    const entries = isRecord(staff[key]) ? Object.entries(staff[key]) : [];
    return entries.map(([id, name]) => ({
      id,
      name: String(name),
      rank: label,
    }));
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png?size=96`;
  }
  const defaultAvatar = Number(BigInt(user.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
}

function renderPage({
  title,
  body,
  user = null,
  csrf = "",
  landing = false,
  brandTitle = "VHILA SMP STAFF",
  brandSubtitle = "Moderation dashboard",
  footerText = "Vhila SMP · Staff activity may include actions made outside this dashboard when Discord audit-log access is available.",
}) {
  const avatar = user
    ? `<img class="avatar" src="${escapeHtml(avatarUrl(user))}" alt="">`
    : "";
  const header = user
    ? `<div class="user">${avatar}<span>${escapeHtml(user.global_name || user.username)}</span><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="link-button" type="submit">Sign out</button></form></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Vhila SMP Staff</title>
  <style>
    :root{color-scheme:dark;--bg:#101218;--panel:#191d27;--panel2:#202634;--line:#303746;--text:#f5f6fa;--muted:#a5aec0;--accent:#7289da;--danger:#ed4245;--green:#3ba55d}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0,#222b43 0,transparent 38%),var(--bg);color:var(--text);font:15px/1.5 Inter,Segoe UI,Arial,sans-serif}
    a{color:#aabaff;text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:1120px;margin:auto;padding:28px 20px 60px}
    header{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:28px}
    .brand{display:flex;gap:12px;align-items:center}.brand-icon{width:42px;height:42px;border-radius:14px;background:var(--accent);display:grid;place-items:center;font-size:21px}
    .brand strong{display:block;letter-spacing:.02em}.brand small,.muted{color:var(--muted)}.user{display:flex;align-items:center;gap:10px}.avatar{width:34px;height:34px;border-radius:50%}
    .link-button{border:0;background:transparent;color:#aabaff;cursor:pointer}.hero{padding:42px 0 30px;max-width:720px}.eyebrow{color:#aabaff;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:700}
    h1{font-size:clamp(32px,6vw,54px);line-height:1.08;margin:12px 0 16px}h2{font-size:19px;margin:0 0 18px}.hero p{color:var(--muted);font-size:17px;max-width:610px}
    .button,button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;padding:11px 16px;background:var(--accent);color:white;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none}
    .button:hover,button:hover{filter:brightness(1.1);text-decoration:none}.secondary{background:var(--panel2)}.danger{background:var(--danger)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
    .card,.stat{background:linear-gradient(145deg,var(--panel),#171a22);border:1px solid var(--line);border-radius:13px;padding:20px}.stat strong{font-size:26px;display:block}.stat span{color:var(--muted);font-size:13px}
    .columns{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:16px}.field{display:grid;gap:6px;margin-bottom:14px}label{font-weight:650;font-size:13px}
    input,select,textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:#11141b;color:var(--text);padding:11px;font:inherit}textarea{min-height:90px;resize:vertical}
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.action-form button{width:100%}.notice{border:1px solid #584333;background:#392b1d;color:#f4d4aa;border-radius:9px;padding:12px 14px;margin:14px 0}
    .error{border-color:#71383b;background:#351d20;color:#ffc1c4}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
    .tag{display:inline-block;border-radius:20px;padding:3px 8px;background:#2b3448;color:#c9d4ff;font-size:11px;white-space:nowrap}.empty{color:var(--muted);padding:16px 0}
    footer{color:var(--muted);font-size:12px;margin-top:26px}
    .landing-wrap{max-width:none;padding:22px clamp(20px,6vw,88px) 64px;background:radial-gradient(ellipse at 84% 13%,#273765 0,transparent 30%),radial-gradient(ellipse at 12% 42%,#1c273c 0,transparent 28%),var(--bg)}
    .landing-wrap>header{max-width:1320px;margin:0 auto 20px;padding-bottom:16px;border-color:#353c4b}
    .landing-wrap .brand-icon{background:linear-gradient(145deg,#8497ed,#5667b5);box-shadow:0 8px 25px #5865f255}
    .site-nav{display:flex;align-items:center;gap:25px}.site-nav a{color:#c5cada;font-size:13px;font-weight:600}.site-nav a:hover{color:white;text-decoration:none}
    .landing-content{max-width:1320px;margin:0 auto}.landing-hero{min-height:520px;display:grid;grid-template-columns:1.04fr .96fr;gap:56px;align-items:center;padding:44px 0 60px}
    .landing-hero h1{max-width:700px;font-size:clamp(42px,6vw,76px);letter-spacing:-.055em;line-height:1.01;margin:17px 0 22px}
    .landing-hero .hero-copy{max-width:600px;color:#b7bfd0;font-size:18px;line-height:1.7}
    .hero-actions{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:27px}.hero-actions .button{padding:14px 19px}
    .button.outline{background:transparent;border:1px solid #424b60}.trust-line{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin-top:25px}
    .trust-dots{display:flex;padding-left:3px}.trust-dots i{width:9px;height:9px;border-radius:50%;background:#68d9b0;border:2px solid var(--bg);margin-left:-3px}
    .dashboard-preview{position:relative;border:1px solid #3a4357;border-radius:19px;background:linear-gradient(145deg,#1a2030,#11151e);box-shadow:0 35px 95px #03050a88;overflow:hidden;transform:perspective(1200px) rotateY(-5deg) rotateX(2deg)}
    .preview-top{height:51px;border-bottom:1px solid #30384a;display:flex;align-items:center;justify-content:space-between;padding:0 17px;color:#cbd2e0;font-size:12px}
    .window-dots{display:flex;gap:5px}.window-dots i{width:7px;height:7px;border-radius:50%;background:#525c72}.preview-layout{display:grid;grid-template-columns:126px 1fr;min-height:310px}
    .preview-side{border-right:1px solid #30384a;padding:18px 12px}.preview-side span{display:block;color:#8e99ad;font-size:10px;padding:9px 8px}.preview-side .selected{background:#303b5c;color:#e5eaff;border-radius:7px}
    .preview-main{padding:20px}.preview-heading{font-size:16px;font-weight:700}.preview-sub{font-size:10px;color:#8e99ad;margin-top:4px}
    .preview-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:17px 0}.preview-stat{padding:11px;border:1px solid #30384a;border-radius:8px;background:#171c27}.preview-stat strong{display:block;font-size:17px}.preview-stat small{color:#8e99ad;font-size:9px}
    .preview-row{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:10px;padding:11px 9px;border-bottom:1px solid #29303f;font-size:10px}
    .preview-row small{display:block;color:#8e99ad;margin-top:3px}.preview-tag{border-radius:20px;background:#342d4c;color:#d5c4ff;padding:4px 7px;font-size:9px}
    .float-chip{position:absolute;right:-20px;bottom:24px;padding:12px 15px;background:#202a2e;border:1px solid #42665a;border-radius:11px;box-shadow:0 15px 35px #0007;font-size:11px;color:#bff5da}
    .section{padding:64px 0}.section-head{max-width:670px;margin-bottom:29px}.section-head h2{font-size:clamp(29px,4vw,43px);letter-spacing:-.035em;line-height:1.12;margin:10px 0 13px}.section-head p{color:var(--muted);font-size:15px}
    .product-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.product-card{min-height:215px;padding:23px;border:1px solid #30394b;border-radius:14px;background:linear-gradient(150deg,#1c2230,#171a23);transition:transform .18s,border-color .18s}
    .product-card:hover{transform:translateY(-3px);border-color:#586b9e}.product-icon{width:41px;height:41px;border:1px solid #3e4b68;border-radius:12px;background:#28334a;display:grid;place-items:center;font-size:19px;margin-bottom:19px}
    .product-card h3{font-size:16px;margin:0 0 9px}.product-card p{font-size:13px;color:var(--muted);line-height:1.65;margin:0}
    .banner{display:grid;grid-template-columns:1fr auto;align-items:center;gap:24px;padding:34px;border:1px solid #404c6b;border-radius:17px;background:linear-gradient(105deg,#222b43,#1a202b)}
    .banner h2{font-size:clamp(24px,3vw,35px);letter-spacing:-.03em;margin:0 0 9px}.banner p{color:#bbc4d6;margin:0}
    .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.step{padding:20px;border-top:1px solid #46516a}.step-number{color:#91a4ff;font-size:12px;font-weight:800;letter-spacing:.1em}.step h3{font-size:15px;margin:10px 0 6px}.step p{font-size:13px;color:var(--muted);margin:0}
    .landing-footer{max-width:1320px;margin:55px auto 0;border-top:1px solid #343a48;padding-top:22px;display:flex;justify-content:space-between;gap:18px;color:#919bad;font-size:12px}
    .landing-footer a{color:#c6cde0}.landing-wrap>footer{display:none}
    .app-nav{display:flex;align-items:center;gap:14px}.app-nav a{font-size:12px;font-weight:650;color:#b7bfd0}.app-nav a:hover{color:white;text-decoration:none}
    .app-nav .button{color:white;padding:9px 12px}.player-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}
    .player-card{background:#171c27;border:1px solid var(--line);border-radius:11px;padding:15px}.player-card strong{display:block;font-size:14px}.player-card small{color:var(--muted)}
    .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}.toolbar input{max-width:350px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}
    .module-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.module-card{display:flex;flex-direction:column;min-height:180px}.module-card .button{margin-top:auto;align-self:flex-start}
    .callout{border:1px solid #394660;background:#1b2434;border-radius:10px;padding:13px 15px;color:#cad4e7;margin:12px 0}
    @media(max-width:900px){.landing-hero{grid-template-columns:1fr;gap:38px;padding-top:35px}.dashboard-preview{max-width:680px;width:100%;margin:auto;transform:none}.product-grid{grid-template-columns:repeat(2,1fr)}.site-nav{gap:15px}}
    @media(max-width:900px){.player-grid,.module-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:620px){.landing-wrap{padding:16px 16px 44px}.landing-wrap>header{margin-bottom:8px}.site-nav a:not(.button){display:none}.landing-hero{min-height:0;padding:42px 0}.landing-hero h1{font-size:clamp(40px,13vw,60px)}.landing-hero .hero-copy{font-size:16px}.preview-layout{grid-template-columns:88px 1fr;min-height:280px}.preview-side{padding:13px 7px}.preview-main{padding:15px 10px}.preview-row{gap:5px;font-size:9px}.float-chip{right:4px;bottom:8px}.product-grid,.steps,.player-grid,.module-grid{grid-template-columns:1fr}.section{padding:44px 0}.banner{grid-template-columns:1fr;padding:24px}.landing-footer{flex-direction:column}.hero-actions .button{width:100%}.app-nav{gap:8px;flex-wrap:wrap;justify-content:flex-end}.app-nav a{font-size:11px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body><main class="wrap${landing ? " landing-wrap" : ""}">
  <header><div class="brand"><div class="brand-icon">🌴</div><div><strong>${escapeHtml(brandTitle)}</strong><small>${escapeHtml(brandSubtitle)}</small></div></div>${landing ? `<nav class="site-nav" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#tools">Tools</a><a href="#how-it-works">How it works</a>${user ? `<a class="button" href="/platform">Open platform</a>` : `<a class="button" href="/login">Staff sign in</a>`}</nav>` : user ? `<nav class="app-nav" aria-label="Staff navigation"><a href="/platform">Platform</a><a href="/platform/erlc">ER:LC</a><a href="/platform/cad">CAD</a><a href="/dashboard">Discord moderation</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="link-button" type="submit">Sign out</button></form></nav>` : header}</header>
  ${body}
  <footer>${escapeHtml(footerText)}</footer>
</main></body></html>`;
}

function renderLogin(request, response) {
  const session = readSessionCookie(request);
  if (session) {
    response.redirect("/platform");
    return;
  }
  const body = `<section class="hero"><div class="eyebrow">Vhila SMP</div><h1>Staff tools, all in one place.</h1><p>Review recent moderation activity and take authorized actions. Sign in with Discord to verify your Vhila SMP staff access.</p><a class="button" href="/auth/login">Continue with Discord</a></section><section class="card"><h2>Staff-only dashboard</h2><p class="muted">Access is checked against your current Discord server membership and staff roles. Moderation actions are recorded with their reason and staff member.</p></section>`;
  response.send(renderPage({ title: "Staff dashboard", body }));
}

function renderLanding(request, response) {
  const session = readSessionCookie(request);
  const ctaUrl = session ? "/platform" : "/login";
  const ctaLabel = session ? "Open Vhila SMP platform" : "Launch Vhila SMP platform";
  const body = `<div class="landing-content">
    <section class="landing-hero">
      <div>
        <div class="eyebrow">The Vhila SMP community platform</div>
        <h1>More time for roleplay. Less time chasing tools.</h1>
        <p class="hero-copy">A shared command center for Vhila SMP staff. Review activity, handle moderation, and keep your community tools close at hand.</p>
        <div class="hero-actions"><a class="button" href="${ctaUrl}">${ctaLabel} <span aria-hidden="true">&nbsp;→</span></a><a class="button outline" href="#platform">Explore the platform</a></div>
        <div class="trust-line"><span class="trust-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Discord-connected · Staff access checked · Built for Vhila SMP</span></div>
      </div>
      <div class="dashboard-preview" role="img" aria-label="Preview of the Vhila SMP staff dashboard with moderation activity and available staff tools">
        <div class="preview-top"><span>🌴 &nbsp; Vhila SMP Control</span><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
        <div class="preview-layout"><aside class="preview-side"><span class="selected">◈ Overview</span><span>♙ Moderation</span><span>◷ Activity</span><span>⚙ Settings</span></aside>
          <div class="preview-main"><div class="preview-heading">Moderation overview</div><div class="preview-sub">Your staff workspace at a glance</div>
            <div class="preview-stats"><div class="preview-stat"><strong>04</strong><small>ACTION TYPES</small></div><div class="preview-stat"><strong>24/7</strong><small>COMMUNITY</small></div><div class="preview-stat"><strong>Live</strong><small>DISCORD LINK</small></div></div>
            <div class="preview-row"><div>Member moderation<small>Reason recorded · Staff action</small></div><span class="preview-tag">TIMEOUT</span><span>↗</span></div>
            <div class="preview-row"><div>Server audit activity<small>Discord audit log · Recent</small></div><span class="preview-tag">ACTIVITY</span><span>↗</span></div>
            <div class="preview-row"><div>Staff access<small>Checked against server roles</small></div><span class="preview-tag">SECURE</span><span>✓</span></div>
          </div>
        </div><div class="float-chip">✓ &nbsp; Connected to your Discord server</div>
      </div>
    </section>

    <section class="section" id="platform"><div class="section-head"><div class="eyebrow">One platform, practical tools</div><h2>The work behind a great roleplay community—organized.</h2><p>Bring the tools your team already uses into one Vhila SMP-branded home. Start with moderation and activity, then keep your community workflows easy to find.</p></div>
      <div class="product-grid">
        <article class="product-card"><div class="product-icon">🚔</div><h3>ER:LC server control</h3><p>Connect your private server to view status, active players, in-game staff, queue, and recent server activity.</p></article>
        <article class="product-card"><div class="product-icon">🗺</div><h3>Live CAD roster</h3><p>See in-game teams, callsigns, server permissions, and player locations from your connected ER:LC server.</p></article>
        <article class="product-card"><div class="product-icon">📡</div><h3>In-game server tools</h3><p>Authorized Vhila SMP managers can confirm and send supported server announcements and moderation commands.</p></article>
        <article class="product-card"><div class="product-icon">🛡</div><h3>Discord moderation</h3><p>Issue a warning, timeout, kick, or ban with a required reason and confirmation. Actions respect Discord permissions and hierarchy.</p></article>
        <article class="product-card"><div class="product-icon">◷</div><h3>Staff activity</h3><p>Review recent Discord audit-log events alongside ER:LC command, join, kill, and moderator-call logs.</p></article>
        <article class="product-card"><div class="product-icon">✅</div><h3>Member onboarding</h3><p>Guide new arrivals to verification, welcome members, and give verified players the right way into your community.</p></article>
        <article class="product-card"><div class="product-icon">🏛</div><h3>Departments & applications</h3><p>Connect your server roster with department roleplay and use Vhila SMP’s existing Discord ticket and staff application flows.</p></article>
        <article class="product-card"><div class="product-icon">🎉</div><h3>Community events</h3><p>Run button-entry giveaways with scheduled winners, rerolls, and saved entries that survive bot restarts.</p></article>
      </div>
    </section>

    <section class="section" id="tools"><div class="banner"><div><div class="eyebrow">Made for your team</div><h2>Less tab switching. Clearer staff workflows.</h2><p>Sign in with Discord, check your tools, and get back to building Vhila SMP.</p></div><a class="button" href="${ctaUrl}">${ctaLabel} &nbsp; →</a></div></section>

    <section class="section" id="how-it-works"><div class="section-head"><div class="eyebrow">Simple by design</div><h2>Connect your team in three steps.</h2></div>
      <div class="steps"><article class="step"><div class="step-number">01 / CONNECT</div><h3>Sign in with Discord</h3><p>Use the Discord account you use in the Vhila SMP server. The dashboard checks your current membership and staff access.</p></article>
      <article class="step"><div class="step-number">02 / CONNECT</div><h3>Link your ER:LC private server</h3><p>Add the ER:LC API server key privately on your server, then review live server and CAD information.</p></article>
      <article class="step"><div class="step-number">03 / GET BACK TO ROLEPLAY</div><h3>Keep the community moving</h3><p>Use one connected toolkit for moderation, member support, verification, and giveaways.</p></article></div>
    </section>
    <div class="landing-footer"><span>© Vhila SMP · Vhila SMP Control</span><a href="/login">Staff sign in</a></div>
  </div>`;
  response.send(renderPage({
    title: "Vhila SMP Control",
    body,
    landing: true,
    brandTitle: "VHILA SMP",
    brandSubtitle: "Community command center",
    user: session,
    csrf: session?.csrf || "",
    footerText: "",
  }));
}

app.get("/", renderLanding);
app.get("/login", renderLogin);

app.get("/auth/login", (request, response) => {
  const state = randomBytes(32).toString("hex");
  for (const [key, expiresAt] of oauthStates) {
    if (expiresAt <= Date.now()) oauthStates.delete(key);
  }
  while (oauthStates.size >= 1000) {
    oauthStates.delete(oauthStates.keys().next().value);
  }
  oauthStates.set(state, Date.now() + 10 * 60_000);
  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", OAUTH_CALLBACK_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("state", state);
  response.redirect(authorizeUrl.toString());
});

app.get("/auth/callback", async (request, response, next) => {
  const { code, state, error: oauthError } = request.query;
  if (oauthError) {
    response.status(401).send(renderPage({
      title: "Discord sign-in cancelled",
      body: `<section class="card"><h1>Sign-in cancelled</h1><p>Discord sign-in was cancelled. You can return and try again.</p><a class="button secondary" href="/">Return</a></section>`,
    }));
    return;
  }
  const stateExpiresAt = typeof state === "string" ? oauthStates.get(state) : undefined;
  if (
    typeof code !== "string" ||
    typeof state !== "string" ||
    !stateExpiresAt ||
    stateExpiresAt <= Date.now()
  ) {
    response.status(400).send(renderPage({
      title: "Invalid sign-in",
      body: `<section class="card"><h1>Sign-in expired</h1><p>Start sign-in again to continue.</p><a class="button secondary" href="/">Return</a></section>`,
    }));
    return;
  }
  oauthStates.delete(state);

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: OAUTH_CALLBACK_URL,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
      throw new Error(tokenData.error_description || "Discord could not complete sign-in.");
    }

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userResponse.json();
    if (!userResponse.ok || typeof user.id !== "string") {
      throw new Error(user.message || "Discord could not identify your account.");
    }

    const session = {
      id: user.id,
      username: user.username,
      global_name: user.global_name || null,
      avatar: user.avatar || null,
      csrf: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + COOKIE_MAX_AGE_SECONDS * 1000,
    };
    setSessionCookie(response, session);
    response.redirect("/platform");
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard", loadDashboardStaff, async (request, response, next) => {
  try {
    const [localLog, roles] = await Promise.all([
      readModerationLog(),
      Promise.resolve(request.dashboard.roles),
    ]);
    const userLog = localLog.filter(record => record.guildId === GUILD_ID);
    let auditEvents = [];
    let auditError = "";
    let auditLogAvailable = true;
    try {
      auditEvents = await readAuditEvents();
    } catch (error) {
      auditLogAvailable = false;
      auditError = "Discord audit activity is unavailable. Give the bot View Audit Log permission to include server-wide events.";
      console.error(`Audit log fetch failed: ${error.message}`);
    }
    const auditEntries = auditEvents.map(event => ({
      ...event,
      source: "Discord audit log",
    }));
    const dashboardEntries = userLog
      .filter(record => !auditLogAvailable || record.action === "warn")
      .map(record => ({
        ...record,
        source: record.action === "warn" ? "Dashboard warning" : "Dashboard",
      }));
    const recentEvents = [...dashboardEntries, ...auditEntries]
      .sort((first, second) => second.timestamp - first.timestamp)
      .slice(0, 50);
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentLocal = userLog.filter(record => record.timestamp >= monthAgo);
    const actionCount = recentLocal.length;
    const staffCount = new Set(recentLocal.map(record => record.moderatorId)).size;
    const openActions = [
      ["warn", "Warn", true],
      ["timeout", "Timeout", request.dashboard.canTimeout],
      ["kick", "Kick", request.dashboard.canKick],
      ["ban", "Ban", request.dashboard.canBan],
    ];
    const actionOptions = openActions.map(([value, label, enabled]) =>
      `<option value="${value}"${enabled ? "" : " disabled"}>${label}${enabled ? "" : " (requires Discord permission)"}</option>`
    ).join("");
    const rows = recentEvents.length > 0
      ? recentEvents.map(event => `<tr><td>${escapeHtml(formatTime(event.timestamp))}</td><td><span class="tag">${escapeHtml(event.action)}</span></td><td>${escapeHtml(event.targetId)}</td><td>${escapeHtml(event.moderatorId)}</td><td>${escapeHtml(event.reason)}</td><td><span class="muted">${escapeHtml(event.source || "Dashboard")}</span></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">No moderation activity recorded yet.</td></tr>`;
    const errorNotice = request.query.error === "1"
      ? `<div class="notice error">${escapeHtml(request.query.message || "The action could not be completed.")}</div>`
      : "";
    const warningNotice = request.query.warning === "undelivered"
      ? `<div class="notice">The warning was recorded, but Discord could not deliver the direct message. Check the bot's permissions and the member's DM settings.</div>`
      : "";
    const body = `${errorNotice}${warningNotice}${auditError ? `<div class="notice">${escapeHtml(auditError)}</div>` : ""}
      <section><div class="eyebrow">Staff workspace</div><h1>Moderation overview</h1><p class="muted">Actions are permission-checked against your Discord roles and recorded with your reason.</p></section>
      <section class="grid"><div class="stat"><strong>${actionCount}</strong><span>Dashboard actions · last 30 days</span></div><div class="stat"><strong>${staffCount}</strong><span>Staff active · last 30 days</span></div><div class="stat"><strong>${recentEvents.length}</strong><span>Recent events displayed</span></div><div class="stat"><strong>${escapeHtml(roles.length)}</strong><span>Server roles</span></div></section>
      <section class="columns"><div class="card"><h2>Take a moderation action</h2><form class="action-form" method="post" action="/moderate">
        <input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}">
        <div class="field"><label for="target">Member Discord user ID</label><input id="target" name="targetId" inputmode="numeric" pattern="[0-9]{17,20}" minlength="17" maxlength="20" placeholder="123456789012345678" required></div>
        <div class="form-row"><div class="field"><label for="action">Action</label><select id="action" name="action">${actionOptions}</select></div><div class="field"><label for="minutes">Timeout length (minutes)</label><input id="minutes" name="minutes" type="number" min="1" max="40320" value="10"></div></div>
        <div class="field"><label for="reason">Reason</label><textarea id="reason" name="reason" maxlength="500" placeholder="Explain the reason for this action" required></textarea></div>
        <button type="submit">Review and apply action</button>
      </form><p class="muted">Timeouts can be up to 28 days. Discord role hierarchy still applies.</p></div>
      <aside class="card"><h2>Your permissions</h2><p>${request.dashboard.canWarn ? "✅" : "—"} Warn</p><p>${request.dashboard.canTimeout ? "✅" : "🔒"} Timeout</p><p>${request.dashboard.canKick ? "✅" : "🔒"} Kick</p><p>${request.dashboard.canBan ? "✅" : "🔒"} Ban</p><p class="muted">Permissions follow your current Discord staff roles. Higher-impact actions require their matching Discord permission.</p></aside></section>
      <section class="card" style="margin-top:16px"><h2>Recent staff activity</h2><div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Action</th><th>Target ID</th><th>Staff ID</th><th>Reason</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    response.send(renderPage({
      title: "Moderation overview",
      body,
      user: request.dashboard.session,
      csrf: request.dashboard.session.csrf,
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/platform", loadDashboardStaff, async (request, response, next) => {
  let server = null;
  let serverError = "";
  if (ERLC_SERVER_KEY) {
    try {
      server = await getErlcServerData();
    } catch (error) {
      serverError = error.message;
    }
  } else {
    serverError = "Add your ER:LC private server key as ERLC_SERVER_KEY in .env to connect live data.";
  }

  const serverCard = server
    ? `<article class="card module-card"><div class="product-icon">🚔</div><h2>${escapeHtml(server.Name || "ER:LC server")}</h2><p class="muted">${escapeHtml(server.CurrentPlayers ?? 0)} / ${escapeHtml(server.MaxPlayers ?? "—")} players · ${server.CurrentPlayers > 0 ? "Online" : "No players currently online"}</p><a class="button secondary" href="/platform/erlc">Open ER:LC control room</a></article>`
    : `<article class="card module-card"><div class="product-icon">🚔</div><h2>ER:LC server</h2><p class="muted">${escapeHtml(serverError)}</p><a class="button secondary" href="/platform/erlc">Set up ER:LC connection</a></article>`;
  const body = `<section><div class="eyebrow">Vhila SMP Control · ER:LC platform</div><h1>Welcome to your server workspace</h1><p class="muted">Connect your ER:LC private server and bring live operations, CAD views, and staff tools into one place.</p></section>
    <section class="module-grid" style="margin-top:24px">
      ${serverCard}
      <article class="card module-card"><div class="product-icon">🗺</div><h2>Live CAD & roster</h2><p class="muted">See who is in-game, departments, callsigns, permissions, and current locations from your live ER:LC server.</p><a class="button secondary" href="/platform/cad">Open live CAD</a></article>
      <article class="card module-card"><div class="product-icon">🛡</div><h2>Discord moderation</h2><p class="muted">Review Discord staff activity and use role-authorized warn, timeout, kick, and ban actions.</p><a class="button secondary" href="/dashboard">Open moderation</a></article>
      <article class="card module-card"><div class="product-icon">🏛</div><h2>Departments</h2><p class="muted">Manage roleplay units, assigned leads, and departmental status for your community operations.</p><a class="button secondary" href="/platform/departments">View department board</a></article>
      <article class="card module-card"><div class="product-icon">📋</div><h2>Applications & onboarding</h2><p class="muted">Review member applications, department interest, and onboarding progress with a staff-first workflow.</p><a class="button secondary" href="/platform/applications">Open application inbox</a></article>
      <article class="card module-card"><div class="product-icon">🚑</div><h2>Dispatch & incidents</h2><p class="muted">Track active dispatch notes, unit updates, and callouts alongside ER:LC activity logs.</p><a class="button secondary" href="/platform/dispatch">Open dispatch board</a></article>
      <article class="card module-card"><div class="product-icon">📈</div><h2>Staff activity</h2><p class="muted">Compare server command, join, kill, and moderator-call logs with Discord moderation events.</p><a class="button secondary" href="/platform/erlc#server-activity">View activity</a></article>
    </section>`;
  response.send(renderPage({
    title: "Vhila SMP platform",
    body,
    brandTitle: "Vhila SMP CONTROL",
    brandSubtitle: "ER:LC community platform",
    user: request.dashboard.session,
    csrf: request.dashboard.session.csrf,
    footerText: "Vhila SMP Control · ER:LC private server workspace",
  }));
});

app.get("/platform/departments", loadDashboardStaff, async (request, response) => {
  const departments = await readDepartments();
  const rows = departments.map(department => `
    <tr>
      <td><strong>${escapeHtml(department.name)}</strong><br><span class="muted">${escapeHtml(department.description)}</span></td>
      <td>${escapeHtml(department.lead)}</td>
      <td>${escapeHtml(department.channel)}</td>
      <td><span class="tag">${escapeHtml(department.status)}</span></td>
      <td>${escapeHtml(department.roleList)}</td>
    </tr>
  `).join("");
  const notice = request.query.notice === "saved"
    ? `<div class="notice">Department board updated.</div>`
    : "";
  const body = `${notice}<section><div class="eyebrow">Vhila SMP Control · department board</div><h1>Department management</h1><p class="muted">Track lead assignments, status, and roleplay responsibilities across the Vhila Vhila SMP organization.</p><div class="toolbar"><a class="button secondary" href="/platform">← Platform</a></div></section>
    <section class="columns" style="margin-top:18px">
      <div class="card">
        <h2>Department roster</h2>
        <div class="table-wrap"><table><thead><tr><th>Department</th><th>Lead</th><th>Channel</th><th>Status</th><th>Roles</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="card">
        <h2>Update department</h2>
        <form method="post" action="/platform/departments">
          <input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}">
          <div class="field"><label for="departmentId">Department ID</label><select id="departmentId" name="departmentId"><option value="">Create new department</option>${departments.map(department => `<option value="${escapeHtml(department.id)}">${escapeHtml(department.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="departmentName">Department name</label><input id="departmentName" name="name" maxlength="60" placeholder="Police Department" required></div>
          <div class="field"><label for="departmentLead">Department lead</label><input id="departmentLead" name="lead" maxlength="50" placeholder="Operations Commander"></div>
          <div class="field"><label for="departmentChannel">Channel reference</label><input id="departmentChannel" name="channel" maxlength="50" placeholder="police"></div>
          <div class="field"><label for="departmentRoleList">Roles / assignments</label><input id="departmentRoleList" name="roleList" maxlength="120" placeholder="Police, Command, Investigations"></div>
          <div class="field"><label for="departmentStatus">Status</label><select id="departmentStatus" name="status"><option value="active">active</option><option value="training">training</option><option value="paused">paused</option><option value="inactive">inactive</option></select></div>
          <div class="field"><label for="departmentDescription">Description</label><textarea id="departmentDescription" name="description" maxlength="220" placeholder="Describe the department focus and responsibilities."></textarea></div>
          <button type="submit">Save department</button>
        </form>
      </div>
    </section>`;
  response.send(renderPage({
    title: "Department management",
    body,
    user: request.dashboard.session,
    csrf: request.dashboard.session.csrf,
    brandTitle: "Vhila SMP CONTROL",
    brandSubtitle: "Department board",
  }));
});

app.post("/platform/departments", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const submittedId = typeof request.body.departmentId === "string" ? request.body.departmentId.trim() : "";
    const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
    const lead = typeof request.body.lead === "string" ? request.body.lead.trim() : "To be assigned";
    const channel = typeof request.body.channel === "string" ? request.body.channel.trim() : "department-chat";
    const roleList = typeof request.body.roleList === "string" ? request.body.roleList.trim() : "General access";
    const status = typeof request.body.status === "string" ? request.body.status : "active";
    const description = typeof request.body.description === "string" ? request.body.description.trim() : "Department operations overview.";
    if (!name) throw new Error("Department name is required.");
    const departments = await readDepartments();
    const departmentIndex = submittedId ? departments.findIndex(department => department.id === submittedId) : -1;
    const nextDepartment = { id: submittedId || `department-${Date.now()}`, name, lead, channel, roleList, status, description };
    if (departmentIndex >= 0) {
      departments[departmentIndex] = nextDepartment;
    } else {
      departments.unshift(nextDepartment);
    }
    await saveDepartments(departments);
    response.redirect("/platform/departments?notice=saved");
  } catch (error) {
    next(error);
  }
});

app.get("/platform/applications", loadDashboardStaff, async (request, response) => {
  const applications = await readApplications();
  const stats = {
    pending: applications.filter(app => app.status === "pending").length,
    reviewing: applications.filter(app => app.status === "reviewing").length,
    approved: applications.filter(app => app.status === "approved").length,
    rejected: applications.filter(app => app.status === "rejected").length,
  };
  const rows = applications.length
    ? applications.map(application => `
      <tr>
        <td><strong>${escapeHtml(application.name)}</strong><br><span class="muted">${escapeHtml(application.department)}</span></td>
        <td>${escapeHtml(application.role)}</td>
        <td>${escapeHtml(application.experience)}</td>
        <td>${escapeHtml(application.status)}</td>
        <td>${escapeHtml(application.details.slice(0, 120) || "No details")}${application.details.length > 120 ? "…" : ""}</td>
        <td><form method="post" action="/platform/applications/update"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><input type="hidden" name="applicationId" value="${escapeHtml(application.id)}"><select name="status"><option value="pending"${application.status === "pending" ? " selected" : ""}>pending</option><option value="reviewing"${application.status === "reviewing" ? " selected" : ""}>reviewing</option><option value="approved"${application.status === "approved" ? " selected" : ""}>approved</option><option value="rejected"${application.status === "rejected" ? " selected" : ""}>rejected</option></select><button type="submit" style="margin-top:8px">Update</button></form></td>
      </tr>
    `).join("")
    : `<tr><td colspan="6" class="empty">No applications have been submitted yet.</td></tr>`;
  const body = `<section><div class="eyebrow">Vhila SMP Control · applications</div><h1>Application inbox</h1><p class="muted">Review department and staff interest applications, track statuses, and keep onboarding moving without leaving the dashboard.</p><div class="toolbar"><a class="button secondary" href="/platform">← Platform</a></div></section>
    <section class="grid" style="margin-top:18px"><div class="stat"><strong>${stats.pending}</strong><span>Pending</span></div><div class="stat"><strong>${stats.reviewing}</strong><span>Reviewing</span></div><div class="stat"><strong>${stats.approved}</strong><span>Approved</span></div><div class="stat"><strong>${stats.rejected}</strong><span>Rejected</span></div></section>
    <section class="columns" style="margin-top:18px">
      <div class="card"><h2>Submit new application</h2><form method="post" action="/platform/applications"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><div class="field"><label for="applicantName">Applicant name</label><input id="applicantName" name="name" maxlength="60" required></div><div class="form-row"><div class="field"><label for="applicantDepartment">Department</label><select id="applicantDepartment" name="department"><option value="Police">Police</option><option value="Fire & Rescue">Fire & Rescue</option><option value="DOT">DOT</option><option value="Civilian Operations">Civilian Operations</option><option value="Staff">Staff</option></select></div><div class="field"><label for="applicantRole">Desired role</label><input id="applicantRole" name="role" maxlength="50" placeholder="Officer, Admin, Event lead"></div></div><div class="field"><label for="applicantExperience">Experience / background</label><textarea id="applicantExperience" name="experience" maxlength="500" placeholder="Share relevant experience or what makes you a fit." required></textarea></div><div class="field"><label for="applicantDetails">Additional details</label><textarea id="applicantDetails" name="details" maxlength="1000" placeholder="Tell the team about your goals, availability, and preferred departments."></textarea></div><button type="submit">Submit application</button></form></div>
      <div class="card"><h2>Active applications</h2><div class="table-wrap"><table><thead><tr><th>Applicant</th><th>Role</th><th>Experience</th><th>Status</th><th>Notes</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    </section>`;
  response.send(renderPage({ title: "Applications", body, user: request.dashboard.session, csrf: request.dashboard.session.csrf, brandTitle: "Vhila SMP CONTROL", brandSubtitle: "Application inbox" }));
});

app.post("/platform/applications", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
    const department = typeof request.body.department === "string" ? request.body.department.trim() : "General";
    const role = typeof request.body.role === "string" ? request.body.role.trim() : "General interest";
    const experience = typeof request.body.experience === "string" ? request.body.experience.trim() : "";
    const details = typeof request.body.details === "string" ? request.body.details.trim() : "";
    if (!name || !experience) throw new Error("Applicant name and experience are required.");
    const applications = await readApplications();
    applications.unshift({
      id: `application-${Date.now()}`,
      name,
      department,
      role,
      experience,
      details,
      status: "pending",
      createdAt: Date.now(),
      reviewedBy: "",
      reviewNote: "",
    });
    await saveApplications(applications);
    response.redirect("/platform/applications");
  } catch (error) {
    next(error);
  }
});

app.post("/platform/applications/update", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const applicationId = typeof request.body.applicationId === "string" ? request.body.applicationId.trim() : "";
    const status = typeof request.body.status === "string" ? request.body.status : "pending";
    if (!applicationId) throw new Error("Choose an application to update.");
    const applications = await readApplications();
    const targetIndex = applications.findIndex(application => application.id === applicationId);
    if (targetIndex === -1) throw new Error("Application could not be found.");
    applications[targetIndex].status = ["pending", "reviewing", "approved", "rejected"].includes(status) ? status : "pending";
    applications[targetIndex].reviewedBy = request.dashboard.session.id;
    await saveApplications(applications);
    response.redirect("/platform/applications");
  } catch (error) {
    next(error);
  }
});

app.get("/platform/dispatch", loadDashboardStaff, async (request, response) => {
  const [server, dispatchEntries] = await Promise.all([
    (async () => {
      try {
        return await getErlcServerData(request.query.refresh === "1");
      } catch (error) {
        return null;
      }
    })(),
    readDispatchEntries(),
  ]);
  const recentLogs = Array.isArray(server?.CommandLogs)
    ? server.CommandLogs.slice(0, 6).map(entry => `<li><strong>${escapeHtml(entry.Player || "Unknown player")}</strong> — ${escapeHtml(entry.Command || "server command")} <span class="muted">${escapeHtml(formatErlcTimestamp(entry.Timestamp))}</span></li>`).join("")
    : `<li class="empty">No live ER:LC command log entries were returned. Add your server key to enable live dispatch feeds.</li>`;
  const dispatchRows = dispatchEntries.map(entry => `
    <tr>
      <td><strong>${escapeHtml(entry.title)}</strong><br><span class="muted">${escapeHtml(entry.note)}</span></td>
      <td>${escapeHtml(entry.unit)}</td>
      <td><span class="tag">${escapeHtml(entry.priority)}</span></td>
      <td><span class="tag">${escapeHtml(entry.status)}</span></td>
      <td>${escapeHtml(formatTime(entry.createdAt))}</td>
    </tr>
  `).join("");
  const body = `<section><div class="eyebrow">Vhila SMP Control · dispatch board</div><h1>Dispatch & incident tracking</h1><p class="muted">Review active calls, staff notes, and live ER:LC activity alongside your dispatch logs.</p><div class="toolbar"><a class="button secondary" href="/platform">← Platform</a><a class="button secondary" href="/platform/dispatch?refresh=1">Refresh activity</a></div></section>
    <section class="grid" style="margin-top:18px"><div class="stat"><strong>${dispatchEntries.length}</strong><span>Active notes</span></div><div class="stat"><strong>${dispatchEntries.filter(entry => entry.status === "pending").length}</strong><span>Pending</span></div><div class="stat"><strong>${server ? (server.CurrentPlayers ?? 0) : 0}</strong><span>Online players</span></div><div class="stat"><strong>${Array.isArray(server?.Queue) ? server.Queue.length : 0}</strong><span>Queue</span></div></section>
    <section class="columns" style="margin-top:18px">
      <div class="card"><h2>Add dispatch note</h2><form method="post" action="/platform/dispatch"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><div class="field"><label for="dispatchTitle">Title</label><input id="dispatchTitle" name="title" maxlength="80" required></div><div class="form-row"><div class="field"><label for="dispatchUnit">Unit</label><input id="dispatchUnit" name="unit" maxlength="40" placeholder="Police / Fire / DOT" required></div><div class="field"><label for="dispatchPriority">Priority</label><select id="dispatchPriority" name="priority"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option></select></div></div><div class="field"><label for="dispatchStatus">Status</label><select id="dispatchStatus" name="status"><option value="pending">pending</option><option value="monitoring">monitoring</option><option value="resolved">resolved</option></select></div><div class="field"><label for="dispatchNote">Dispatch details</label><textarea id="dispatchNote" name="note" maxlength="600" placeholder="Describe the call, route, or incident status." required></textarea></div><button type="submit">Add dispatch note</button></form></div>
      <div class="card"><h2>Recent ER:LC command feed</h2><ul>${recentLogs}</ul></div>
    </section>
    <section class="card" style="margin-top:18px"><h2>Dispatch log</h2><div class="table-wrap"><table><thead><tr><th>Call</th><th>Unit</th><th>Priority</th><th>Status</th><th>Created</th></tr></thead><tbody>${dispatchRows}</tbody></table></div></section>`;
  response.send(renderPage({ title: "Dispatch board", body, user: request.dashboard.session, csrf: request.dashboard.session.csrf, brandTitle: "Vhila SMP CONTROL", brandSubtitle: "Dispatch board" }));
});

app.post("/platform/dispatch", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const title = typeof request.body.title === "string" ? request.body.title.trim() : "";
    const unit = typeof request.body.unit === "string" ? request.body.unit.trim() : "Operations";
    const priority = typeof request.body.priority === "string" ? request.body.priority : "medium";
    const status = typeof request.body.status === "string" ? request.body.status : "pending";
    const note = typeof request.body.note === "string" ? request.body.note.trim() : "";
    if (!title || !note) throw new Error("Dispatch title and details are required.");
    const entries = await readDispatchEntries();
    entries.unshift({
      id: `dispatch-${Date.now()}`,
      title,
      unit,
      priority,
      status,
      note,
      createdAt: Date.now(),
    });
    await saveDispatchEntries(entries.slice(0, 50));
    response.redirect("/platform/dispatch");
  } catch (error) {
    next(error);
  }
});

app.get("/platform/erlc", loadDashboardStaff, async (request, response) => {
  const query = typeof request.query.q === "string"
    ? request.query.q.trim().slice(0, 80)
    : "";
  let server = null;
  let errorMessage = "";
  try {
    server = await getErlcServerData(request.query.refresh === "1");
  } catch (error) {
    errorMessage = error.message;
  }

  const players = Array.isArray(server?.Players) ? server.Players : [];
  const queue = Array.isArray(server?.Queue) ? server.Queue : [];
  const allStaff = erlcStaffRows(server?.Staff);
  const matchingPlayers = players.filter(player => {
    const identity = playerIdentity(player);
    const haystack = [
      identity.name,
      identity.id,
      player?.Team,
      player?.Callsign,
      player?.Permission,
    ].join(" ").toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
  const playerCards = matchingPlayers.length
    ? matchingPlayers.map(player => {
        const identity = playerIdentity(player);
        return `<article class="player-card"><strong>${escapeHtml(identity.name)}</strong><small>${escapeHtml(player.Team || "No team")}${player.Callsign ? ` · ${escapeHtml(player.Callsign)}` : ""}</small><small style="display:block;margin-top:7px">${escapeHtml(player.Permission || "Normal player")}</small></article>`;
      }).join("")
    : `<p class="empty">${players.length ? "No players match that search." : "No players are currently online."}</p>`;

  const logs = ERLC_LOG_TYPES.flatMap(type =>
    Array.isArray(server?.[type.key])
      ? server[type.key].map(entry => ({
          kind: type.label,
          time: entry.Timestamp,
          person: entry[type.primaryField],
          detail: entry[type.detailField],
        }))
      : []
  ).sort((first, second) => Number(second.time || 0) - Number(first.time || 0)).slice(0, 40);
  const logRows = logs.length
    ? logs.map(entry => `<tr><td>${escapeHtml(formatErlcTimestamp(entry.time))}</td><td><span class="tag">${escapeHtml(entry.kind)}</span></td><td>${escapeHtml(entry.person || "—")}</td><td>${escapeHtml(typeof entry.detail === "boolean" ? entry.detail ? "Joined" : "Left" : entry.detail || "—")}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No ER:LC activity was returned.</td></tr>`;
  const staffRows = allStaff.length
    ? allStaff.map(entry => `<tr><td>${escapeHtml(entry.name)}</td><td><span class="tag">${escapeHtml(entry.rank)}</span></td><td>${escapeHtml(entry.id)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">The server API did not return a staff roster.</td></tr>`;
  const errorNotice = errorMessage
    ? `<div class="notice error">${escapeHtml(errorMessage)} ${ERLC_SERVER_KEY ? "Verify the key and API access, then refresh." : "Configure the key in .env and restart the dashboard."}</div>`
    : "";
  const commandNotice = request.query.notice === "command-sent"
    ? `<div class="notice">ER:LC command sent successfully. Check the in-game response and server activity logs.</div>`
    : "";
  const requestError = request.query.error === "1"
    ? `<div class="notice error">${escapeHtml(request.query.message || "The ER:LC request could not be completed.")}</div>`
    : "";
  const commandPanel = request.dashboard.canManageErlc && server
    ? `<section class="card" style="margin-top:18px"><h2>ER:LC server command</h2><p class="muted">Commands are allowlisted, require a reason, and need server-management access.</p><form method="post" action="/platform/erlc/command"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><div class="form-row"><div class="field"><label for="commandType">Command</label><select id="commandType" name="commandType"><option value="announce">Server announcement</option><option value="kick">Kick player</option><option value="ban">Ban player</option><option value="unban">Unban Roblox user ID</option><option value="lock">Lock server</option><option value="unlock">Unlock server</option></select></div><div class="field"><label for="player">Roblox username or ID (kick, ban, unban)</label><input id="player" name="player" maxlength="32" pattern="[A-Za-z0-9_ ]{1,32}" placeholder="Roblox username"></div></div><div class="field"><label for="commandReason">Message or reason</label><textarea id="commandReason" name="reason" maxlength="180" placeholder="Enter an announcement or moderation reason"></textarea></div><button type="submit">Review server command</button></form></section>`
    : `<div class="callout">Server commands are available to staff with Discord Manage Server or Administrator permission.</div>`;

  const body = `${errorNotice}${commandNotice}${requestError}<section><div class="eyebrow">Vhila SMP Control · live ER:LC</div><h1>Server control room</h1><p class="muted">Private-server data is fetched through the official ER:LC API. The server key stays on this server.</p><div class="toolbar"><a class="button secondary" href="/platform">← Platform</a><a class="button secondary" href="/platform/cad">Open CAD</a><a class="button secondary" href="/platform/erlc?refresh=1">Refresh live data</a><span class="muted">Data refreshes are briefly cached to respect ER:LC API limits.</span></div></section>
    ${server ? `<section class="metrics"><div class="stat"><strong>${escapeHtml(server.CurrentPlayers ?? 0)} / ${escapeHtml(server.MaxPlayers ?? "—")}</strong><span>Players in server</span></div><div class="stat"><strong>${escapeHtml(queue.length)}</strong><span>Players in queue</span></div><div class="stat"><strong>${escapeHtml(players.length)}</strong><span>Live player roster</span></div><div class="stat"><strong>${escapeHtml(allStaff.length)}</strong><span>ER:LC staff members</span></div></section>
      <section class="card"><div class="form-row"><div><h2>${escapeHtml(server.Name || "ER:LC Private Server")}</h2><p class="muted">Server owner Roblox ID: ${escapeHtml(server.OwnerId ?? "—")}</p></div><div><span class="tag">${server.CurrentPlayers > 0 ? "SERVER ACTIVE" : "SERVER EMPTY"}</span><p class="muted">Join key: ${escapeHtml(server.JoinKey || "—")}</p></div></div></section>
      <section class="card" style="margin-top:16px"><h2>Live players</h2><form class="toolbar" method="get" action="/platform/erlc"><input name="q" value="${escapeHtml(query)}" placeholder="Search name, Roblox ID, team, or callsign" aria-label="Search players"><button type="submit">Search</button></form><div class="player-grid">${playerCards}</div></section>
      <section class="columns" style="margin-top:16px"><div class="card"><h2>ER:LC server staff</h2><div class="table-wrap"><table><thead><tr><th>Username</th><th>Rank</th><th>Roblox ID</th></tr></thead><tbody>${staffRows}</tbody></table></div></div><div class="card"><h2>Server settings</h2><p><span class="tag">${server.TeamBalance ? "TEAM BALANCE ON" : "TEAM BALANCE OFF"}</span></p><p class="muted">Account verification: ${escapeHtml(server.AccVerifiedReq || "—")}</p><p class="muted">Queue positions returned: ${queue.map(escapeHtml).join(", ") || "No players queued"}</p></div></section>
      ${commandPanel}
      <section class="card" id="server-activity" style="margin-top:18px"><h2>Recent ER:LC activity</h2><div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Event</th><th>Player</th><th>Details</th></tr></thead><tbody>${logRows}</tbody></table></div></section>`
      : `<section class="card"><div class="product-icon">🔑</div><h2>Connect your ER:LC private server</h2><p class="muted">${escapeHtml(errorMessage || "Add ERLC_SERVER_KEY to .env to enable live ER:LC tools.")}</p><p>ER:LC requires its API server pack. Create or copy the private server key in your in-game server settings, then place it in the local .env file.</p><p><a href="https://apidocs.erlc.gg/" target="_blank" rel="noopener noreferrer">Read the official ER:LC API setup guide ↗</a></p></section>`}`;
  response.send(renderPage({
    title: "ER:LC control room",
    body,
    brandTitle: "Vhila SMP CONTROL",
    brandSubtitle: "ER:LC community platform",
    user: request.dashboard.session,
    csrf: request.dashboard.session.csrf,
    footerText: "ER:LC data is provided by the official private server API.",
  }));
});

app.get("/platform/cad", loadDashboardStaff, async (request, response) => {
  const query = typeof request.query.q === "string"
    ? request.query.q.trim().slice(0, 80)
    : "";
  let server = null;
  let errorMessage = "";
  try {
    server = await getErlcServerData(request.query.refresh === "1");
  } catch (error) {
    errorMessage = error.message;
  }
  const players = (Array.isArray(server?.Players) ? server.Players : []).filter(player => {
    const identity = playerIdentity(player);
    return [
      identity.name,
      identity.id,
      player?.Team,
      player?.Callsign,
      player?.Permission,
      erlcLocation(player),
    ].join(" ").toLowerCase().includes(query.toLowerCase());
  });
  const rows = players.length
    ? players.map(player => {
        const identity = playerIdentity(player);
        return `<tr><td><strong>${escapeHtml(identity.name)}</strong><br><span class="muted">${escapeHtml(identity.id || "ID unavailable")}</span></td><td>${escapeHtml(player.Team || "Civilian")}</td><td>${escapeHtml(player.Callsign || "—")}</td><td>${escapeHtml(player.Permission || "Normal")}</td><td>${escapeHtml(erlcLocation(player))}</td><td>${escapeHtml(player.WantedStars ?? 0)} ★</td></tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty">${server ? "No live players match this search." : "Connect an ER:LC server key to load the live CAD roster."}</td></tr>`;
  const body = `${errorMessage ? `<div class="notice error">${escapeHtml(errorMessage)}</div>` : ""}<section><div class="eyebrow">Vhila SMP Control · live roster</div><h1>ER:LC CAD</h1><p class="muted">Live player roster and unit details from your ER:LC private server. This read-only CAD view refreshes from the official API.</p><div class="toolbar"><a class="button secondary" href="/platform">← Platform</a><a class="button secondary" href="/platform/erlc">Server control room</a><a class="button secondary" href="/platform/cad?refresh=1">Refresh roster</a></div></section>
    <section class="metrics"><div class="stat"><strong>${escapeHtml(players.length)}</strong><span>Players shown</span></div><div class="stat"><strong>${escapeHtml(server?.CurrentPlayers ?? "—")} / ${escapeHtml(server?.MaxPlayers ?? "—")}</strong><span>Server population</span></div><div class="stat"><strong>${escapeHtml(new Set(players.map(player => player?.Team || "Civilian")).size)}</strong><span>Teams active</span></div><div class="stat"><strong>${escapeHtml(players.filter(player => player?.Callsign).length)}</strong><span>Units with callsigns</span></div></section>
    <section class="card"><form class="toolbar" method="get" action="/platform/cad"><input name="q" value="${escapeHtml(query)}" placeholder="Search player, callsign, team, or location" aria-label="Search live CAD roster"><button type="submit">Search</button></form><div class="table-wrap"><table><thead><tr><th>Player / Roblox ID</th><th>Department / team</th><th>Callsign</th><th>Server permission</th><th>Location</th><th>Wanted</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  response.send(renderPage({
    title: "Live ER:LC CAD",
    body,
    brandTitle: "Vhila SMP CONTROL",
    brandSubtitle: "Live ER:LC CAD",
    user: request.dashboard.session,
    csrf: request.dashboard.session.csrf,
    footerText: "Live roster provided by the official ER:LC private server API.",
  }));
});

app.post("/platform/erlc/command", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    if (!request.dashboard.canManageErlc) {
      throw new Error("ER:LC commands require Discord Manage Server or Administrator permission.");
    }

    const type = request.body.commandType;
    const player = typeof request.body.player === "string"
      ? request.body.player.trim()
      : "";
    const reason = typeof request.body.reason === "string"
      ? request.body.reason.trim()
      : "";
    if (!["announce", "kick", "ban", "unban", "lock", "unlock"].includes(type)) {
      throw new Error("Choose a valid ER:LC command.");
    }
    if (player && !/^[A-Za-z0-9_ ]{1,32}$/.test(player)) {
      throw new Error("Player names and IDs may only contain letters, numbers, spaces, and underscores.");
    }
    if (reason.length > 180 || /[\r\n]/.test(reason)) {
      throw new Error("Command message or reason must be 180 characters or fewer on one line.");
    }

    const commandType = {
      announce: { label: "Server announcement", permission: true },
      kick: { label: "Kick player", permission: request.dashboard.canKick },
      ban: { label: "Ban player", permission: request.dashboard.canBan },
      unban: { label: "Unban Roblox user", permission: request.dashboard.canBan },
      lock: { label: "Lock server", permission: true },
      unlock: { label: "Unlock server", permission: true },
    }[type];
    if (!commandType.permission) {
      throw new Error("Your Discord roles do not have permission for that ER:LC command.");
    }
    if (["kick", "ban", "unban"].includes(type) && !player) {
      throw new Error("Enter the Roblox username or ID for the player.");
    }
    if (["kick", "ban"].includes(type) && !reason) {
      throw new Error("Enter a reason for the kick or ban.");
    }
    if (type === "unban" && !/^\d{1,20}$/.test(player)) {
      throw new Error("Unban requires the numeric Roblox user ID.");
    }
    if (type === "announce" && !reason) {
      throw new Error("Enter the message for the server announcement.");
    }

    const commands = {
      announce: `:h ${reason}`,
      kick: `:kick ${player} ${reason}`,
      ban: `:ban ${player} ${reason}`,
      unban: `:unban ${player}`,
      lock: ":serverlock",
      unlock: ":serverunlock",
    };
    const confirmationId = randomBytes(32).toString("hex");
    pendingActions.set(confirmationId, {
      source: "erlc",
      action: type,
      label: commandType.label,
      command: commands[type],
      targetId: player || "ER:LC private server",
      reason: reason || commandType.label,
      moderatorId: request.dashboard.session.id,
      expiresAt: Date.now() + 5 * 60_000,
    });
    for (const [id, pending] of pendingActions) {
      if (pending.expiresAt <= Date.now()) pendingActions.delete(id);
    }

    const body = `<section class="card"><div class="eyebrow">ER:LC command confirmation</div><h1>Confirm ${escapeHtml(commandType.label)}</h1><p><strong>Target:</strong> ${escapeHtml(player || "ER:LC private server")}</p><p><strong>Reason or message:</strong> ${escapeHtml(reason || "—")}</p><p class="muted">The command will run in-game as virtual server management. This can affect active players.</p><form method="post" action="/platform/erlc/command/confirm"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><input type="hidden" name="confirmationId" value="${confirmationId}"><button class="${["kick", "ban", "lock"].includes(type) ? "danger" : ""}" type="submit">Confirm and send command</button> <a class="button secondary" href="/platform/erlc">Cancel</a></form></section>`;
    response.send(renderPage({
      title: "Confirm ER:LC command",
      body,
      brandTitle: "Vhila SMP CONTROL",
      brandSubtitle: "ER:LC command confirmation",
      user: request.dashboard.session,
      csrf: request.dashboard.session.csrf,
      footerText: "ER:LC commands are sent to your configured private server.",
    }));
  } catch (error) {
    if (request.dashboard) {
      response.redirect(`/platform/erlc?error=1&message=${encodeURIComponent(error.message)}`);
      return;
    }
    next(error);
  }
});

app.post("/platform/erlc/command/confirm", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const confirmationId = request.body.confirmationId;
    if (typeof confirmationId !== "string" || !/^[a-f0-9]{64}$/.test(confirmationId)) {
      throw new Error("This command confirmation is invalid or has expired.");
    }
    const pending = pendingActions.get(confirmationId);
    if (
      !pending ||
      pending.source !== "erlc" ||
      pending.expiresAt <= Date.now() ||
      pending.moderatorId !== request.dashboard.session.id
    ) {
      pendingActions.delete(confirmationId);
      throw new Error("This command confirmation is invalid or has expired.");
    }
    if (!request.dashboard.canManageErlc) {
      throw new Error("ER:LC commands require Discord Manage Server or Administrator permission.");
    }
    if (
      ["kick"].includes(pending.action) && !request.dashboard.canKick ||
      ["ban", "unban"].includes(pending.action) && !request.dashboard.canBan
    ) {
      throw new Error("Your current Discord permissions do not allow that ER:LC command.");
    }

    pendingActions.delete(confirmationId);
    const result = await erlcApi("/v1/server/command", {
      method: "POST",
      body: JSON.stringify({ command: pending.command }),
    });
    invalidateErlcServerData();
    await appendModerationLog({
      guildId: GUILD_ID,
      action: `erlc_${pending.action}`,
      targetId: pending.targetId,
      moderatorId: request.dashboard.session.id,
      reason: pending.reason,
      timestamp: Date.now(),
      response: typeof result?.message === "string" ? result.message : "Command sent",
    });
    response.redirect("/platform/erlc?notice=command-sent");
  } catch (error) {
    if (request.dashboard) {
      response.redirect(`/platform/erlc?error=1&message=${encodeURIComponent(error.message)}`);
      return;
    }
    next(error);
  }
});

app.post("/moderate", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const { action, targetId, reason: rawReason } = request.body;
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (!["warn", "timeout", "kick", "ban"].includes(action)) {
      throw new Error("Choose a valid moderation action.");
    }
    checkActionPermission(request.dashboard, action);
    if (typeof targetId !== "string" || !/^\d{17,20}$/.test(targetId)) {
      throw new Error("Enter a valid Discord user ID.");
    }
    if (!reason || reason.length > 500) {
      throw new Error("Enter a reason between 1 and 500 characters.");
    }
    if (targetId === request.dashboard.session.id) {
      throw new Error("You cannot moderate your own account.");
    }

    const target = await getGuildMember(targetId);
    if (target.user?.bot && action === "warn") {
      throw new Error("The dashboard does not issue warnings to bots.");
    }
    const minutes = action === "timeout" ? Number(request.body.minutes) : null;
    if (
      action === "timeout" &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > 40_320)
    ) {
      throw new Error("Timeout length must be between 1 and 40,320 minutes.");
    }

    const confirmationId = randomBytes(32).toString("hex");
    pendingActions.set(confirmationId, {
      action,
      targetId,
      targetName: target.user?.global_name || target.user?.username || targetId,
      reason,
      minutes,
      moderatorId: request.dashboard.session.id,
      expiresAt: Date.now() + 5 * 60_000,
    });
    for (const [id, pending] of pendingActions) {
      if (pending.expiresAt <= Date.now()) pendingActions.delete(id);
    }
    const actionLabels = { warn: "warn", timeout: "timeout", kick: "kick", ban: "ban" };
    const durationText = minutes ? `<p><strong>Timeout:</strong> ${escapeHtml(minutes)} minutes</p>` : "";
    const body = `<section class="card"><div class="eyebrow">Confirm action</div><h1>Confirm ${escapeHtml(actionLabels[action])}</h1><p>This will ${escapeHtml(actionLabels[action])} <strong>${escapeHtml(target.user?.global_name || target.user?.username || targetId)}</strong> (<code>${escapeHtml(targetId)}</code>).</p>${durationText}<p><strong>Reason:</strong> ${escapeHtml(reason)}</p><form method="post" action="/moderate/confirm"><input type="hidden" name="csrf" value="${escapeHtml(request.dashboard.session.csrf)}"><input type="hidden" name="confirmationId" value="${confirmationId}"><button class="${action === "kick" || action === "ban" ? "danger" : ""}" type="submit">Confirm ${escapeHtml(actionLabels[action])}</button> <a class="button secondary" href="/dashboard">Cancel</a></form></section>`;
    response.send(renderPage({
      title: "Confirm moderation action",
      body,
      user: request.dashboard.session,
      csrf: request.dashboard.session.csrf,
    }));
  } catch (error) {
    if (error.message === "Request origin did not match the configured dashboard URL.") {
      response.status(403).send(renderPage({
        title: "Request blocked",
        body: `<section class="card"><h1>Request blocked</h1><p>${escapeHtml(error.message)}</p><a class="button secondary" href="/dashboard">Return to dashboard</a></section>`,
        user: request.dashboard?.session,
      }));
      return;
    }
    const message = error.message || "The moderation action could not be completed.";
    if (request.dashboard) {
      response.redirect(`/dashboard?error=1&message=${encodeURIComponent(message)}`);
      return;
    }
    next(error);
  }
});

app.post("/moderate/confirm", loadDashboardStaff, async (request, response, next) => {
  try {
    verifyCsrf(request, request.dashboard.session);
    const confirmationId = request.body.confirmationId;
    if (typeof confirmationId !== "string" || !/^[a-f0-9]{64}$/.test(confirmationId)) {
      throw new Error("This confirmation is invalid or has expired.");
    }
    const pending = pendingActions.get(confirmationId);
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      pending.moderatorId !== request.dashboard.session.id
    ) {
      pendingActions.delete(confirmationId);
      throw new Error("This confirmation is invalid or has expired.");
    }
    checkActionPermission(request.dashboard, pending.action);
    pendingActions.delete(confirmationId);

    if (pending.action === "timeout") {
      const timeoutUntil = new Date(Date.now() + pending.minutes * 60_000).toISOString();
      await discordApi(`/guilds/${GUILD_ID}/members/${pending.targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ communication_disabled_until: timeoutUntil }),
        reason: pending.reason,
      });
    } else if (pending.action === "kick") {
      await discordApi(`/guilds/${GUILD_ID}/members/${pending.targetId}`, {
        method: "DELETE",
        reason: pending.reason,
      });
    } else if (pending.action === "ban") {
      await discordApi(`/guilds/${GUILD_ID}/bans/${pending.targetId}`, {
        method: "PUT",
        body: JSON.stringify({ delete_message_seconds: 0 }),
        reason: pending.reason,
      });
    }

    let warningUndelivered = false;
    try {
      await appendModerationLog({
        guildId: GUILD_ID,
        action: pending.action,
        targetId: pending.targetId,
        moderatorId: request.dashboard.session.id,
        reason: pending.reason,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(`Action ${pending.action} for ${pending.targetId} was applied but not logged: ${error.message}`);
      throw new Error(pending.action === "warn"
        ? "The warning could not be recorded. No warning DM was sent."
        : "The action was applied, but its activity log could not be saved. Contact a server administrator.");
    }
    if (pending.action === "warn") {
      try {
        const dmChannel = await discordApi("/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: pending.targetId }),
        });
        await discordApi(`/channels/${dmChannel.id}/messages`, {
          method: "POST",
          body: JSON.stringify({
            content: `You received a moderation warning in the Vhila SMP Discord server.\nReason: ${pending.reason}`,
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (error) {
        warningUndelivered = true;
        console.error(`Warning DM could not be delivered to ${pending.targetId}: ${error.message}`);
      }
    }
    response.redirect(warningUndelivered ? "/dashboard?warning=undelivered" : "/dashboard");
  } catch (error) {
    if (error.message === "Request origin did not match the configured dashboard URL.") {
      response.status(403).send(renderPage({
        title: "Request blocked",
        body: `<section class="card"><h1>Request blocked</h1><p>${escapeHtml(error.message)}</p><a class="button secondary" href="/dashboard">Return to dashboard</a></section>`,
        user: request.dashboard?.session,
      }));
      return;
    }
    if (request.dashboard) {
      response.redirect(`/dashboard?error=1&message=${encodeURIComponent(error.message)}`);
      return;
    }
    next(error);
  }
});

app.post("/logout", (request, response) => {
  const session = readSessionCookie(request);
  if (!session) {
    clearSessionCookie(response);
    response.redirect("/");
    return;
  }
  try {
    verifyCsrf(request, session);
    clearSessionCookie(response);
    response.redirect("/");
  } catch (error) {
    response.status(403).send(renderPage({
      title: "Sign-out blocked",
      body: `<section class="card"><h1>Sign-out blocked</h1><p>${escapeHtml(error.message)}</p><a class="button secondary" href="/dashboard">Return to dashboard</a></section>`,
      user: session,
    }));
  }
});

app.use((request, response) => {
  response.status(404).send(renderPage({
    title: "Page not found",
    body: `<section class="card"><h1>Page not found</h1><p>The page you requested does not exist.</p><a class="button secondary" href="/">Return</a></section>`,
  }));
});

app.use((error, request, response, next) => {
  console.error(`Dashboard request failed: ${error.message}`);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).send(renderPage({
    title: "Dashboard error",
    body: `<section class="card"><h1>Could not load this page</h1><p>${escapeHtml(error.message)}</p><a class="button secondary" href="/dashboard">Try again</a></section>`,
    user: request.dashboard?.session,
    csrf: request.dashboard?.session.csrf,
  }));
});

app.listen(parsedPort, "127.0.0.1", () => {
  console.log(`Vhila SMP moderation dashboard listening at ${baseUrl.origin}`);
});
