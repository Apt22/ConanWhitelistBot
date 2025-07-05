/**
 * Conan-Discord Whitelist Bot – multi-guild, cloud-hosted
 *
 *  Commands
 *  ──────────────────────────────────────────────────────────────
 *   /setconfig   (admin)   – save RCON + whitelist role for this guild
 *   /linksteam   (player)  – link your SteamID64
 *   /unlinksteam (player)  – remove your SteamID64
 *
 *  Role changes for the configured role automatically:
 *     ▸ whitelistplayer <steamid>   when added
 *     ▸ unwhitelistplayer <steamid> when removed
 *
 *  Dependencies
 *  ──────────────────────────────────────────────────────────────
 *   npm i discord.js rcon-srcds better-sqlite3 dotenv
 */

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
import Database from 'better-sqlite3';



/* ────── ENV ────── */
const { BOT_TOKEN, DATABASE_PATH = './conanbot.db' } = process.env;

/* ────── DATABASE ────── */
const db = new Database(DATABASE_PATH);

db.prepare(`
  CREATE TABLE IF NOT EXISTS links (
    discord_id TEXT PRIMARY KEY,
    steam_id   TEXT NOT NULL
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id           TEXT PRIMARY KEY,
    whitelist_role_id  TEXT NOT NULL,
    rcon_host          TEXT NOT NULL,
    rcon_port          INTEGER NOT NULL,
    rcon_password      TEXT NOT NULL
  );
`).run();

const setSteam    = db.prepare('INSERT OR REPLACE INTO links VALUES (?, ?)');
const getSteam    = db.prepare('SELECT steam_id FROM links WHERE discord_id = ?');
const deleteSteam = db.prepare('DELETE FROM links WHERE discord_id = ?');

const setConfig = db.prepare(`
  INSERT OR REPLACE INTO guild_configs
  VALUES (@guild_id,@whitelist_role_id,@rcon_host,@rcon_port,@rcon_password)
`);
const getConfig = db.prepare('SELECT * FROM guild_configs WHERE guild_id = ?');

/* ────── RCON HELPER ────── */
async function sendConan(cmd, steamId, cfg) {
  if (!cfg) return;

  const rcon = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });

  try {
    await rcon.connect();
    const res = await rcon.send(`${cmd} ${steamId}`);
    console.log(`[RCON ${cfg.guild_id}] ${cmd} ${steamId} → ${String(res).trim()}`);
  } catch (err) {
    console.error(`[RCON ${cfg.guild_id}]`, err);
  } finally {
    rcon.disconnect();
  }
}

/* ────── DISCORD CLIENT ────── */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

/* ────── SLASH COMMANDS ────── */
const commands = [
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your SteamID64 so staff can whitelist you')
    .addStringOption(opt =>
      opt.setName('steamid')
         .setDescription('17-digit SteamID64')
         .setRequired(true)),

  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Remove your linked SteamID64'),

  new SlashCommandBuilder()
    .setName('setconfig')
    .setDescription('Configure Conan RCON & whitelist role for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption(opt =>
      opt.setName('role')
         .setDescription('Role that triggers whitelisting')
         .setRequired(true))
    .addStringOption(opt =>
      opt.setName('rcon_host')
         .setDescription('RCON host')
         .setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('rcon_port')
         .setDescription('RCON port')
         .setRequired(true))
    .addStringOption(opt =>
      opt.setName('rcon_password')
         .setDescription('RCON password')
         .setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

/* ────── READY ────── */
client.once(Events.ClientReady, async () => {
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: commands.map(c => c.toJSON())
  });
  console.log(`[Discord] Ready as ${client.user.tag}`);
});

/* ────── INTERACTION HANDLER ────── */
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  /* /linksteam */
  if (cmd === 'linksteam') {
    const steamRaw = interaction.options.getString('steamid').trim();
    const steamId  = steamRaw.replace(/\s+/g, '');

    if (!/^\d{17}$/.test(steamId))
      return interaction.reply({ content: '❌ That is not a valid 17-digit SteamID64.', ephemeral: true });

    setSteam.run(interaction.user.id, steamId);
    await interaction.reply({
      content: `✅ Stored **${steamId}**. Ask a mod for the whitelist role when ready!`,
      ephemeral: true
    });

    /* auto-whitelist if role already present */
    const cfg = getConfig.get(interaction.guild.id);
    if (cfg) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id))
        await sendConan('whitelistplayer', steamId, cfg);
    }
  }

  /* /unlinksteam */
  if (cmd === 'unlinksteam') {
    const row = getSteam.get(interaction.user.id);
    if (!row)
      return interaction.reply({ content: '❌ You do not have a SteamID linked.', ephemeral: true });

    deleteSteam.run(interaction.user.id);
    await interaction.reply({ content: '✅ Your SteamID has been unlinked.', ephemeral: true });

    const cfg = getConfig.get(interaction.guild.id);
    if (cfg) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(cfg.whitelist_role_id))
        await sendConan('unwhitelistplayer', row.steam_id, cfg);
    }
  }

  /* /setconfig (admin) */
  if (cmd === 'setconfig') {
    const data = {
      guild_id:           interaction.guild.id,
      whitelist_role_id:  interaction.options.getRole('role').id,
      rcon_host:          interaction.options.getString('rcon_host'),
      rcon_port:          interaction.options.getInteger('rcon_port'),
      rcon_password:      interaction.options.getString('rcon_password')
    };
    setConfig.run(data);
    await interaction.reply(
      `✅ Configuration saved.\nRole: <@&${data.whitelist_role_id}> • RCON: \`${data.rcon_host}:${data.rcon_port}\``
    );
  }
});

/* ────── ROLE WATCHER ────── */
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  const cfg = getConfig.get(newM.guild.id);
  if (!cfg) return;                // guild not configured

  const had = oldM.roles.cache.has(cfg.whitelist_role_id);
  const has = newM.roles.cache.has(cfg.whitelist_role_id);
  if (had === has) return;         // role unchanged

  const row = getSteam.get(newM.id);
  if (!row) return;                // user not linked

  if (!had && has)
    sendConan('whitelistplayer', row.steam_id, cfg);
  else if (had && !has)
    sendConan('unwhitelistplayer', row.steam_id, cfg);
});

/* ────── LOGIN ────── */
client.login(BOT_TOKEN);
