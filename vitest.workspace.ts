/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/core",
  "packages/cli",
  "packages/mcp",
  "plugins/ragclaw-plugin-github",
  "plugins/ragclaw-plugin-obsidian",
  "plugins/ragclaw-plugin-youtube",
  "e2e",
]);
