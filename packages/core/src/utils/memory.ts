import os from "os";
import fs from "fs";
import { execSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Available memory — platform-aware
// ─────────────────────────────────────────────────────────────────────────────
//
// `os.freemem()` returns truly-idle pages only. The OS keeps lots of memory
// occupied as reclaimable file cache / inactive pages, which it immediately
// hands to new processes on demand. Using free instead of available makes the
// system look much more constrained than it really is.
//
// We read the OS's own "available" estimate:
//   Linux   → /proc/meminfo  MemAvailable  (kernel estimate, most accurate)
//   macOS   → vm_stat        free + inactive pages × page size
//   Windows → os.freemem()   already returns ullAvailPhys (includes standby)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the number of bytes the OS considers "available" for new processes.
 * Includes reclaimable page cache / inactive pages; always ≥ `os.freemem()`.
 * Falls back to `os.freemem()` on any parse error.
 */
export function getAvailableMemory(): number {
  try {
    switch (process.platform) {
      case "linux":
        return readLinuxAvailable();
      case "darwin":
        return readDarwinAvailable();
      default:
        // Windows: os.freemem() wraps ullAvailPhys which already includes
        // standby/reclaimable pages — no special handling needed.
        return os.freemem();
    }
  } catch {
    return os.freemem();
  }
}

// ── Linux ────────────────────────────────────────────────────────────────────

function readLinuxAvailable(): number {
  const content = fs.readFileSync("/proc/meminfo", "utf8");
  // MemAvailable: the kernel's own best estimate of reclaimable memory.
  // It accounts for min-free-kbytes, reclaimable slab, etc.
  const match = content.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!match) throw new Error("MemAvailable not found in /proc/meminfo");
  return parseInt(match[1], 10) * 1024;
}

// ── macOS ────────────────────────────────────────────────────────────────────

function readDarwinAvailable(): number {
  // vm_stat output looks like:
  //   Mach Virtual Memory Statistics: (page size of 16384 bytes)
  //   Pages free:                          123456.
  //   Pages inactive:                      234567.
  //   ...
  const output = execSync("vm_stat", { encoding: "utf8", timeout: 2000 });

  // Parse page size from header
  const pageSizeMatch = output.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) throw new Error("Cannot parse vm_stat page size");
  const pageSize = parseInt(pageSizeMatch[1], 10);

  // Parse free and inactive pages — both are immediately reclaimable
  const freeMatch = output.match(/Pages free:\s+(\d+)/);
  const inactiveMatch = output.match(/Pages inactive:\s+(\d+)/);
  if (!freeMatch || !inactiveMatch) throw new Error("Cannot parse vm_stat pages");

  const freePages = parseInt(freeMatch[1], 10);
  const inactivePages = parseInt(inactiveMatch[1], 10);

  return (freePages + inactivePages) * pageSize;
}
