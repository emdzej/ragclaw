/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPreset } from "../types.js";
import { getAvailableMemory } from "../utils/memory.js";

// ─────────────────────────────────────────────────────────────────────────────
// System Requirements Checker
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemCheck {
  /** Whether the system meets hard requirements to run this preset. */
  canRun: boolean;
  /** Non-fatal warnings (e.g. low available RAM — model may be slow). */
  warnings: string[];
  /** Fatal errors (e.g. insufficient RAM — model will likely OOM). */
  errors: string[];
}

/**
 * Check whether the current machine has enough available RAM to run the given
 * embedder preset.
 *
 * Uses `getAvailableMemory()` (free + reclaimable cache) rather than
 * `os.freemem()` (idle pages only), so the estimate is not misleadingly low
 * on systems with large page caches (common on Linux and macOS).
 *
 * Thresholds (based on `estimatedRAM`):
 * - `availableRAM < estimatedRAM × 1.2`  → **error**  (insufficient RAM)
 * - `availableRAM < estimatedRAM × 2.0`  → **warning** (may be slow / cause swapping)
 * - Otherwise                             → OK
 *
 * If the preset has no `estimatedRAM` value, the check is skipped and the
 * result is always OK (canRun=true, no warnings/errors).
 */
export function checkSystemRequirements(preset: EmbedderPreset): SystemCheck {
  const result: SystemCheck = { canRun: true, warnings: [], errors: [] };

  if (!preset.estimatedRAM || preset.estimatedRAM <= 0) {
    // No RAM estimate — cannot check, assume OK
    return result;
  }

  const availableRAM = getAvailableMemory();
  const needed = preset.estimatedRAM;

  if (availableRAM < needed * 1.2) {
    result.canRun = false;
    result.errors.push(
      `Insufficient available RAM for ${preset.model}: ` +
        `needs ~${formatBytes(needed)}, only ${formatBytes(availableRAM)} available. ` +
        `Consider using a lighter model (e.g. minilm ~90 MB).`
    );
  } else if (availableRAM < needed * 2.0) {
    result.warnings.push(
      `Low available RAM for ${preset.model}: ` +
        `needs ~${formatBytes(needed)}, ${formatBytes(availableRAM)} available. ` +
        `The model may run slowly or cause swapping.`
    );
  }

  return result;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}
