require("dotenv").config();
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  Events,
} = require("discord.js");
const { Pool } = require("pg");
const instances = require("./instances");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= DATABASE ================= */

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kill_counter (
      instance TEXT,
      boss TEXT,
      kills INTEGER DEFAULT 0,
      messageId TEXT,
      PRIMARY KEY (instance, boss)
    )
  `);

  await pool.query(`
   CREATE TABLE IF NOT EXISTS kill_counter_roles (
  roleId TEXT PRIMARY KEY
)
  `);

  console.log("✅ PostgreSQL ready");
})();

/* ================= PERMISSIONS ================= */

async function hasPermission(member) {

  if (member.permissions.has(PermissionsBitField.Flags.Administrator))
    return true;

 const result = await pool.query("SELECT roleId FROM kill_counter_roles");
  const allowedRoles = result.rows.map(r => r.roleid);

  return member.roles.cache.some(r => allowedRoles.includes(r.id));
}



/* ================= EMBED ================= */

async function buildEmbed(instanceName) {


  const result = await pool.query(
    "SELECT * FROM kill_counter WHERE instance = $1",
    [instanceName]
  );

  const rows = result.rows;
  const bosses = instances[instanceName];

  const description = bosses.map(boss => {
    const row = rows.find(r => r.boss === boss);
    const kills = row ? row.kills : 0;
    return `${kills} x 💀 ┃ ${boss}`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle(`🏰 WOTLK — ${instanceName}`)
    .setDescription(description)
    .setColor(0x3498db)
    .setTimestamp();
}

/* ================= COMMANDS ================= */

const commands = [

  new SlashCommandBuilder()
    .setName("setup-counter")
    .setDescription("Créer tous les embeds compteur"),

  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Ajouter un kill")
    .addStringOption(o =>
      o.setName("instance").setDescription("Instance").setRequired(true).setAutocomplete(true))
    .addStringOption(o =>
      o.setName("boss").setDescription("Boss").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer un kill")
    .addStringOption(o =>
      o.setName("instance").setDescription("Instance").setRequired(true).setAutocomplete(true))
    .addStringOption(o =>
      o.setName("boss").setDescription("Boss").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Ajouter un rôle autorisé")
    .addRoleOption(o =>
      o.setName("role").setDescription("Rôle").setRequired(true)),

  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Retirer un rôle autorisé")
    .addRoleOption(o =>
      o.setName("role").setDescription("Rôle").setRequired(true))

].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("✅ Slash commands ready");
});

/* ================= AUTOCOMPLETE ================= */

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isAutocomplete()) return;

  const focused = interaction.options.getFocused(true);

  if (focused.name === "instance") {
    const filtered = Object.keys(instances)
      .filter(i => i.toLowerCase().includes(focused.value.toLowerCase()))
      .slice(0, 25);

    return interaction.respond(filtered.map(i => ({ name: i, value: i })));
  }

  if (focused.name === "boss") {
    const instance = interaction.options.getString("instance");
    if (!instance || !instances[instance]) return interaction.respond([]);

    const filtered = instances[instance]
      .filter(b => b.toLowerCase().includes(focused.value.toLowerCase()))
      .slice(0, 25);

    return interaction.respond(filtered.map(b => ({ name: b, value: b })));
  }
});

/* ================= COMMAND HANDLER ================= */

client.on(Events.InteractionCreate, async interaction => {

  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  if (!await hasPermission(member))
    return interaction.editReply("❌ Permission refusée.");

  const { commandName } = interaction;

  /* ===== SETUP ===== */

  if (commandName === "setup-counter") {

    const channel = interaction.channel;

    for (const instanceName of Object.keys(instances)) {

      const bosses = instances[instanceName];

      for (const boss of bosses) {
        await pool.query(
          `INSERT INTO kill_counter (instance, boss, kills)
           VALUES ($1, $2, 0)
           ON CONFLICT (instance, boss) DO NOTHING`,
          [instanceName, boss]
        );
      }

      const embed = await buildEmbed(instanceName);
 const message = await channel.send({
  embeds: [embed]
});

      await pool.query(
        "UPDATE kill_counter SET messageId = $1 WHERE instance = $2",
        [message.id, instanceName]
      );
    }

    return interaction.editReply("✅ Compteurs créés.");
  }

  /* ===== ADD / REMOVE ===== */

  if (commandName === "add" || commandName === "remove") {

    const instance = interaction.options.getString("instance");
    const boss = interaction.options.getString("boss");

    const delta = commandName === "add" ? 1 : -1;

    await pool.query(
      `UPDATE kill_counter
       SET kills = GREATEST(kills + $1, 0)
       WHERE instance = $2 AND boss = $3`,
      [delta, instance, boss]
    );

    const result = await pool.query(
      "SELECT messageId FROM kill_counter WHERE instance = $1 LIMIT 1",
      [instance]
    );

    const messageId = result.rows[0]?.messageid;
    if (!messageId)
      return interaction.editReply("❌ Embed introuvable.");

    const message = await interaction.channel.messages.fetch(messageId);
    const updatedEmbed = await buildEmbed(instance);

    await message.edit({ embeds: [updatedEmbed] });

    return interaction.editReply("✅ Compteur mis à jour.");
  }

  /* ===== ROLE MANAGEMENT ===== */

  if (commandName === "addrole") {
    const role = interaction.options.getRole("role");
    await pool.query(
      `INSERT INTO kill_counter_roles (roleId)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [role.id]
    );
    return interaction.editReply("✅ Rôle ajouté.");
  }

  if (commandName === "removerole") {
    const role = interaction.options.getRole("role");
    await pool.query(
      "DELETE FROM kill_counter_roles WHERE roleId = $1",
      [role.id]
    );
    return interaction.editReply("✅ Rôle retiré.");
  }

});

/* ================= WEB SERVER ================= */

const app = express();
app.get("/", (req, res) => res.send("Bot running ✅"));
app.listen(process.env.PORT || 10000, "0.0.0.0");



client.login(process.env.TOKEN);