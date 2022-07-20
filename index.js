import { Client } from "discord.js";
import { readFileSync } from "fs";
import { MongoClient } from "mongodb";
import fetch from "node-fetch";

const config = JSON.parse(readFileSync("config.json"));

const dbclient = new MongoClient(config.mongo_uri);
await dbclient.connect();

const db = dbclient.db();
const permissions = db.collection("permissions");

const client = new Client({
    intents: ["GUILDS", "GUILD_MESSAGES", "DIRECT_MESSAGES"],
    allowedMentions: { parse: [] },
    failIfNotExists: false,
});

process.on("uncaughtException", console.error);

client.once("ready", () => {
    console.log("Banhammer is ready!");
    update_guild_count();
});

const running = new Map();
const max = new Map();
const status = new Map();

function update_guild_count() {
    client.user.setPresence({
        activities: [
            {
                type: "WATCHING",
                name: `${client.guilds.cache.size} servers`,
            },
        ],
    });
}

client.on("guildCreate", update_guild_count);
client.on("guildDelete", update_guild_count);

client.on("interactionCreate", async (interaction) => {
    if (!allowed(interaction.member)) return;

    if (interaction.isButton()) {
        if (interaction.customId == "stop") {
            running.set(interaction.message.id, false);

            await interaction.update({
                embeds: [
                    {
                        title: "Stopped",
                        description:
                            "Massban operation was stopped during execution. Existing bans will not be revoked.",
                        color: "RED",
                    },
                ],
                components: [],
            });
        } else if (interaction.customId == "view") {
            await interaction.reply({
                content: `I have processed ${status.get(
                    interaction.message.id
                )} / ${max.get(interaction.message.id)} bans.`,
                ephemeral: true,
            });
        }
    }
});

async function allowed(member) {
    if (!member) return false;
    if (member.permissions.has("ADMINISTRATOR")) return true;

    const settings = await permissions.findOne({ guild: member.guild.id });
    if (!settings) return false;

    return (
        (settings.users ?? []).includes(member.id) ||
        member.roles.cache.hasAny(...(settings.roles ?? []))
    );
}

client.on("messageCreate", async (message) => {
    if (!message.guild) return;
    if (!(await allowed(message.member))) return;

    if (message.content == "bh!help") {
        return await message.reply({
            embeds: [
                {
                    title: "Banhammer Help",
                    description:
                        "`bh!massban [days] <url> [reason]` - massban users from a URL, optionally specifying the number of days to purge messages within, and an audit log reason\n" +
                        "`bh!massban [days] [reason] + file upload` - massban users from an uploaded file\n" +
                        "`bh!allow <user / role>` - allow a user/role to use banhammer (default: admins only)\n" +
                        "`bh!deny <user / role>` - remove permission for a user/role to use banhammer (note: this does **not** block them, it just removes a previous override)\n" +
                        "`bh!list` - list all users/roles that are currently explicitly permitted to use banhammer\n\n" +
                        "[Support Server](https://discord.gg/7TRKfSK7EU) (including bot updates/announcements channel)",
                    color: "009688",
                },
            ],
        });
    } else if (
        message.content.startsWith("bh!allow") ||
        message.content.startsWith("bh!deny")
    ) {
        if (!message.member.permissions.has("ADMINISTRATOR")) {
            return await message.reply(
                ":x: You need to be an administrator to modify the permission overrides."
            );
        }

        const allow = message.content.charAt(3) == "a";

        if (!message.content.match(/^bh!(allow|deny)\s+(<@[!&]?\d+>|\d+)$/)) {
            return await message.reply(
                `:x: Invalid syntax: expected \`bh!${
                    allow ? "allow" : "deny"
                } <user / role>\`.`
            );
        }

        const id = message.content.split(/\s+/, 2)[1].match(/\d+/)[0];

        const member = message.guild.members.cache.get(id);
        const role = message.guild.roles.cache.get(id);
        const object = member ?? role;

        if (object) {
            await message.reply(
                `:white_check_mark: ${
                    allow ? "Granted" : "Removed"
                } permission override ${allow ? "to" : "from"} ${object}.${
                    allow && !object.permissions.has("BAN_MEMBERS")
                        ? ` :warning: That ${
                              member ? "user" : "role"
                          } does not have permission to ban members normally.`
                        : ""
                }`
            );
        } else {
            return await message.reply(
                ":x: That does not appear to be a valid server member or role."
            );
        }

        await permissions.findOneAndUpdate(
            { guild: message.guild.id },
            {
                [allow ? "$addToSet" : "$pull"]: {
                    [member ? "users" : "roles"]: id,
                },
            },
            { upsert: true }
        );
    } else if (message.content == "bh!list") {
        const entry = await permissions.findOne({ guild: message.guild.id });
        if (!entry) {
            return await message.reply(
                ":information_source: No overrides are set; only administrators may use banhammer."
            );
        }

        try {
            await message.reply({
                embeds: [
                    {
                        title: ":information_source: Permission Overrides",
                        description:
                            "The following may use banhammer even without administrator permissions:\n\n" +
                            `Users: ${
                                (entry.users ?? [])
                                    .map((x) => `<@${x}>`)
                                    .join(" ") || "(none)"
                            }\n\n` +
                            `Roles: ${
                                (entry.roles ?? [])
                                    .filter((x) =>
                                        message.guild.roles.cache.has(x)
                                    )
                                    .map((x) => `<@&${x}>`)
                                    .join(" ") || "(none)"
                            }`,
                    },
                ],
            });
        } catch {
            await message.reply({
                content:
                    ":information_source: Permission Overrides (too many to fit in a normal embed)",
                files: [
                    {
                        attachment: Buffer.from(
                            `Users: ${
                                (entry.users ?? [])
                                    .map(
                                        (x) =>
                                            `${
                                                client.users.cache.get(x)
                                                    ?.tag ?? "[unknown user]"
                                            } (${x})`
                                    )
                                    .join(", ") || "(none)"
                            }\n\n` +
                                `Roles: ${
                                    (entry.roles ?? [])
                                        .map((x) => [
                                            message.guild.roles.cache.get(x)
                                                ?.name,
                                            x,
                                        ])
                                        .filter(([x]) => x)
                                        .map(([x, y]) => x + ` (${y})`)
                                        .join(", ") || "(none)"
                                }`,
                            "utf-8"
                        ),
                        name: "permissions.txt",
                    },
                ],
            });
        }
    } else if (message.content.startsWith("bh!massban")) {
        if (!message.guild.me.permissions.has("BAN_MEMBERS")) {
            return await message.reply(
                ":x: Please give me the Ban Members permission."
            );
        }

        if (message.attachments.size > 1) {
            return await message.reply(
                ":x: Only one file may be uploaded at a time."
            );
        }

        let raw = message.content.substring(10).trim();

        let days = 0;
        if (raw.match(/^[0-7]/)) {
            const d = raw.split(/\s+/, 1)[0];
            days = parseInt(d);

            if (isNaN(days)) {
                days = 0;
            } else if (days <= 0 || days > 7) {
                return await message.reply(
                    "Purge days argument should be between 0 and 7."
                );
            } else {
                raw = raw.substring(d.length).trim();
            }
        }

        let url;

        if (message.attachments.size > 0) {
            url = message.attachments.first().url;
        } else {
            url = raw.split(/\s+/, 1)[0];
            raw = raw.substring(url.length).trim();
        }

        const reason = raw;

        if (reason.length > 512) {
            return await message.reply(
                ":x: Ban reason cannot exceed 512 characters."
            );
        }

        let request;

        try {
            request = await fetch(url);
        } catch {
            await message.reply(":x: Invalid URL!");
        }

        if (!request.ok) {
            return await message.reply(
                ":x: Could not fetch the URL. Make sure it is publicly available and you have not entered the link incorrectly."
            );
        }

        const text = await request.text();
        const ids = [];
        const re = /\d+/g;
        let id;

        while ((id = re.exec(text))) {
            ids.push(id[0]);
        }

        const reply = await message.reply({
            embeds: [
                {
                    title: "Confirm Massban",
                    description:
                        "Please confirm that you would like to ban all of the following users (10 minutes).",
                    fields: [
                        {
                            name: reason ? "Reason" : "No reason provided.",
                            value: reason || "_ _",
                        },
                    ],
                    color: "PURPLE",
                },
            ],
            files: [
                {
                    attachment: Buffer.from(ids.join(" "), "utf-8"),
                    name: "massban.txt",
                },
            ],
            components: [
                {
                    type: "ACTION_ROW",
                    components: [
                        {
                            type: "BUTTON",
                            style: "SUCCESS",
                            customId: "confirm",
                            label: "CONFIRM",
                        },
                        {
                            type: "BUTTON",
                            style: "DANGER",
                            customId: "cancel",
                            label: "CANCEL",
                        },
                    ],
                },
            ],
        });

        let response;

        try {
            response = await reply.awaitMessageComponent({
                filter: (response) => response.user.id == message.author.id,
                time: 10000,
            });

            if (response.customId != "confirm") throw 0;
        } catch {
            const data = {
                embeds: [
                    {
                        title: "Canceled",
                        description:
                            "Massban operation was canceled or expired.",
                        color: "RED",
                    },
                ],
                files: [],
                components: [],
            };

            if (response) await response.update(data);
            else await reply.edit(data);

            return;
        }

        await response.update({
            embeds: [
                {
                    title: "Massban operation started",
                    color: "AQUA",
                },
            ],
            files: [],
            components: [
                {
                    type: "ACTION_ROW",
                    components: [
                        {
                            type: "BUTTON",
                            style: "DANGER",
                            customId: "stop",
                            label: "STOP",
                        },
                        {
                            type: "BUTTON",
                            style: "PRIMARY",
                            customId: "view",
                            label: "VIEW PROGRESS",
                        },
                    ],
                },
            ],
        });

        running.set(reply.id, true);
        max.set(reply.id, ids.length);
        status.set(reply.id, 0);

        const failed = [];
        let ended = false;

        for (const id of ids) {
            if (!running.get(reply.id)) {
                ended = true;
                break;
            }

            try {
                await message.guild.bans.create(id, { days, reason });
                console.log(`Just banned ${id}.`);
            } catch {
                failed.push(id);
            }

            status.set(reply.id, status.get(reply.id) + 1);
        }

        running.delete(reply.id);
        max.delete(reply.id);
        status.delete(reply.id);

        if (ended) return;

        await reply.edit({
            embeds: [
                {
                    title: "Massban complete",
                    description:
                        failed.length > 0
                            ? `Attempted massbanning ${ids.length} - ${
                                  ids.length - failed.length
                              } passed, ${failed.length} failed.`
                            : `Massbanned ${ids.length}.`,
                    color: "GREEN",
                },
            ],
            files:
                failed.length > 0
                    ? [
                          {
                              attachment: Buffer.from(
                                  failed.join(" "),
                                  "utf-8"
                              ),
                              name: "failed.txt",
                          },
                      ]
                    : [],
            components: [],
        });
    }
});

client.login(config.discord_token);
