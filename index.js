// index.js

import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, Partials } from 'discord.js';
import dotenv from 'dotenv';
import sqlite3 from 'better-sqlite3';
import { Rcon } from 'rcon-srcds';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const db = sqlite3('steam.db');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  guild_id TEXT PRIMARY KEY,
  whitelist_role_id TEXT,
  rcon_host TEXT,
  rcon_port INTEGER,
  rcon_password TEXT
);
`);

function setSteam(discordId, steamId) {
  const stmt = db.prepare('REPLACE INTO users (discord_id, steam_id) VALUES (?, ?)');
  stmt.run(discordId, steamId);
}

function getSteam(discordId) {
  const stmt = db.prepare('SELECT * FROM users WHERE discord_id = ?');
  return stmt.get(discordId);
}

function deleteSteam(discordId) {
  const stmt = db.prepare('DELETE FROM users WHERE discord_id = ?');
  stmt.run(discordId);
}

function setConfig(cfg) {
  const stmt = db.prepare(`
    REPLACE INTO config (guild_id, whitelist_role_id, rcon_host, rcon_port, rcon_password)
    VALUES (@guild_id, @whitelist_role_id, @rcon_host, @rcon_port, @rcon_password)
  `);
  stmt.run(cfg);
}

function getConfig(guildId) {
  const stmt = db.prepare('SELECT * FROM config WHERE guild_id = ?');
  return stmt.get(guildId);
}

async function sendConan(cmd, steamId, cfg) {
  const rcon = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });

  rcon.connect();

  try {
    const response = await rcon.send(`${cmd} ${steamId}`);
    console.log(`[RCON] ${cmd} ${steamId} → ${response.trim()}`);
  } catch (err) {
    console.error(`[RCON] Failed:`, err);
  } finally {
    rcon.disconnect();
  }
}

async function notifyDM(member, message) {
  try {
    const user = await client.users.fetch(member.id);
    await user.send(message);
  } catch {
    console.log(`❌ Failed to DM ${member.user?.tag || member.id}`);
  }
}

// Register commands
const commands = [
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your Steam64 ID.')
    .addStringOption(opt =>
      opt.setName('steamid')
        .setDescription('Your 17-digit Steam64 ID')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your stored Steam64 ID.'),

  new SlashCommandBuilder()
    .setName('setconfig')
    .setDescription('Admin: Set up the RCON and whitelist role.')
    .addRoleOption(opt =>
      opt.setName('role')
        .setDescription('Role that allows whitelisting')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('host')
        .setDescription('RCON IP or hostname')
        .setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('port')
        .setDescription('RCON port (default 25575)')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('password')
        .setDescription('RCON password')
        .setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: commands }
);

// Unified InteractionCreate handler
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'linksteam') {
    const steamId = i.options.getString('steamid')?.trim();
    if (!/^\d{17}$/.test(steamId))
      return i.reply({ content: '❌ Invalid Steam64 ID.', flags: 64 });

    await setSteam(i.user.id, steamId);
    await i.reply({ content: `✅ Stored **${steamId}**. Ask a mod for the role!`, flags: 64 });

    const cfg = await getConfig(i.guild.id);
    if (cfg && i.member.roles.cache.has(cfg.whitelist_role_id)) {
      await sendConan('whitelist add', steamId, cfg);
      await notifyDM(i.member, '✅ You’ve been **whitelisted** on the Conan server!');
    }
    return;
  }

  if (i.commandName === 'unlinksteam') {
    const row = await getSteam(i.user.id);
    if (!row)
      return i.reply({ content: '❌ You have no Steam64 ID linked.', flags: 64 });

    await deleteSteam(i.user.id);
    await i.reply({ content: '🗑️ Unlinked your Steam64 ID.', flags: 64 });

    const cfg = await getConfig(i.guild.id);
    if (cfg && i.member.roles.cache.has(cfg.whitelist_role_id)) {
      await sendConan('whitelist remove', row.steam_id, cfg);
      await notifyDM(i.member, '❌ You’ve been **removed from the whitelist**.');
    }
    return;
  }

  if (i.commandName === 'setconfig') {
    const cfg = {
      guild_id: i.guild.id,
      whitelist_role_id: i.options.getRole('role').id,
      rcon_host: i.options.getString('host'),
      rcon_port: i.options.getInteger('port'),
      rcon_password: i.options.getString('password')
    };
    await setConfig(cfg);
    await i.reply(`✅ Config saved.\nRole: <@&${cfg.whitelist_role_id}> • RCON: ${cfg.rcon_host}:${cfg.rcon_port}`);
    return;
  }
});

// Watch for whitelist role being added
client.on(Events.GuildMemberUpdate, async (before, after) => {
  const cfg = getConfig(after.guild.id);
  if (!cfg) return;

  const gained = !before.roles.cache.has(cfg.whitelist_role_id) && after.roles.cache.has(cfg.whitelist_role_id);
  if (!gained) return;

  const row = getSteam(after.id);
  if (!row) return;

  await sendConan('whitelist add', row.steam_id, cfg);
  await notifyDM(after, '✅ You’ve been **whitelisted** on the Conan server!');
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
