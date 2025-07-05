/*───────────────────────────────────────────────────────────────
  Conan-Discord Whitelist Bot  –  multi-guild, SQLite3 edition
  ───────────────────────────────────────────────────────────────
  ✔ /setconfig   (admin)   – save RCON + whitelist role for this guild
  ✔ /linksteam   (player)  – link your SteamID64
  ✔ /unlinksteam (player)  – remove your SteamID64
  Role add/remove → RCON whitelistplayer / unwhitelistplayer
  Requires: discord.js, rcon-srcds, dotenv, sqlite3
────────────────────────────────────────────────────────────────*/

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} from 'discord.js';
import pkg from 'rcon-srcds';
const { Rcon } = pkg;
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

/*────────────────────────── ENV ──────────────────────────*/
const { BOT_TOKEN, DATABASE_PATH = './conanbot.db' } = process.env;

/*─────────────────────── DATABASE ───────────────────────*/
sqlite3.verbose();
const db = new sqlite3.Database(DATABASE_PATH);

/* Promisified helpers */
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

/* create tables (if not exist) */
await dbRun(`
  CREATE TABLE IF NOT EXISTS links (
    discord_id TEXT PRIMARY KEY,
    steam_id   TEXT NOT NULL
  );
`);
await dbRun(`
  CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id           TEXT PRIMARY KEY,
    whitelist_role_id  TEXT NOT NULL,
    rcon_host          TEXT NOT NULL,
    rcon_port          INTEGER NOT NULL,
    rcon_password      TEXT NOT NULL
  );
`);

/* CRUD helpers */
const setSteam    = (id, sid) => dbRun(
  'INSERT OR REPLACE INTO links (discord_id, steam_id) VALUES (?, ?)',
  [id, sid]
);
const getSteam    = id => dbGet(
  'SELECT steam_id FROM links WHERE discord_id = ?',
  [id]
);
const deleteSteam = id => dbRun(
  'DELETE FROM links WHERE discord_id = ?',
  [id]
);

const setConfig = cfg => dbRun(`
  INSERT OR REPLACE INTO guild_configs
  (guild_id, whitelist_role_id, rcon_host, rcon_port, rcon_password)
  VALUES (?,?,?,?,?)`,
  [cfg.guild_id, cfg.whitelist_role_id, cfg.rcon_host, cfg.rcon_port, cfg.rcon_password]
);
const getConfig = gid => dbGet(
  'SELECT * FROM guild_configs WHERE guild_id = ?',
  [gid]
);

/*────────────────────── RCON helper ─────────────────────*/
async function sendConan(cmd, steamId, cfg) {
  if (!cfg) return;
  const r = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });
  try {
    await r.connect();
    const res = await r.send(`${cmd} ${steamId}`);
    console.log(`[RCON ${cfg.guild_id}] ${cmd} ${steamId} → ${String(res).trim()}`);
  } catch (err) {
    console.error(`[RCON ${cfg.guild_id}]`, err);
  } finally {
    r.disconnect();
  }
}

/*────────────────── Discord client ──────────────────────*/
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

/*───────────────── Slash commands ───────────────────────*/
const commands = [
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your SteamID64 so staff can whitelist you')
    .addStringOption(o =>
      o.setName('steamid').setDescription('17-digit SteamID64').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Remove your linked SteamID64'),

  new SlashCommandBuilder()
    .setName('setconfig')
    .setDescription('Configure Conan RCON & whitelist role for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption(o =>
      o.setName('role').setDescription('Role that triggers whitelisting').setRequired(true))
    .addStringOption(o =>
      o.setName('rcon_host').setDescription('RCON host').setRequired(true))
    .addIntegerOption(o =>
      o.setName('rcon_port').setDescription('RCON port').setRequired(true))
    .addStringOption(o =>
      o.setName('rcon_password').setDescription('RCON password').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

client.once(Events.ClientReady, async () => {
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: commands.map(c => c.toJSON())
  });
  console.log(`[Discord] Ready as ${client.user.tag}`);
});

/*────────────── Interaction handler ─────────────────────*/
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  const cmd = i.commandName;

  /* /linksteam */
  if (cmd === 'linksteam') {
    const raw = i.options.getString('steamid').trim();
    const steamId = raw.replace(/\s+/g, '');
    if (!/^\d{17}$/.test(steamId))
      return i.reply({ content: '❌ Invalid 17-digit SteamID64.', ephemeral: true });

    await setSteam(i.user.id, steamId);
    await i.reply({ content: `✅ Stored **${steamId}**. Ask a mod for the whitelist role!`, ephemeral: true });

    const cfg = await getConfig(i.guild.id);
    if (cfg) {
      const member = await i.guild.members.fetch(i.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id))
        await sendConan('whitelistplayer', steamId, cfg);
    }
  }

  /* /unlinksteam */
  if (cmd === 'unlinksteam') {
    const row = await getSteam(i.user.id);
    if (!row)
      return i.reply({ content: '❌ You have no SteamID linked.', ephemeral: true });

    await deleteSteam(i.user.id);
    await i.reply({ content: '✅ Your SteamID has been unlinked.', ephemeral: true });

    const cfg = await getConfig(i.guild.id);
    if (cfg) {
      const member = await i.guild.members.fetch(i.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id))
        await sendConan('unwhitelistplayer', row.steam_id, cfg);
    }
  }

  /* /setconfig */
  if (cmd === 'setconfig') {
    const cfg = {
      guild_id:           i.guild.id,
      whitelist_role_id:  i.options.getRole('role').id,
      rcon_host:          i.options.getString('rcon_host'),
      rcon_port:          i.options.getInteger('rcon_port'),
      rcon_password:      i.options.getString('rcon_password')
    };
    await setConfig(cfg);
    await i.reply(`✅ Configuration saved.\nRole: <@&${cfg.whitelist_role_id}> • RCON: \`${cfg.rcon_host}:${cfg.rcon_port}\``);
  }
});

/*────────────── Role watcher ────────────────────────────*/
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  const cfg = await getConfig(newM.guild.id);
  if (!cfg) return;

  const had = oldM.roles.cache.has(cfg.whitelist_role_id);
  const has = newM.roles.cache.has(cfg.whitelist_role_id);
  if (had === has) return;

  const row = await getSteam(newM.id);
  if (!row) return;

  if (!had && has)
    await sendConan('whitelistplayer', row.steam_id, cfg);
  else if (had && !has)
    await sendConan('unwhitelistplayer', row.steam_id, cfg);
});

/*─────────────────────────────────────────────────────────*/
client.login(BOT_TOKEN);
