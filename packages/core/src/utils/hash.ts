import { createHash } from "crypto";
import { createReadStream } from "fs";

/**
 * Compute the SHA-256 hex digest of a file using streaming reads.
 *
 * Unlike the previous approach (readFile → createHash().update(content)),
 * this never holds the entire file in memory — data flows through the hash
 * in ~64 KB chunks determined by the Node.js stream defaults.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
