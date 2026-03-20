import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";

const PLUGIN_TEMPLATE_PACKAGE_JSON = (name: string) => `{
  "name": "${name}",
  "version": "0.1.0",
  "description": "RagClaw plugin for ...",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "keywords": ["ragclaw", "ragclaw-plugin"],
  "peerDependencies": {
    "@emdzej/ragclaw-core": ">=0.2.0"
  },
  "devDependencies": {
    "@emdzej/ragclaw-core": "^0.2.0",
    "typescript": "^5.8.0"
  },
  "ragclaw": {
    "schemes": [],
    "extensions": []
  }
}
`;

const PLUGIN_TEMPLATE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
`;

const PLUGIN_TEMPLATE_INDEX = (name: string) => `import type { RagClawPlugin, Extractor, Source, ExtractedContent } from "@emdzej/ragclaw-core";

/**
 * Example extractor - replace with your implementation
 */
class MyExtractor implements Extractor {
  canHandle(source: Source): boolean {
    // Return true if this extractor can handle the source
    // Example: check URL scheme or file extension
    if (source.type === "url" && source.url?.startsWith("myscheme://")) {
      return true;
    }
    return false;
  }

  async extract(source: Source): Promise<ExtractedContent> {
    // Extract text content from the source
    // This is where you implement your custom extraction logic
    
    const text = "Extracted content goes here";
    
    return {
      text,
      metadata: {
        source: source.url || source.path,
        extractedAt: new Date().toISOString(),
      },
      sourceType: "text",
      mimeType: "text/plain",
    };
  }
}

/**
 * ${name} - RagClaw Plugin
 */
const plugin: RagClawPlugin = {
  name: "${name}",
  version: "0.1.0",
  
  // Custom extractors
  extractors: [
    new MyExtractor(),
  ],
  
  // URL schemes this plugin handles (without "://")
  // Example: ["notion", "slack", "youtube"]
  schemes: [],
  
  // File extensions this plugin handles
  // Example: [".epub", ".xlsx"]
  extensions: [],
  
  // Optional: initialization
  async init(config) {
    // Setup API clients, load credentials, etc.
    console.log("Plugin initialized with config:", config);
  },
  
  // Optional: cleanup
  async dispose() {
    // Cleanup resources
  },
};

export default plugin;
`;

const PLUGIN_TEMPLATE_README = (name: string) => `# ${name}

RagClaw plugin for ...

## Installation

\`\`\`bash
npm install -g ${name}
\`\`\`

## Usage

\`\`\`bash
ragclaw add myscheme://resource-id
\`\`\`

## Configuration

Set environment variables or add to \`~/.ragclawrc.yaml\`:

\`\`\`yaml
${name.replace("ragclaw-plugin-", "")}:
  apiKey: \${MY_API_KEY}
\`\`\`

## Development

\`\`\`bash
npm install
npm run build
npm link
\`\`\`

## License

MIT
`;

const PLUGIN_TEMPLATE_GITIGNORE = `node_modules/
dist/
*.log
.DS_Store
`;

export async function createPluginScaffold(name: string, targetDir?: string): Promise<string> {
  // Ensure name follows convention
  const pluginName = name.startsWith("ragclaw-plugin-") 
    ? name 
    : `ragclaw-plugin-${name}`;
  
  const dir = targetDir || join(process.cwd(), pluginName);
  
  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
  }
  
  // Create directories
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  
  // Write files
  await writeFile(join(dir, "package.json"), PLUGIN_TEMPLATE_PACKAGE_JSON(pluginName));
  await writeFile(join(dir, "tsconfig.json"), PLUGIN_TEMPLATE_TSCONFIG);
  await writeFile(join(dir, "src", "index.ts"), PLUGIN_TEMPLATE_INDEX(pluginName));
  await writeFile(join(dir, "README.md"), PLUGIN_TEMPLATE_README(pluginName));
  await writeFile(join(dir, ".gitignore"), PLUGIN_TEMPLATE_GITIGNORE);
  
  return dir;
}

export async function pluginCreate(name: string): Promise<void> {
  try {
    const dir = await createPluginScaffold(name);
    
    console.log("");
    console.log(chalk.green("✓ Plugin scaffold created!"));
    console.log("");
    console.log(`  ${chalk.cyan(dir)}`);
    console.log("");
    console.log("Next steps:");
    console.log("");
    console.log(chalk.dim("  1. Install dependencies:"));
    console.log(`     cd ${dir}`);
    console.log("     npm install");
    console.log("");
    console.log(chalk.dim("  2. Edit src/index.ts to implement your extractor"));
    console.log("");
    console.log(chalk.dim("  3. Build and link for testing:"));
    console.log("     npm run build");
    console.log("     npm link");
    console.log("");
    console.log(chalk.dim("  4. Test:"));
    console.log("     ragclaw plugin list");
    console.log("     ragclaw add myscheme://test");
    console.log("");
  } catch (err) {
    console.error(chalk.red(`Error: ${err}`));
    process.exit(1);
  }
}
