/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import chalk from "chalk";
import { getConfig, getConfigFilePath, setConfigValue, SETTABLE_KEYS } from "../config.js";
import type { RagclawConfig, ConfigKeyMeta } from "../config.js";

/**
 * Resolve the current value for a SETTABLE_KEYS entry.
 * Flat keys use `config[configKey]`; dotted extractor.* keys read from
 * `config.extractorLimits`.
 */
function resolveSettableValue(config: RagclawConfig, meta: ConfigKeyMeta): unknown {
  if (meta.configKey) {
    return config[meta.configKey];
  }
  // extractor.* keys
  if (meta.yamlKey.startsWith("extractor.")) {
    const limitsKey = meta.yamlKey.slice("extractor.".length);
    return (config.extractorLimits as unknown as Record<string, unknown>)[limitsKey];
  }
  return undefined;
}

/**
 * Determine where a config value came from.
 */
function getSource(meta: (typeof SETTABLE_KEYS)[number]): string {
  if (meta.envVar && process.env[meta.envVar] !== undefined) {
    return "env";
  }
  // We can't cheaply distinguish "config file" from "default" without re-parsing,
  // so we just report "config" if a config file exists and contains the key.
  // For simplicity, report "default" — the value shown is the resolved value
  // regardless.
  return "default";
}

/**
 * Format a resolved config value for display.
 */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : chalk.dim("(empty)");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

/**
 * `ragclaw config list` — show all config keys with resolved values and source.
 */
export async function configList(): Promise<void> {
  const config = getConfig();
  const configFile = getConfigFilePath();

  console.log("");
  console.log(chalk.bold("Configuration"));
  console.log(chalk.dim(`  Config file: ${configFile}`));
  console.log("");

  const keyWidth = Math.max(...SETTABLE_KEYS.map((k) => k.yamlKey.length)) + 2;

  for (const meta of SETTABLE_KEYS) {
    const value = resolveSettableValue(config, meta);
    const source = getSource(meta);
    const sourceLabel = source === "env"
      ? chalk.yellow(`[env: ${meta.envVar}]`)
      : chalk.dim("[default]");

    console.log(
      `  ${chalk.white(meta.yamlKey.padEnd(keyWidth))} ${formatValue(value).padEnd(40)} ${sourceLabel}`
    );
  }

  // Also show read-only keys
  console.log("");
  console.log(chalk.dim("  Read-only:"));
  console.log(`  ${"configDir".padEnd(keyWidth)} ${config.configDir}`);
  console.log("");
}

/**
 * `ragclaw config get <key>` — show a single config value.
 */
export async function configGet(key: string): Promise<void> {
  const config = getConfig();

  // Try matching by yamlKey first, then by configKey
  const meta = SETTABLE_KEYS.find((k) => k.yamlKey === key || k.configKey === key);

  if (meta) {
    const value = resolveSettableValue(config, meta);
    console.log(formatValue(value));
    return;
  }

  // Check read-only keys
  if (key === "configDir") {
    console.log(config.configDir);
    return;
  }

  console.log(chalk.red(`Unknown config key: "${key}"`));
  console.log(chalk.dim(`Valid keys: ${SETTABLE_KEYS.map((k) => k.yamlKey).join(", ")}, configDir`));
  process.exitCode = 1;
}

/**
 * `ragclaw config set <key> <value>` — persist a config value to config.yaml.
 */
export async function configSet(key: string, value: string): Promise<void> {
  const meta = SETTABLE_KEYS.find((k) => k.yamlKey === key || (k.configKey && k.configKey === key));

  if (!meta) {
    console.log(chalk.red(`Unknown config key: "${key}"`));
    console.log(chalk.dim(`Settable keys: ${SETTABLE_KEYS.map((k) => k.yamlKey).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  // Basic validation
  if (meta.type === "number") {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.log(chalk.red(`Invalid value for ${meta.yamlKey}: expected a positive integer, got "${value}"`));
      process.exitCode = 1;
      return;
    }
  }
  if (meta.type === "boolean") {
    if (value !== "true" && value !== "false") {
      console.log(chalk.red(`Invalid value for ${meta.yamlKey}: expected "true" or "false", got "${value}"`));
      process.exitCode = 1;
      return;
    }
  }

  try {
    setConfigValue(meta.yamlKey, value);
    console.log(chalk.green(`✓ Set ${meta.yamlKey} = ${value}`));
    console.log(chalk.dim(`  Saved to ${getConfigFilePath()}`));
  } catch (err) {
    console.log(chalk.red(`Error: ${err}`));
    process.exitCode = 1;
  }
}