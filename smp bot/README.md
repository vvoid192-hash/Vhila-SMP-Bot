# Vhila SMP Discord Server Builder

This Discord.js v14 bot and staff dashboard provide community, moderation, and giveaway tools for **Vhila SMP**.

## What it does

- Creates private ticket channels from a menu with General Support, Partnership Support, Media Apply, Report A Bug, Payment Support, Player Report, and Other.
- Lets staff post all 19 Vhila SMP in-game rules with `/rules`.
- Lets staff post the Vhila SMP Discord community rules with `/discordrules`.
- Lets staff post a notification self-role menu with `/rolepanel` and a button-based verification panel with `/verifybot`.
- Lets staff post the 17 Vhila SMP staff rules and punishment system with `/staffrules`.
- Lets staff post the staff roles found on the current server with `/staffroles`.
- Lets staff post the 10 Vhila SMP staff Discord rules with `/staffdiscordrules`.
- Lets staff post an overview of Vhila SMP departments, verification, events, and support with `/infopanel`.
- Lets members submit partnership ads for staff approval, then posts approved ads in the partnerships channel.
- Lets members submit paid ads for staff review; staff confirm payment manually before posting approved ads.
- Lets staff start, end, and reroll button-entry giveaways with `/giveaway`.
- Provides the original Vhila SMP Control platform with Discord login, staff moderation, ER:LC live server tools, a live CAD roster, a department board, a dispatch board, and a staff application inbox.
- Lets moderators use `!cleas` (or `!clear`) to delete every message in the current server text channel.
- Adds `/ticketpanel`, `/ssuinfo`, `/partnershippanel`, `/paidadpanel`, `/serverstatus start|stop`, `/welcomemessages start|stop`, `/ticketroles`, `/giveaway start|end|reroll`, `/rolepanel`, `/verifybot`, `/infopanel`, `/rules`, `/discordrules`, `/staffroles`, `/staffrules`, `/staffdiscordrules`, `/serverinfo`, `/lock`, and `/unlock`, plus `!lock` and `!unlock` text commands.
- Adds `/welcomepanel` and mentions new members in the arrivals channel as soon as they join.

## Requirements

Current discord.js 14 requires Node.js 24.17+.

Install:
```bash
npm install
```

Create `.env` from `.env.example` (keep it private; never publish your bot token, application secret, or session secret):
```env
TOKEN=YOUR_BOT_TOKEN
CLIENT_ID=YOUR_BOT_APPLICATION_ID
CLIENT_SECRET=YOUR_DISCORD_APPLICATION_CLIENT_SECRET
GUILD_ID=YOUR_SERVER_ID
DASHBOARD_BASE_URL=http://localhost:3000
DASHBOARD_SESSION_SECRET=AT_LEAST_32_RANDOM_CHARACTERS
# Optional comma-separated Discord staff role IDs:
DASHBOARD_STAFF_ROLE_IDS=
PORT=3000
# ER:LC private server key (required for ER:LC platform features):
ERLC_SERVER_KEY=YOUR_ERLC_PRIVATE_SERVER_KEY
```

For a local dashboard, register `http://localhost:3000/auth/callback` as an OAuth2 redirect URI for the Discord application. Generate a session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Optional staff role IDs can be copied from Discord with Developer Mode; if none are configured, the dashboard recognizes the Vhila SMP staff ranks listed above and Discord members with moderation permissions.

The ER:LC live server dashboard requires the official ER:LC API server pack and the private server key shown in your in-game private server settings. Add it as `ERLC_SERVER_KEY` in `.env` only—never send it in chat, commit it, or put it in browser code. Read the official [ER:LC API guide](https://apidocs.erlc.gg/) for setup.

## Discord Developer Portal

Enable these intents as needed:
- Server Members Intent
- Message Content Intent (required for `!cleas` / `!clear`, `!lock`, and `!unlock`)

The bot needs enough permissions to manage the server structure. The safest setup is to give it:
- Manage Channels
- Manage Roles
- Manage Messages
- Mention @everyone, @here, and All Roles, or set configured ticket roles as mentionable
- Manage Guild
- Moderate Members
- View Audit Log

Put the bot's role ABOVE the roles this script creates, otherwise Discord will block role changes.

Invite the bot with the `bot` and `applications.commands` scopes.

## Run

```bash
npm start
```

For staff-only commands, staff means members with a configured Vhila SMP staff role (including the Owner, Management, Internal Affairs, Administrator, Moderator, and other listed staff ranks), or members with the Discord **Manage Server** or **Administrator** permission.

Use `/ticketpanel` in any server text channel to post the **Vhila SMP** ticket menu. Members choose one of the seven ticket reasons to open a private channel; staff can run the command. Each new ticket pings the configured staff roles and ticket opener. Tickets use the support categories shown in the ticket menu.

Use `/ssuinfo` in a server text channel to post the SSU information panel with the welcome, FAQ, and department guidance. Staff can run this command.

Use `/welcomepanel` to post the Vhila SMP welcome panel. New members are mentioned automatically in the `arrivals` text channel (including `「🛫」arrivals`); if none exists, the bot tries a `welcome` channel and then a channel containing `introductions`. The message explains that members must verify before chatting or viewing other channels. Staff can turn automatic welcomes on or off with `/welcomemessages start` and `/welcomemessages stop`; the setting is saved in `welcome-settings.json` and survives bot restarts.

Use `/infopanel` to post an overview of the server, verification and rules, departments, event/SSU updates, and how to get support. Channel references link to matching channels when they exist.

Use `/partnershippanel` to post a submission button. Members provide their community name, Discord invite, ER:LC server code, and a short description. Staff review submissions in a text channel named `partnership-review` or `partnership-applications` using **Approve & Post** or **Reject**. Approved ads are published in a text channel whose name includes `partnership` or `affiliate`. Keep the review channel private to staff.

Use `/paidadpanel` to post the paid-ad submission panel. Staff provide pricing/payment instructions privately and manually verify payment. Submissions go to `paid-ad-review`; staff use **Mark Paid & Post** only after confirming payment. Approved ads are posted in `paid-ads`. The bot does not accept or verify payments.

Use `/giveaway start` with a prize, duration (`30m`, `2h`, or `1d`), and number of winners to create a giveaway. Members enter or remove their entry with the button. Duration must be between 1 minute and 30 days. Use `/giveaway end` with the giveaway message ID in its channel to finish early, or `/giveaway reroll` with that ID to pick replacement winners. Enable Discord Developer Mode and use **Copy Message ID** on the giveaway post to get its ID. Giveaway entries and timers are saved in `giveaways.json` and restored after a restart. Only staff can manage giveaways.

Run `npm run dashboard` to start the Vhila SMP Control website and platform at `http://localhost:3000`. The home page introduces the Vhila SMP community platform; select **Staff sign in** to continue with Discord. Signed-in staff open the platform workspace, live ER:LC control room, live CAD roster, department board, dispatch board, application inbox, or Discord moderation view.

The ER:LC control room and CAD use the official `/v2/server` endpoint to show live server status, player rosters, teams, callsigns, in-game staff, queue, and available activity logs. Data refreshes are briefly cached, and API `429` responses are respected instead of retried. Staff with Discord **Manage Server** or **Administrator** can review and send allowlisted ER:LC announcements, kick/ban/unban, and server lock/unlock commands. Kick/ban/unban additionally require their matching Discord moderation permission; every command requires confirmation. Actual game commands still depend on ER:LC permissions and the server/API being available.

The Discord moderation view shows recent Discord audit-log activity plus warnings and actions recorded by the dashboard. Staff can issue warnings (sent by DM and recorded), timeouts, kicks, and bans with a required reason and confirmation. Discord role permissions determine which actions each staff member can use; the bot must also have the matching permission and role hierarchy. Give the bot **View Audit Log** to show server-wide audit events. Dashboard moderation history is kept locally in `moderation-log.json`.

For public hosting, use HTTPS, set `DASHBOARD_BASE_URL` to the public origin, and configure that exact `/auth/callback` URL in the Discord application's OAuth2 redirect URIs. Keep `.env`, the ER:LC server key, and the generated moderation log private. The dashboard binds to localhost by default and should be exposed only through a properly configured HTTPS reverse proxy.

Use `/rolepanel` to post the notification self-role menu. Members can select a role to add it and select it again to remove it. The options cover SSU, events, polls, announcements, giveaways, media, chat revival, department announcements, QOTD, ROTD, and FOTD notifications. The bot creates the no-permission notification roles if needed; it needs Manage Roles and its highest role must be above them.

Run `/verifybot` in a dedicated verification text channel. It posts a **Verify** button, ensures the no-permission **✅ Verified** role exists, and updates channels that were visible to `@everyone`: only **✅ Verified** members can view them, while the `arrivals` and verification channels remain visible but read-only before verification. Members who click **Verify** receive **✅ Verified**. The bot needs Manage Roles and Manage Channels, and its highest role must be above **✅ Verified**. Private channels stay private; check any custom roles that independently grant channel access if you need verification to be the only access path.

Use `/serverstatus start` to post a server-online status, or `/serverstatus stop` (also `/serverstatus shutdown`) to post the shutdown status. These post announcements; they do not control the actual game server.

Use `/rules` in a server text channel to post the 19 Vhila SMP in-game rules as orange-accented embeds. Staff can run this command.

Use `/discordrules` in a server text channel to post the Vhila SMP Discord community rules. This is separate from `/rules`, which posts the in-game rules. Staff can run this command.

Use `/staffrules` in a server text channel to post the 17 Vhila SMP staff rules and staff punishment system as red-accented embeds. Staff can run this command.

Use `/staffroles` to post the staff roles currently found in the server, ordered by Discord role hierarchy. It includes the visible Owner, Xenon, Management, Internal Affairs, Administrator, Moderator, and other staff roles shown in the LA role list, plus roles detected by staff-related names or moderation permissions. This only lists roles; it does not grant them bot permissions.

Use `/staffdiscordrules` in a server text channel to post the 10 Vhila SMP staff Discord rules as red-accented embeds. Staff can run this command.

Staff can manage extra roles included in ticket access and pings with `/ticketroles add role:<role>`, `/ticketroles remove role:<role>`, and `/ticketroles list`. Settings are saved in `ticket-roles.json` next to the bot script. The bot must be allowed to mention each configured role (either grant it Mention Everyone or make the role mentionable).

Use `!cleas` or `!clear` in a server text channel to clear its messages. Staff can use it, and the bot needs View Channel, Read Message History, Manage Messages, and Send Messages. Messages older than 14 days are deleted individually because Discord does not allow bulk deletion of older messages.

Use `!lock` or `!unlock` in a server text channel to lock or reopen it. Both prefix commands and the `/lock` and `/unlock` slash commands post a visible status notice in the channel. The commands require staff permissions. Server administrators can still bypass channel locks.
