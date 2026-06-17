/**
 * qb-multicharacter Discord Bot
 * 
 * NEW FLOW (no open ports on FiveM server needed):
 *   1. Player creates character in-game → FiveM calls THIS bot's /verify endpoint
 *   2. Bot stores the pending code
 *   3. Player pastes code in Discord → bot validates it
 *   4. Bot calls FiveM's /confirmed endpoint (outbound from FiveM side = no firewall needed)
 *      OR uses a polling system where FiveM checks if code is verified
 * 
 * FiveM calls OUT to this bot (hosted on Railway/Render).
 * This bot calls OUT to FiveM's outbound webhook URL.
 * Neither side needs an open inbound port on the game server.
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, Events,
} = require('discord.js');
const express = require('express');

const {
  DISCORD_TOKEN,
  HTTP_SECRET,
  VERIFY_CHANNEL_ID,
  GUILD_ID,
  ROLE_REMOVE_ID,
  ROLE_GIVE_ID,
  PORT,
} = process.env;

// ─────────────────────────────────────────────
//  In-memory store: code → { citizenid, src, discordId, expires }
//  FiveM registers codes here, Discord verifies them
// ─────────────────────────────────────────────
const pending  = new Map(); // code → entry (set by FiveM)
const verified = new Map(); // code → { discordId, citizenId } (set by Discord user)
                            // FiveM polls /poll/:code to pick these up

// ─────────────────────────────────────────────
//  Express server — FiveM calls THIS
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// Auth middleware
function checkSecret(req, res, next) {
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== HTTP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/**
 * POST /register
 * Called by FiveM when a player creates a character and gets a code.
 * Body: { code, citizenid, src, secret }
 */
app.post('/register', checkSecret, (req, res) => {
  const { code, citizenid, src } = req.body;
  if (!code || !citizenid || src === undefined) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const entry = {
    code:      code.toUpperCase(),
    citizenid,
    src:       Number(src),
    expires:   Date.now() + (30 * 60 * 1000), // 30 minutes
    discordId: null,
  };

  pending.set(entry.code, entry);
  console.log(`[register] code=${entry.code} citizenid=${citizenid} src=${src}`);
  res.json({ ok: true });
});

/**
 * GET /poll/:code
 * Called by FiveM every few seconds to check if a code has been verified by Discord.
 * Returns { verified: true, discordId } or { verified: false }
 */
app.get('/poll/:code', checkSecret, (req, res) => {
  const code  = req.params.code.toUpperCase();
  const entry = verified.get(code);
  if (entry) {
    verified.delete(code);
    return res.json({ verified: true, discordId: entry.discordId, citizenid: entry.citizenid });
  }
  res.json({ verified: false });
});

/**
 * GET /health
 * Simple healthcheck so Railway/Render knows the bot is alive.
 */
app.get('/health', (_, res) => res.json({ ok: true }));

const httpPort = parseInt(PORT || '3000');
app.listen(httpPort, () => {
  console.log(`✅  HTTP server listening on port ${httpPort}`);
});

// ─────────────────────────────────────────────
//  Discord client
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Re-post the verification guide (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`✅  Discord logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅  Slash commands registered');
  } catch (err) {
    console.error('❌  Failed to register commands:', err);
  }
  await postGuideMessage();
});

// ─────────────────────────────────────────────
//  Guide embed
// ─────────────────────────────────────────────
async function postGuideMessage() {
  try {
    const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xc0392b)
      .setAuthor({ name: 'Character Verification', iconURL: client.user.displayAvatarURL() })
      .setDescription('> Create your character in-game, then verify here to get full server access.')
      .addFields(
        {
          name: '🎮  In-Game',
          value: [
            '`1` Join the FiveM server',
            '`2` Press **Create Character** on the select screen',
            '`3` Fill in your details and press **Confirm**',
            '`4` Copy the 8-character code shown on screen',
          ].join('\n'),
        },
        {
          name: '✅  Verify',
          value: [
            '`5` Paste your code in this channel',
            '`6` Your roles update and your character spawns automatically',
          ].join('\n'),
        },
        {
          name: '⏱️  Notes',
          value: 'Codes expire after **30 minutes** • messages here are auto-deleted • never share your code',
        }
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    console.log('✅  Guide posted');
  } catch (err) {
    console.error('Could not post guide:', err.message);
  }
}

// ─────────────────────────────────────────────
//  Core verify — called when user pastes code
// ─────────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9]{8}$/i;

async function handleVerify(code, userId, replyFn) {
  const upper = code.toUpperCase();
  const entry = pending.get(upper);

  if (!entry) {
    await replyFn({
      content: '❌ **Invalid code.** Make sure you copied it correctly from the character creator.',
      deleteAfter: 10000,
    });
    return;
  }

  if (Date.now() > entry.expires) {
    pending.delete(upper);
    await replyFn({
      content: '⏱️ **Code expired.** Go back in-game and press **Confirm** again to get a fresh code.',
      deleteAfter: 10000,
    });
    return;
  }

  if (entry.discordId) {
    await replyFn({
      content: '⚠️ This code has already been used.',
      deleteAfter: 8000,
    });
    return;
  }

  // Mark as verified — FiveM will pick this up via /poll
  entry.discordId = userId;
  verified.set(upper, { discordId: userId, citizenid: entry.citizenid });
  pending.delete(upper);

  console.log(`[verified] code=${upper} discordId=${userId} citizenid=${entry.citizenid}`);

  // Role swap
  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId);
    if (ROLE_REMOVE_ID && member.roles.cache.has(ROLE_REMOVE_ID)) {
      await member.roles.remove(ROLE_REMOVE_ID);
    }
    if (ROLE_GIVE_ID && !member.roles.cache.has(ROLE_GIVE_ID)) {
      await member.roles.add(ROLE_GIVE_ID);
    }
  } catch (roleErr) {
    console.error('Role update error:', roleErr.message);
  }

  // Success reply
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: 'Verified!', iconURL: client.user.displayAvatarURL() })
    .setDescription(`Your character has been verified — you're spawning in now! 🎮`)
    .addFields(
      { name: 'Citizen ID', value: `\`${entry.citizenid}\``, inline: true },
      { name: 'Role',       value: ROLE_GIVE_ID ? `<@&${ROLE_GIVE_ID}>` : '✅ Applied', inline: true },
    )
    .setTimestamp();

  await replyFn({ embeds: [embed], deleteAfter: 15000 });

  // Public welcome
  try {
    const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
    if (channel) {
      const welcome = new EmbedBuilder()
        .setColor(0xc0392b)
        .setDescription(`🟣 <@${userId}> just joined the city — welcome!`)
        .setTimestamp();
      await channel.send({ embeds: [welcome] });
    }
  } catch {}
}

// ─────────────────────────────────────────────
//  Message listener
// ─────────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.channelId !== VERIFY_CHANNEL_ID) return;
  if (msg.author.bot) return;

  const content = msg.content.trim();
  await msg.delete().catch(() => {});

  if (CODE_REGEX.test(content)) {
    const replyFn = async ({ content: txt, embeds, deleteAfter }) => {
      try {
        const sent = await msg.channel.send({
          content:          txt ? `<@${msg.author.id}> ${txt}` : undefined,
          embeds:           embeds || [],
          allowedMentions:  { users: [msg.author.id] },
        });
        if (deleteAfter) setTimeout(() => sent.delete().catch(() => {}), deleteAfter);
      } catch {
        try {
          const user = await client.users.fetch(msg.author.id);
          await user.send({ content: txt, embeds: embeds || [] });
        } catch {}
      }
    };
    await handleVerify(content, msg.author.id, replyFn);
  } else {
    const hint = await msg.channel.send({
      content:         `<@${msg.author.id}> ➡️ Please paste your **8-character code** from the character creator. Other messages are not allowed here.`,
      allowedMentions: { users: [msg.author.id] },
    }).catch(() => null);
    if (hint) setTimeout(() => hint.delete().catch(() => {}), 8000);
  }
});

// ─────────────────────────────────────────────
//  Slash commands
// ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'setup') {
    await postGuideMessage();
    return interaction.reply({ content: '✅ Guide re-posted!', ephemeral: true });
  }
});

// ─────────────────────────────────────────────
//  Cleanup expired codes every 5 minutes
// ─────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pending.entries()) {
    if (now > entry.expires) pending.delete(code);
  }
}, 300000);

client.on(Events.Error, err => console.error('Discord error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

client.login(DISCORD_TOKEN);
