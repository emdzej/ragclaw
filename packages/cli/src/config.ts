import { homedir } from "os";
import { join } from "path";

export const RAGCLAW_DIR = join(homedir(), ".openclaw", "ragclaw");

export function getDbPath(name: string): string {
  return join(RAGCLAW_DIR, `${name}.sqlite`);
}
