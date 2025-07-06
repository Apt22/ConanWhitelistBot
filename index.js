// index.js

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  Partials,
} from 'discord.js';
import dotenv from 'dotenv';
import sqlite3 from 'better-sqlite3';

/* ─── RCON import: one-line fix ─── */
import rconPkg from 'rcon-srcds';
const { Rcon } = rconPkg;            // ✅ Rcon is now the real constructor

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

const db = sqlite3('steam.db');

/* ─── SQLite schema ─── */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  steam_id   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  guild_id           TEXT PRIMARY KEY,
  whitelist_role_id  TEXT,
  rcon_host          TEXT,
  rcon_port          INTEGER,
  rcon_password      TEXT
);
`);

/* ─── DB helpers ─── */
function setSteam(discordId, steamId) {
  db.prepare(
    'REPLACE INTO users (discord_id, steam_id) VALUES (?, ?)'
  ).run(discordId, steamId);
}
function getSteam(discordId) {
  return db
    .prepare('SELECT steam_id FROM users WHERE discord_id = ?')
    .get(discordId);
}
function deleteSteam(discordId) {
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
}
function setConfig(cfg) {
  db.prepare(
    `REPLACE INTO config
     (guild_id, whitelist_role_id, rcon_host, rcon_port, rcon_password)
     VALUES (@guild_id,@whitelist_role_id,@rcon_host,@rcon_port,@rcon_password)`
  ).run(cfg);
}
function getConfig(guildId) {
  return db.prepare('SELECT * FROM config WHERE guild_id = ?').get(guildId);
}

/* ─── RCON helper ─── */
async function sendConan(cmd, steamId, cfg) {
  const rcon = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password,
  });

  rcon.connect(); // synchronous in rcon-srcds
  try {
    const resp = await rcon.send(`${cmd} ${steamId}`);
    console.log(`[RCON] ${cmd} ${steamId} → ${String(resp).trim()}`);
  } catch (err) {
    console.error('[RCON] Error:', err);
  } finally {
    rcon.disconnect();
  }
}

/* ─── DM helper ─── */
async function notifyDM(member, text) {
  try {
    await member.send(text);
  } catch {
    console.log(`DM blocked by ${member.user?.tag || member.id}`);
  }
}

/* ─── Slash-command setup ─── */
const commands = [
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your Steam64 ID.')
    .addStringOption((o) =>
      o
        .setName('steamid')
        .setDescription('17-digit Steam64 ID')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your stored Steam64 ID.'),
  new SlashCommandBuilder()
    .setName('setconfig')
    .setDescription('Admin: configure RCON and whitelist role.')
    .addRoleOption((o) =>
      o
        .setName('role')
        .setDescription('Role that triggers whitelisting')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('host').setDescription('RCON host / IP').setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName('port').setDescription('RCON port').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('password').setDescription('RCON password').setRequired(true)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: commands }
);

/* ─── Interaction handler ─── */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  /* linksteam */
  if (i.commandName === 'linksteam') {
    const steamId = i.options.getString('steamid')?.trim();
    if (!/^\d{17}$/.test(steamId))
      return i.reply({ content: '❌ Invalid Steam64 ID.', flags: 64 });

    setSteam(i.user.id, steamId);
    await i.reply({
      content: `✅ Stored **${steamId}**. Ask a mod for the role!`,
      flags: 64,
    });

    const cfg = getConfig(i.guild.id);
    if (cfg && i.member.roles.cache.has(cfg.whitelist_role_id)) {
      await sendConan('whitelist add', steamId, cfg);
      await notifyDM(
        i.member,
        '✅ You have been **whitelisted** on the Conan server!'
      );
    }
    return;
  }

  /* unlinksteam */
  if (i.commandName === 'unlinksteam') {
    const row = getSteam(i.user.id);
    if (!row)
      return i.reply({ content: '❌ You have no Steam64 ID linked.', flags: 64 });

    deleteSteam(i.user.id);
    await i.reply({ content: '🗑️ Unlinked your Steam64 ID.', flags: 64 });

    const cfg = getConfig(i.guild.id);
    if (cfg && i.member.roles.cache.has(cfg.whitelist_role_id)) {
      await sendConan('whitelist remove', row.steam_id, cfg);
      await notifyDM(
        i.member,
        '❌ You have been **removed from the whitelist**.'
      );
    }
    return;
  }

  /* setconfig */
  if (i.commandName === 'setconfig') {
    const cfg = {
      guild_id: i.guild.id,
      whitelist_role_id: i.options.getRole('role').id,
      rcon_host: i.options.getString('host'),
      rcon_port: i.options.getInteger('port'),
      rcon_password: i.options.getString('password'),
    };
    setConfig(cfg);
    await i.reply(
      `✅ Config saved.\nRole: <@&${cfg.whitelist_role_id}> • RCON: ${cfg.rcon_host}:${cfg.rcon_port}`
    );
    return;
  }
});

/* ─── Role watcher ─── */
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  const cfg = getConfig(newM.guild.id);
  if (!cfg) return;

  const had = oldM.roles.cache.has(cfg.whitelist_role_id);
  const has = newM.roles.cache.has(cfg.whitelist_role_id);
  if (had === has) return;

  const row = getSteam(newM.id);
  if (!row) return;

  if (has) {
    await sendConan('whitelist add', row.steam_id, cfg);
    await notifyDM(
      newM,
      '✅ You have been **whitelisted** on the Conan server!'
    );
  } else {
    await sendConan('whitelist remove', row.steam_id, cfg);
    await notifyDM(
      newM,
      '❌ You have been **removed from the whitelist**.'
    );
  }
});

/* ─── Ready ─── */
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ─── Login ─── */
client.login(process.env.DISCORD_TOKEN);
