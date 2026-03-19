import chalk from "chalk";
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

  console.log("");

  if (manifests.length === 0) {
    console.log(chalk.dim("No plugins installed."));
    console.log("");
    console.log("Install plugins with:");
    console.log(chalk.cyan("  npm install -g ragclaw-plugin-<name>"));
    console.log("");
    console.log("Or create local plugins in:");
    console.log(chalk.cyan("  ~/.openclaw/ragclaw/plugins/"));
  } else {
    console.log(chalk.bold("Installed plugins:"));
    console.log("");

    for (const manifest of manifests) {
      const schemes = manifest.ragclaw?.schemes?.join(", ") || "";
      const extensions = manifest.ragclaw?.extensions?.join(", ") || "";
      const handlers = [schemes, extensions].filter(Boolean).join(", ") || chalk.dim("(no handlers)");
      
      const sourceLabel = manifest.source === "npm" 
        ? chalk.blue("npm") 
        : manifest.source === "local"
          ? chalk.yellow("local")
          : chalk.green("workspace");

      console.log(
        `  ${chalk.white(manifest.name.padEnd(30))} ${chalk.dim(manifest.version.padEnd(8))} ${sourceLabel.padEnd(12)} ${handlers}`
      );
    }
  }

  console.log("");
  console.log(chalk.bold("Built-in extractors:"));
  console.log("");

  for (const extractor of BUILT_IN_EXTRACTORS) {
    console.log(
      `  ${chalk.white(extractor.name.padEnd(12))} ${chalk.dim(extractor.extensions)}`
    );
  }

  console.log("");
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
