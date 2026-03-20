import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/core",
  "packages/cli",
  "packages/mcp",
  "plugins/ragclaw-plugin-github",
  "plugins/ragclaw-plugin-obsidian",
  "plugins/ragclaw-plugin-youtube",
]);
