/*───────────────────────────────────────────────────────────────
  Conan-Discord Whitelist Bot  –  SQLite3 + DM notice + fixed Rcon import
────────────────────────────────────────────────────────────────*/

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits
} from 'discord.js';

import Rcon from 'rcon-srcds';          // ✅ default export *is* the constructor
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

/*────────── ENV ─────────*/
const { BOT_TOKEN, DATABASE_PATH = './conanbot.db' } = process.env;

/*───────── DB SETUP ─────*/
sqlite3.verbose();
const db = new sqlite3.Database(DATABASE_PATH);

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

await dbRun(`CREATE TABLE IF NOT EXISTS links (
  discord_id TEXT PRIMARY KEY,
  steam_id   TEXT NOT NULL
);`);
await dbRun(`CREATE TABLE IF NOT EXISTS server_configs (
  guild_id           TEXT PRIMARY KEY,
  whitelist_role_id  TEXT NOT NULL,
  rcon_host          TEXT NOT NULL,
  rcon_port          INTEGER NOT NULL,
  rcon_password      TEXT NOT NULL
);`);

const setSteam    = (id, sid) => dbRun('INSERT OR REPLACE INTO links VALUES (?, ?)', [id, sid]);
const getSteam    = id => dbGet('SELECT steam_id FROM links WHERE discord_id = ?', [id]);
const deleteSteam = id => dbRun('DELETE FROM links WHERE discord_id = ?', [id]);

const setConfig = cfg => dbRun(`
  INSERT OR REPLACE INTO server_configs
  VALUES (?, ?, ?, ?, ?)`,
  [cfg.guild_id, cfg.whitelist_role_id, cfg.rcon_host, cfg.rcon_port, cfg.rcon_password]
);
const getConfig = gid => dbGet('SELECT * FROM server_configs WHERE guild_id = ?', [gid]);

/*──────── RCON helper ───────*/
async function sendConan(cmd, steamId, cfg) {
  const rcon = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });

  await rcon.connect();
  const resp = await rcon.send(`${cmd} ${steamId}`);
  console.log(`[RCON] ${cmd} ${steamId} → ${resp.trim()}`);
  rcon.disconnect();
}

/*──────── DM helper ───────*/
async function notifyDM(member, text) {
  try { await member.send(text); }
  catch {/* user disabled DMs */}
}

/*──────── Discord client ────*/
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

client.once(Events.ClientReady, async () => {
  console.log(`[Discord] Ready as ${client.user.tag}`);

  await client.application.commands.set([
    {
      name: 'linksteam',
      description: 'Link your SteamID64 so staff can whitelist you',
      options: [{ name: 'steamid', type: 3, description: '17-digit SteamID64', required: true }]
    },
    { name: 'unlinksteam', description: 'Remove your linked SteamID64' },
    {
      name: 'setconfig',
      description: 'Configure RCON & whitelist role (admin only)',
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
      options: [
        { name: 'role',     type: 8, description: 'Whitelist role', required: true },
        { name: 'host',     type: 3, description: 'RCON host/IP',   required: true },
        { name: 'port',     type: 4, description: 'RCON port',      required: true },
        { name: 'password', type: 3, description: 'RCON password',  required: true }
      ]
    }
  ]);
});

/*──────── Slash-command logic ────*/
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  /* /linksteam */
  if (i.commandName === 'linksteam') {
    const steamId = i.options.getString('steamid').trim();
    if (!/^\d{17}$/.test(steamId))
      return i.reply({ content: '❌ Invalid SteamID64.', flags: 64 });

    await setSteam(i.user.id, steamId);
    await i.reply({ content: `✅ Stored **${steamId}**.\nAsk a mod for the whitelist role!`, flags: 64 });

    const cfg = await getConfig(i.guild.id);
    if (cfg) {
      const member = await i.guild.members.fetch(i.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id)) {
        await sendConan('whitelist add', steamId, cfg);
        await notifyDM(member, `✅ You’ve been **whitelisted** on the Conan server!`);
      }
    }
  }

  /* /unlinksteam */
  if (i.commandName === 'unlinksteam') {
    const row = await getSteam(i.user.id);
    if (!row)
      return i.reply({ content: '❌ You have no SteamID linked.', flags: 64 });

    await deleteSteam(i.user.id);
    await i.reply({ content: '🗑️ Unlinked your SteamID.', flags: 64 });

    const cfg = await getConfig(i.guild.id);
    if (cfg) {
      const member = await i.guild.members.fetch(i.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id)) {
        await sendConan('whitelist remove', row.steam_id, cfg);
        await notifyDM(member, `❌ You’ve been **removed from the whitelist**.`);
      }
    }
  }

  /* /setconfig */
  if (i.commandName === 'setconfig') {
    const cfg = {
      guild_id:           i.guild.id,
      whitelist_role_id:  i.options.getRole('role').id,
      rcon_host:          i.options.getString('host'),
      rcon_port:          i.options.getInteger('port'),
      rcon_password:      i.options.getString('password')
    };
    await setConfig(cfg);
    await i.reply(`✅ Config saved.\nRole: <@&${cfg.whitelist_role_id}> • RCON: ${cfg.rcon_host}:${cfg.rcon_port}`);
  }
});

/*──────── Role-watch automation ────*/
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  const cfg = await getConfig(newM.guild.id);
  if (!cfg) return;

  const had = oldM.roles.cache.has(cfg.whitelist_role_id);
  const has = newM.roles.cache.has(cfg.whitelist_role_id);
  if (had === has) return;

  const row = await getSteam(newM.id);
  if (!row) return;

  if (has) {
    await sendConan('whitelist add', row.steam_id, cfg);
    await notifyDM(newM, `✅ You’ve been **whitelisted** on the Conan server!`);
  } else {
    await sendConan('whitelist remove', row.steam_id, cfg);
    await notifyDM(newM, `❌ You’ve been **removed from the whitelist**.`);
  }
});

/*──────── Start bot ─────────*/
client.login(BOT_TOKEN);
