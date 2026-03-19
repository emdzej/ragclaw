import { randomUUID } from "crypto";
import type { Chunk, Chunker, ExtractedContent } from "../types.js";

type Language = "typescript" | "javascript" | "python" | "go" | "java";

// Tree-sitter node types for functions/classes per language
const FUNCTION_TYPES: Record<Language, string[]> = {
  typescript: [
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
  ],
  javascript: [
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
  ],
  python: ["function_definition", "async_function_definition"],
  go: ["function_declaration", "method_declaration"],
  java: ["method_declaration", "constructor_declaration"],
};

const CLASS_TYPES: Record<Language, string[]> = {
  typescript: ["class_declaration", "interface_declaration", "type_alias_declaration"],
  javascript: ["class_declaration"],
  python: ["class_definition"],
  go: ["type_declaration"],
  java: ["class_declaration", "interface_declaration", "enum_declaration"],
};

interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  parse(source: string): TreeSitterTree;
}

export class CodeChunker implements Chunker {
  private parsers: Map<Language, TreeSitterParser> = new Map();
  private initPromise: Promise<void> | null = null;

  canHandle(content: ExtractedContent): boolean {
    return content.sourceType === "code";
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initParsers();
    return this.initPromise;
  }

  private async initParsers(): Promise<void> {
    try {
      const TreeSitter = (await import("tree-sitter")).default;

      // Load language grammars
      const languages: Array<{ name: Language; module: string }> = [
        { name: "typescript", module: "tree-sitter-typescript" },
        { name: "javascript", module: "tree-sitter-javascript" },
        { name: "python", module: "tree-sitter-python" },
        { name: "go", module: "tree-sitter-go" },
        { name: "java", module: "tree-sitter-java" },
      ];

      for (const { name, module } of languages) {
        try {
          const langModule = await import(module);
          const lang = name === "typescript" 
            ? langModule.default.typescript 
            : langModule.default;
          
          const parser = new TreeSitter();
          parser.setLanguage(lang);
          this.parsers.set(name, parser as unknown as TreeSitterParser);
        } catch (e) {
          // Language not available, will use fallback
        }
      }
    } catch (e) {
      // Tree-sitter native module not available, will use fallback for all languages
      console.warn("Tree-sitter not available, using fallback chunker for code");
    }
  }

  async chunk(
    content: ExtractedContent,
    sourceId: string,
    sourcePath: string
  ): Promise<Chunk[]> {
    await this.ensureInitialized();

    const language = content.metadata.language as Language;
    const parser = this.parsers.get(language);

    if (!parser) {
      // Fallback to simple line-based chunking
      return this.fallbackChunk(content, sourceId, sourcePath);
    }

    const tree = parser.parse(content.text);
    const chunks: Chunk[] = [];
    const lines = content.text.split("\n");

    // Extract classes first (as larger units)
    const classTypes = CLASS_TYPES[language] || [];
    this.collectNodes(tree.rootNode, classTypes, (node) => {
      const name = this.getNodeName(node, language);
      chunks.push({
        id: randomUUID(),
        text: node.text,
        sourceId,
        sourcePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        metadata: {
          type: "class",
          name,
          language,
        },
      });
    });

    // Extract standalone functions (not inside classes)
    const functionTypes = FUNCTION_TYPES[language] || [];
    this.collectNodes(tree.rootNode, functionTypes, (node) => {
      // Skip if this function is inside a class we already captured
      if (this.isInsideClass(node, classTypes)) {
        return;
      }

      const name = this.getNodeName(node, language);
      
      // Skip anonymous/small functions
      if (!name && node.text.length < 100) {
        return;
      }

      chunks.push({
        id: randomUUID(),
        text: node.text,
        sourceId,
        sourcePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        metadata: {
          type: "function",
          name: name || "anonymous",
          language,
        },
      });
    });

    // If we got no chunks, fall back to block-based chunking
    if (chunks.length === 0) {
      return this.fallbackChunk(content, sourceId, sourcePath);
    }

    return chunks;
  }

  private collectNodes(
    node: TreeSitterNode,
    types: string[],
    callback: (node: TreeSitterNode) => void
  ): void {
    if (types.includes(node.type)) {
      callback(node);
    }

    for (const child of node.children) {
      this.collectNodes(child, types, callback);
    }
  }

  private isInsideClass(node: TreeSitterNode, classTypes: string[]): boolean {
    // Walk up the tree to check if we're inside a class
    // This is a simplified check - tree-sitter doesn't give us parent refs easily
    // So we check by text inclusion which is imperfect but works for most cases
    return false; // For now, include all functions
  }

  private getNodeName(node: TreeSitterNode, language: Language): string | undefined {
    // Try common field names for identifiers
    const nameNode = 
      node.childForFieldName("name") ||
      node.childForFieldName("identifier");

    if (nameNode) {
      return nameNode.text;
    }

    // For arrow functions assigned to variables, the name is in the parent
    // This is harder to get without parent references
    return undefined;
  }

  private fallbackChunk(
    content: ExtractedContent,
    sourceId: string,
    sourcePath: string
  ): Chunk[] {
    const lines = content.text.split("\n");
    const chunks: Chunk[] = [];
    const chunkSize = 50; // lines per chunk
    const language = content.metadata.language as string;

    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const text = chunkLines.join("\n").trim();

      if (text.length < 20) continue; // Skip tiny chunks

      chunks.push({
        id: randomUUID(),
        text,
        sourceId,
        sourcePath,
        startLine: i + 1,
        endLine: Math.min(i + chunkSize, lines.length),
        metadata: {
          type: "block",
          language,
        },
      });
    }

    return chunks;
  }
}
