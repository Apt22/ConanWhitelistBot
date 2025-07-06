import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import Rcon from 'rcon-srcds';
import 'dotenv/config';
import fs from 'fs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

const steamLinkFile = './steam_links.json';
const whitelistRoleName = 'Whitelisted';

// Load Steam links from file
let steamLinks = {};
if (fs.existsSync(steamLinkFile)) {
  steamLinks = JSON.parse(fs.readFileSync(steamLinkFile));
}

// Save Steam links
function saveSteamLinks() {
  fs.writeFileSync(steamLinkFile, JSON.stringify(steamLinks, null, 2));
}

// Get config from .env
function getRconConfig(guildId) {
  return {
    rcon_host: process.env.RCON_HOST,
    rcon_port: parseInt(process.env.RCON_PORT, 10),
    rcon_password: process.env.RCON_PASSWORD
  };
}

// Send RCON command
async function sendConan(cmd, steamId, cfg) {
  if (!cfg || !steamId) return;

  const rcon = new Rcon({
    host: cfg.rcon_host,
    port: cfg.rcon_port,
    password: cfg.rcon_password
  });

  try {
    rcon.connect(); // ← no await

    const response = await rcon.send(`${cmd} ${steamId}`);
    console.log(`[RCON] ${cmd} ${steamId} → ${response.trim()}`);
  } catch (err) {
    console.error(`[RCON] Failed:`, err);
  } finally {
    rcon.disconnect();
  }
}

// Bot Ready
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Slash command for /linksteam
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  const steamId = i.options.getString('steamid');
  const userId = i.user.id;

  if (!/^\d{17}$/.test(steamId)) {
    return await i.reply({ content: '❌ Invalid Steam64 ID.', flags: 64 });
  }

  steamLinks[userId] = steamId;
  saveSteamLinks();

  await i.reply({ content: `✅ Stored Steam64 ID: ${steamId}`, flags: 64 });
});

// Slash command for /unlinksteam
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName !== 'unlinksteam') return;

  const userId = i.user.id;
  delete steamLinks[userId];
  saveSteamLinks();

  await i.reply({ content: '✅ Steam64 ID unlinked.', flags: 64 });
});

// Whitelist when role is added
client.on(Events.GuildMemberUpdate, async (before, after) => {
  const added = after.roles.cache.filter(r => !before.roles.cache.has(r.id));
  const whitelistRole = added.find(r => r.name === whitelistRoleName);
  if (!whitelistRole) return;

  const steamId = steamLinks[after.id];
  if (!steamId) return;

  const config = getRconConfig(after.guild.id);
  await sendConan('whitelist add', steamId, config);

  // DM the user
  try {
    await after.send(`✅ You have been whitelisted on the Conan Exiles server! (Steam64 ID: ${steamId})`);
  } catch (err) {
    console.warn(`Could not DM user ${after.user.tag}`);
  }
});

// Login
client.login(process.env.DISCORD_TOKEN);
