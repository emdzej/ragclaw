/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import chalk from "chalk";
import { getEnabledPlugins, getPluginsDir, setEnabledPlugins } from "../config.js";
import { PluginLoader } from "../plugins/loader.js";
import { pluginCreate as createScaffold } from "../plugins/scaffold.js";

const BUILT_IN_EXTRACTORS = [
  { name: "markdown", extensions: ".md, .mdx" },
  { name: "text", extensions: ".txt" },
  { name: "pdf", extensions: ".pdf" },
  { name: "docx", extensions: ".docx" },
  { name: "code", extensions: ".ts, .js, .py, .go, .java" },
  { name: "image", extensions: ".png, .jpg, .gif, .webp, .bmp, .tiff (OCR)" },
  { name: "web", extensions: "http://, https://" },
];

export async function pluginList(): Promise<void> {
  const loader = new PluginLoader();
  const manifests = await loader.discover();
  const enabled = new Set(getEnabledPlugins());

  console.log("");

  if (manifests.length === 0) {
    console.log(chalk.dim("No plugins installed."));
    console.log("");
    console.log("Install plugins with:");
    console.log(chalk.cyan("  npm install -g ragclaw-plugin-<name>"));
    console.log("");
    console.log("Or create local plugins in:");
    console.log(chalk.cyan(`  ${getPluginsDir()}`));
  } else {
    console.log(chalk.bold("Installed plugins:"));
    console.log("");

    let disabledCount = 0;

    for (const manifest of manifests) {
      const schemes = manifest.ragclaw?.schemes?.join(", ") || "";
      const extensions = manifest.ragclaw?.extensions?.join(", ") || "";
      const handlers =
        [schemes, extensions].filter(Boolean).join(", ") || chalk.dim("(no handlers)");

      const sourceLabel =
        manifest.source === "npm"
          ? chalk.blue("npm")
          : manifest.source === "local"
            ? chalk.yellow("local")
            : chalk.green("workspace");

      const isEnabled = enabled.has(manifest.name);
      const statusLabel = isEnabled ? chalk.green("✓ enabled") : chalk.dim("✗ not enabled");

      if (!isEnabled) disabledCount++;

      console.log(
        `  ${chalk.white(manifest.name.padEnd(30))} ${chalk.dim(manifest.version.padEnd(8))} ${sourceLabel.padEnd(12)} ${statusLabel.padEnd(20)} ${handlers}`
      );
    }

    if (disabledCount > 0) {
      console.log("");
      console.log(
        chalk.dim(`  ${disabledCount} plugin(s) not enabled. Run: ragclaw plugin enable <name>`)
      );
    }
  }

  console.log("");
  console.log(chalk.bold("Built-in extractors:"));
  console.log("");

  for (const extractor of BUILT_IN_EXTRACTORS) {
    console.log(`  ${chalk.white(extractor.name.padEnd(12))} ${chalk.dim(extractor.extensions)}`);
  }

  console.log("");
}

export interface PluginEnableOptions {
  all?: boolean;
}

export async function pluginEnable(
  name: string | undefined,
  options: PluginEnableOptions
): Promise<void> {
  const loader = new PluginLoader();
  const manifests = await loader.discover();
  const enabled = getEnabledPlugins();
  const enabledSet = new Set(enabled);

  if (options.all) {
    // Enable all discovered plugins
    const newlyEnabled: string[] = [];
    for (const m of manifests) {
      if (!enabledSet.has(m.name)) {
        enabledSet.add(m.name);
        newlyEnabled.push(m.name);
      }
    }

    if (newlyEnabled.length === 0) {
      console.log(chalk.dim("All discovered plugins are already enabled."));
      return;
    }

    setEnabledPlugins([...enabledSet]);
    console.log(chalk.green(`Enabled ${newlyEnabled.length} plugin(s):`));
    for (const n of newlyEnabled) {
      console.log(`  ${chalk.green("✓")} ${n}`);
    }
    return;
  }

  if (!name) {
    console.log(chalk.red("Please specify a plugin name, or use --all."));
    return;
  }

  // Verify the plugin is actually discovered
  const manifest = manifests.find((m) => m.name === name);
  if (!manifest) {
    console.log(chalk.red(`Plugin "${name}" not found.`));
    console.log(chalk.dim("Run: ragclaw plugin list  to see available plugins."));
    return;
  }

  if (enabledSet.has(name)) {
    console.log(chalk.dim(`Plugin "${name}" is already enabled.`));
    return;
  }

  enabledSet.add(name);
  setEnabledPlugins([...enabledSet]);
  console.log(chalk.green(`✓ Enabled plugin: ${name}`));
}

export async function pluginDisable(name: string): Promise<void> {
  const enabled = getEnabledPlugins();
  const enabledSet = new Set(enabled);

  if (!enabledSet.has(name)) {
    console.log(chalk.dim(`Plugin "${name}" is not currently enabled.`));
    return;
  }

  enabledSet.delete(name);
  setEnabledPlugins([...enabledSet]);
  console.log(chalk.green(`✓ Disabled plugin: ${name}`));
}

export async function pluginAdd(name: string): Promise<void> {
  console.log(chalk.yellow("Plugin installation via CLI coming soon."));
  console.log("");
  console.log("For now, install manually:");
  console.log(chalk.cyan(`  npm install -g ${name}`));
}

export async function pluginRemove(name: string): Promise<void> {
  console.log(chalk.yellow("Plugin removal via CLI coming soon."));
  console.log("");
  console.log("For now, remove manually:");
  console.log(chalk.cyan(`  npm uninstall -g ${name}`));
}

export async function pluginCreate(name: string): Promise<void> {
  await createScaffold(name);
}
