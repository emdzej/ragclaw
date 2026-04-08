#!/usr/bin/env node

/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { addCommand } from "./commands/add.js";
import { chunkersList } from "./commands/chunkers.js";
import { configGet, configList, configSet } from "./commands/config.js";
import {
  dbDelete,
  dbInfoGet,
  dbInfoSet,
  dbInit,
  dbList,
  dbMerge,
  dbRename,
} from "./commands/db.js";
import { doctorCommand } from "./commands/doctor.js";
import { embedderDownload, embedderList } from "./commands/embedder.js";
import { listCommand } from "./commands/list.js";
import {
  pluginAdd,
  pluginCreate,
  pluginDisable,
  pluginEnable,
  pluginList,
  pluginRemove,
} from "./commands/plugin.js";
import { readCommand } from "./commands/read.js";
import { reindex } from "./commands/reindex.js";
import { removeCommand } from "./commands/remove.js";
import { searchCommand } from "./commands/search.js";
import { statusCommand } from "./commands/status.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("ragclaw")
  .description("Local-first RAG engine - index and search your documents")
  .version(version);

program
  .command("init")
  .description("[deprecated] Use 'ragclaw db init' instead")
  .argument("[name]", "Name of the knowledge base", "default")
  .action(async (name: string) => {
    console.error("Warning: 'ragclaw init' is deprecated. Use 'ragclaw db init' instead.");
    await dbInit(name);
  });

program
  .command("add")
  .description("Add content to the knowledge base")
  .argument("[source]", "File, directory, or URL to index")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-t, --type <type>", "Force source type: auto|text|code|web", "auto")
  .option("-r, --recursive", "Recurse into directories", true)
  .option("--text <content>", "Index inline text content directly")
  .option("--stdin", "Read text content from stdin")
  .option("-n, --name <name>", "Name / label for inline text source")
  .option("--include <pattern>", "Include glob pattern")
  .option("--exclude <pattern>", "Exclude glob pattern")
  .option("-e, --embedder <name>", "Embedder preset or model (e.g. bge, nomic, BAAI/bge-m3)")
  .option("--chunker <name>", "Chunker to use (e.g. sentence, fixed, semantic, code)")
  .option("--chunk-size <n>", "Override chunk size (tokens)")
  .option("--overlap <n>", "Override overlap size (tokens)")
  .option(
    "--timestamp <value>",
    "Content timestamp (epoch ms or ISO 8601). Associates content with a specific time."
  )
  .option("--allowed-paths <paths>", "Restrict indexing to these paths (comma-separated)")
  .option("--max-depth <n>", "Max directory recursion depth")
  .option("--max-files <n>", "Max files per directory source")
  .option("--allow-urls", "Allow URL sources")
  .option("--no-allow-urls", "Disallow URL sources")
  .option("--block-private-urls", "Block fetches to private/reserved IPs")
  .option("--no-block-private-urls", "Allow fetches to private/reserved IPs")
  .option("--enforce-guards", "Enforce path/URL security guards")
  .option("--no-enforce-guards", "Skip path/URL security guards (default)")
  // Crawl options
  .option("--crawl", "Enable crawling — follow links from the seed URL")
  .option("--crawl-max-depth <n>", "Max link depth from start URL (default: 3)")
  .option("--crawl-max-pages <n>", "Max pages to crawl (default: 100)")
  .option("--crawl-same-origin", "Stay on the same domain (default: true)", true)
  .option("--no-crawl-same-origin", "Allow following links to other domains")
  .option(
    "--crawl-include <patterns>",
    "Comma-separated path prefixes to include (e.g. /docs,/api)"
  )
  .option(
    "--crawl-exclude <patterns>",
    "Comma-separated path prefixes to exclude (e.g. /blog,/archive)"
  )
  .option("--crawl-concurrency <n>", "Concurrent requests during crawl (default: 1)")
  .option("--crawl-delay <ms>", "Delay between requests in ms (default: 1000)")
  .option("--ignore-robots", "Ignore robots.txt restrictions (use responsibly)")
  .action(addCommand);

program
  .command("search")
  .description("Search the knowledge base")
  .argument("<query>", "Search query")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-l, --limit <number>", "Max results", "10")
  .option(
    "--after <value>",
    "Only include chunks with timestamp after this value (epoch ms or ISO 8601)"
  )
  .option(
    "--before <value>",
    "Only include chunks with timestamp before this value (epoch ms or ISO 8601)"
  )
  .option("--json", "Output as JSON")
  .action(searchCommand);

program
  .command("read")
  .description("Read the full indexed content of a source from the knowledge base")
  .argument("<source>", "Source path or URL exactly as shown in search/list output")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("--json", "Output as JSON")
  .action(readCommand);

program
  .command("status")
  .description("Show knowledge base statistics")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .action(statusCommand);

program
  .command("list")
  .description("List indexed sources")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-t, --type <type>", "Filter by source type")
  .action(listCommand);

program
  .command("remove")
  .description("Remove a source from the index")
  .argument("<source>", "Source path or URL to remove")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-y, --yes", "Skip confirmation")
  .action(removeCommand);

program
  .command("reindex")
  .description("Re-process changed sources")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-f, --force", "Reindex all sources regardless of hash")
  .option("-p, --prune", "Remove sources that no longer exist")
  .option("-e, --embedder <name>", "Re-embed with a different model (rebuilds all vectors)")
  .option("--chunker <name>", "Chunker to use (e.g. sentence, fixed, semantic, code)")
  .option("--chunk-size <n>", "Override chunk size (tokens)")
  .option("--overlap <n>", "Override overlap size (tokens)")
  .option("--allowed-paths <paths>", "Restrict indexing to these paths (comma-separated)")
  .option("--allow-urls", "Allow URL sources")
  .option("--no-allow-urls", "Disallow URL sources")
  .option("--block-private-urls", "Block fetches to private/reserved IPs")
  .option("--no-block-private-urls", "Allow fetches to private/reserved IPs")
  .option("--enforce-guards", "Enforce path/URL security guards")
  .option("--no-enforce-guards", "Skip path/URL security guards (default)")
  .action((options) => reindex(options));

program
  .command("merge")
  .description("[deprecated] Use 'ragclaw db merge' instead")
  .argument("<source-db>", "Path to the source .sqlite database file")
  .option("-d, --db <name>", "Destination knowledge base name", "default")
  .option("--strategy <strategy>", "Merge strategy: strict (default) or reindex", "strict")
  .option(
    "--on-conflict <resolution>",
    "Conflict resolution: skip (default), prefer-local, or prefer-remote",
    "skip"
  )
  .option("--dry-run", "Preview what would change without writing anything")
  .option(
    "--include <patterns>",
    "Only import sources matching these path prefixes (comma-separated)"
  )
  .option("--exclude <patterns>", "Skip sources matching these path prefixes (comma-separated)")
  .option("-e, --embedder <name>", "Embedder to use for reindex strategy")
  .action(
    async (
      sourceDb: string,
      opts: {
        db: string;
        strategy?: string;
        onConflict?: string;
        dryRun?: boolean;
        include?: string;
        exclude?: string;
        embedder?: string;
      }
    ) => {
      console.error("Warning: 'ragclaw merge' is deprecated. Use 'ragclaw db merge' instead.");
      await dbMerge(sourceDb, opts);
    }
  );

// Plugin commands
const pluginCmd = program.command("plugin").description("Manage plugins");

pluginCmd.command("list").description("List installed plugins").action(pluginList);

pluginCmd
  .command("add")
  .description("Install a plugin from npm")
  .argument("<name>", "Plugin name (e.g., ragclaw-plugin-notion)")
  .action(pluginAdd);

pluginCmd
  .command("remove")
  .description("Uninstall a plugin")
  .argument("<name>", "Plugin name")
  .action(pluginRemove);

pluginCmd
  .command("create")
  .description("Create a new plugin from template")
  .argument("<name>", "Plugin name (e.g., 'notion' or 'ragclaw-plugin-notion')")
  .action(pluginCreate);

pluginCmd
  .command("enable")
  .description("Enable a plugin so it loads during indexing")
  .argument("[name]", "Plugin name (e.g., ragclaw-plugin-github)")
  .option("-a, --all", "Enable all discovered plugins")
  .action(pluginEnable);

pluginCmd
  .command("disable")
  .description("Disable a plugin so it no longer loads")
  .argument("<name>", "Plugin name")
  .action(pluginDisable);

// Config commands
const configCmd = program.command("config").description("View and manage configuration");

configCmd
  .command("list")
  .description("Show all config values and their sources")
  .action(configList);

configCmd
  .command("get")
  .description("Show a single config value")
  .argument("<key>", "Config key (e.g., allowedPaths, maxDepth)")
  .action(configGet);

configCmd
  .command("set")
  .description("Persist a config value to config.yaml")
  .argument("<key>", "Config key (e.g., allowedPaths, maxDepth)")
  .argument("<value>", "Value to set")
  .action(configSet);

program
  .command("doctor")
  .description("Check system compatibility and embedder requirements")
  .action(doctorCommand);

// Chunker commands
const chunkerCmd = program.command("chunkers").description("Inspect available chunkers");

chunkerCmd
  .command("list")
  .description("List all available chunkers (built-in and plugin-provided)")
  .option("--json", "Output as JSON")
  .action(chunkersList);

// Embedder commands
const embedderCmd = program.command("embedder").description("Manage and inspect embedders");

embedderCmd
  .command("list")
  .description("List all available embedders (built-in presets and plugin-provided)")
  .action(embedderList);

embedderCmd
  .command("download")
  .description("Download a model to the local cache for offline use")
  .argument("[name]", "Preset alias, HuggingFace model ID, or plugin embedder name")
  .option("-a, --all", "Download all built-in presets and plugin embedders")
  .action(embedderDownload);

// DB commands
const dbCmd = program.command("db").description("Manage knowledge bases");

dbCmd
  .command("list")
  .description("List all available knowledge bases")
  .option("--json", "Output as JSON")
  .action(dbList);

dbCmd
  .command("init")
  .description("Initialize a new knowledge base")
  .argument("[name]", "Name of the knowledge base", "default")
  .option("--description <text>", "Human-readable description of this knowledge base")
  .option("--keywords <list>", "Comma-separated keywords (e.g. 'api, auth, endpoints')")
  .action(dbInit);

// db info subcommand group
const dbInfoCmd = dbCmd.command("info").description("Manage knowledge base metadata");

dbInfoCmd
  .command("get")
  .description("Show the description and keywords for a knowledge base")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("--json", "Output as JSON")
  .action(dbInfoGet);

dbInfoCmd
  .command("set")
  .description("Set or update the description and keywords for a knowledge base")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("--description <text>", "Human-readable description of this knowledge base")
  .option("--keywords <list>", "Comma-separated keywords (e.g. 'api, auth, endpoints')")
  .action(dbInfoSet);

dbCmd
  .command("delete")
  .description("Delete a knowledge base and its .sqlite file")
  .argument("<name>", "Name of the knowledge base to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(dbDelete);

dbCmd
  .command("rename")
  .description("Rename a knowledge base")
  .argument("<old-name>", "Current name of the knowledge base")
  .argument("<new-name>", "New name for the knowledge base")
  .action(dbRename);

dbCmd
  .command("merge")
  .description("Merge another knowledge base into this one")
  .argument("<source-db>", "Path to the source .sqlite database file")
  .option("-d, --db <name>", "Destination knowledge base name", "default")
  .option("--strategy <strategy>", "Merge strategy: strict (default) or reindex", "strict")
  .option(
    "--on-conflict <resolution>",
    "Conflict resolution: skip (default), prefer-local, or prefer-remote",
    "skip"
  )
  .option("--dry-run", "Preview what would change without writing anything")
  .option(
    "--include <patterns>",
    "Only import sources matching these path prefixes (comma-separated)"
  )
  .option("--exclude <patterns>", "Skip sources matching these path prefixes (comma-separated)")
  .option("-e, --embedder <name>", "Embedder to use for reindex strategy")
  .action(dbMerge);

program.parse();
