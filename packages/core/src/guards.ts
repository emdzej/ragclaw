/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolve, sep } from "node:path";
import type { RagclawConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------

/**
 * Check whether `resolvedPath` is under one of the configured allowed paths.
 *
 * - If `allowedPaths` is non-empty, the path must be under at least one entry.
 * - If `allowedPaths` is empty **and** `fallbackCwd` is provided (MCP case),
 *   the path must be under `fallbackCwd`.
 * - If `allowedPaths` is empty **and** no `fallbackCwd` (CLI case), all paths
 *   are permitted.
 *
 * Returns `{ allowed: true }` or `{ allowed: false, reason: string }`.
 */
export function isPathAllowed(
  inputPath: string,
  config: Pick<RagclawConfig, "allowedPaths">,
  fallbackCwd?: string
): { allowed: true } | { allowed: false; reason: string } {
  const resolved = resolve(inputPath);

  const roots =
    config.allowedPaths.length > 0
      ? config.allowedPaths
      : fallbackCwd
        ? [resolve(fallbackCwd)]
        : null; // null = unrestricted

  if (roots === null) {
    return { allowed: true };
  }

  for (const root of roots) {
    // Ensure directory boundary: "/foo/bar" is under "/foo" but "/foobar" is not.
    if (resolved === root || resolved.startsWith(root + sep)) {
      return { allowed: true };
    }
  }

  const hint =
    config.allowedPaths.length > 0
      ? `Allowed paths: ${config.allowedPaths.join(", ")}. ` +
        `Adjust with: ragclaw config set allowedPaths "<paths>"`
      : `The MCP server restricts indexing to the working directory (${fallbackCwd}). ` +
        `Set allowedPaths in config to widen scope.`;

  return {
    allowed: false,
    reason: `Path "${resolved}" is outside allowed directories. ${hint}`,
  };
}

// ---------------------------------------------------------------------------
// URL guards
// ---------------------------------------------------------------------------

/**
 * RFC 1918 / RFC 5735 / RFC 4291 private & reserved IPv4/IPv6 ranges.
 * Each entry is [prefix, maskBits] for IPv4 or a test function for IPv6.
 */
const _PRIVATE_IPV4_RANGES: Array<[number, number, number]> = [
  // [byte0, byte1-start, byte1-end]  — simplified CIDR check
  // We'll do full numeric comparison below; this list is for documentation.
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
  // 169.254.0.0/16, 0.0.0.0/8, 100.64.0.0/10 (CGNAT), 198.18.0.0/15 (benchmark)
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;

  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  // IPv4-mapped  ::ffff:a.b.c.d
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped && isPrivateIPv4(v4Mapped[1])) return true;
  return false;
}

function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Check whether a URL is allowed by the current config.
 *
 * - If `allowUrls` is false → blocked.
 * - If `blockPrivateUrls` is true → DNS-resolve the hostname and reject
 *   private/reserved IP addresses (SSRF protection).
 *
 * Returns `{ allowed: true }` or `{ allowed: false, reason: string }`.
 */
export async function isUrlAllowed(
  urlString: string,
  config: Pick<RagclawConfig, "allowUrls" | "blockPrivateUrls">
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!config.allowUrls) {
    return {
      allowed: false,
      reason:
        `URL sources are disabled. ` +
        `Enable with: ragclaw config set allowUrls true (or env RAGCLAW_ALLOW_URLS=true)`,
    };
  }

  if (!config.blockPrivateUrls) {
    return { allowed: true };
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${urlString}` };
  }

  const hostname = parsed.hostname;

  // If the hostname is already an IP literal, check directly
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return {
        allowed: false,
        reason:
          `URL "${urlString}" resolves to a private/reserved IP address (${hostname}). ` +
          `Disable this check with: ragclaw config set blockPrivateUrls false`,
      };
    }
    return { allowed: true };
  }

  // DNS lookup
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      return {
        allowed: false,
        reason:
          `URL "${urlString}" resolves to a private/reserved IP address (${address}). ` +
          `Disable this check with: ragclaw config set blockPrivateUrls false`,
      };
    }
  } catch {
    // DNS failure — let the downstream fetch handle it
  }

  return { allowed: true };
}
