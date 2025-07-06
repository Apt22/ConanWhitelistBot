import { Client, GatewayIntentBits, Partials, Events, Collection } from 'discord.js';
import Rcon from 'rcon-srcds';
import 'dotenv/config';
import sqlite3 from 'better-sqlite3';

// === Bot Setup ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

client.commands = new Collection();
const db = new sqlite3('config.db');

// === SQLite Setup ===
db.prepare(`CREATE TABLE IF NOT EXISTS steam_links (
  discord_id TEXT PRIMARY KEY,
  steam_id TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS server_configs (
  guild_id TEXT PRIMARY KEY,
  whitelist_role_id TEXT,
  rcon_host TEXT,
  rcon_port INTEGER,
  rcon_password TEXT
)`).run();

// === Helper Functions ===
function setSteamID(discordId, steamId) {
  db.prepare(`INSERT OR REPLACE INTO steam_links (discord_id, steam_id) VALUES (?, ?)`).run(discordId, steamId);
}

function getSteamID(discordId) {
  const row = db.prepare(`SELECT steam_id FROM steam_links WHERE discord_id = ?`).get(discordId);
  return row ? row.steam_id : null;
}

function unlinkSteamID(discordId) {
  db.prepare(`DELETE FROM steam_links WHERE discord_id = ?`).run(discordId);
}

function setConfig(guildId, roleId, host, port, password) {
  db.prepare(`INSERT OR REPLACE INTO server_configs (guild_id, whitelist_role_id, rcon_host, rcon_port, rcon_password)
    VALUES (?, ?, ?, ?, ?)`).run(guildId, roleId, host, port, password);
}

function getConfig(guildId) {
  return db.prepare(`SELECT * FROM server_configs WHERE guild_id = ?`).get(guildId);
}

async function sendConan(cmd, steamId, cfg) {
  if (!cfg) return;
  const r = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });

  return new Promise((resolve, reject) => {
    r.connect().then(() => {
      const fullCmd = `${cmd} ${steamId}`;
      console.log(`[RCON ${cfg.guild_id}] ${fullCmd}`);
      r.send(fullCmd).then(response => {
        console.log(`[RCON Reply] ${response}`);
        r.disconnect();
        resolve(response);
      }).catch(reject);
    }).catch(reject);
  });
}

// === Slash Commands ===
client.once(Events.ClientReady, () => {
  console.log(`[Discord] Ready as ${client.user.tag}`);
  client.application.commands.set([
    {
      name: 'linksteam',
      description: 'Link your Steam ID for Conan whitelist',
      options: [{
        name: 'steamid',
        description: 'Your full Steam64 ID',
        type: 3,
        required: true
      }]
    },
    {
      name: 'unlinksteam',
      description: 'Unlink your Steam ID'
    },
    {
      name: 'setconfig',
      description: 'Set RCON and whitelist role info (admin only)',
      options: [
        {
          name: 'role',
          description: 'Whitelist role',
          type: 8,
          required: true
        },
        {
          name: 'host',
          description: 'RCON IP or hostname',
          type: 3,
          required: true
        },
        {
          name: 'port',
          description: 'RCON port',
          type: 4,
          required: true
        },
        {
          name: 'password',
          description: 'RCON password',
          type: 3,
          required: true
        }
      ]
    }
  ]);
});

// === Slash Command Logic ===
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isChatInputCommand()) return;

  if (int.commandName === 'linksteam') {
    const steamId = int.options.getString('steamid');
    setSteamID(int.user.id, steamId);
    await int.reply({ content: `✅ Stored Steam ID: \`${steamId}\``, ephemeral: true });
  }

  if (int.commandName === 'unlinksteam') {
    unlinkSteamID(int.user.id);
    await int.reply({ content: `🗑️ Unlinked your Steam ID.`, ephemeral: true });
  }

  if (int.commandName === 'setconfig') {
    if (!int.member.permissions.has('Administrator')) {
      return await int.reply({ content: `🚫 You must be an admin to use this.`, ephemeral: true });
    }

    const role = int.options.getRole('role');
    const host = int.options.getString('host');
    const port = int.options.getInteger('port');
    const password = int.options.getString('password');

    setConfig(int.guild.id, role.id, host, port, password);
    await int.reply(`✅ Config saved. Whitelist role: **${role.name}**, Host: \`${host}:${port}\``);
  }
});

// === Role Watcher for Whitelist Automation ===
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  const cfg = getConfig(newM.guild.id);
  if (!cfg) return;

  const had = oldM.roles.cache.has(cfg.whitelist_role_id);
  const has = newM.roles.cache.has(cfg.whitelist_role_id);
  if (had === has) return;

  const steamId = getSteamID(newM.id);
  if (!steamId) return;

  console.log(`[RoleWatch] ${has ? 'ADD' : 'REMOVE'} role for ${newM.id} → ${steamId}`);

  const cmd = has ? 'whitelist add' : 'whitelist remove';
  try {
    await sendConan(cmd, steamId, cfg);
  } catch (err) {
    console.error(`[RCON] Failed:`, err);
  }
});

// === Login ===
client.login(process.env.BOT_TOKEN);
