import fs from "node:fs";

// The release package selects its channel; user endpoint overrides remain configurable.
export const channelName = fs.readFileSync(new URL("../release/channel", import.meta.url), "utf8").trim();
const channels = JSON.parse(fs.readFileSync(new URL("../release/channels.json", import.meta.url), "utf8"));
export const channel = channels[channelName];
if (!channel) throw new Error(`Unknown release channel: ${channelName}`);
export const apiUrlEnv = `${channel.env_prefix}_API_URL`;
export const consoleUrlEnv = `${channel.env_prefix}_CONSOLE_URL`;
export const apiKeyEnv = `${channel.env_prefix}_API_KEY`;
