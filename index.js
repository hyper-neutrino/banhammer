import { Client } from "discord.js";
import { readFileSync } from "fs";
import fetch from "node-fetch";

const config = JSON.parse(readFileSync("config.json"));

const client = new Client({
    intents: ["GUILDS", "GUILD_MESSAGES", "DIRECT_MESSAGES"],
    allowedMentions: { parse: [] },
    failIfNotExists: false,
});

process.on("uncaughtException", console.error);

client.once("ready", () => {
    console.log("Banhammer is ready!");
});

const running = new Map();
const max = new Map();
const status = new Map();

client.on("interactionCreate", async (interaction) => {
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

client.on("messageCreate", async (message) => {
    if (!message.guild) return;
    if (message.content.startsWith("bh!massban")) {
        if (!message.member.permissions.has("ADMINISTRATOR")) return;

        if (!message.guild.me.permissions.has("BAN_MEMBERS")) {
            return await message.reply(
                ":x: Please give me the Ban Members permission."
            );
        }

        let raw = message.content.substring(10).trim();

        let days = 0;
        if (raw.match(/^[0-7]/)) {
            const d = raw.split(/\s+/, 1)[0];
            days = parseInt(d);

            if (isNaN(days)) {
                days = undefined;
            } else if (days <= 0 || days > 7) {
                return await message.reply(
                    "Purge days argument should be between 0 and 7."
                );
            } else {
                raw = raw.substring(d.length).trim();
            }
        }

        const url = raw.split(/\s+/, 1)[0];
        const reason = raw.substring(url.length).trim();

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
