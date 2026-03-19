#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { addCommand } from "./commands/add.js";
import { searchCommand } from "./commands/search.js";
import { statusCommand } from "./commands/status.js";
import { listCommand } from "./commands/list.js";
import { removeCommand } from "./commands/remove.js";
import { reindex } from "./commands/reindex.js";

const program = new Command();

program
  .name("ragclaw")
  .description("Local-first RAG engine - index and search your documents")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new knowledge base")
  .argument("[name]", "Name of the knowledge base", "default")
  .action(initCommand);

program
  .command("add")
  .description("Add content to the knowledge base")
  .argument("<source>", "File, directory, or URL to index")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-t, --type <type>", "Force source type: auto|text|code|web", "auto")
  .option("-r, --recursive", "Recurse into directories", true)
  .option("--include <pattern>", "Include glob pattern")
  .option("--exclude <pattern>", "Exclude glob pattern")
  .action(addCommand);

program
  .command("search")
  .description("Search the knowledge base")
  .argument("<query>", "Search query")
  .option("-d, --db <name>", "Knowledge base name", "default")
  .option("-l, --limit <number>", "Max results", "10")
  .option("-m, --mode <mode>", "Search mode: vector|keyword|hybrid", "hybrid")
  .option("--json", "Output as JSON")
  .action(searchCommand);

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
  .action((options) => reindex(options));

program.parse();
