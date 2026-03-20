import os from "os";
import type { EmbedderPreset } from "../types.js";

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
 * Check whether the current machine has enough free RAM to run the given
 * embedder preset.
 *
 * Thresholds (based on `estimatedRAM`):
 * - `freeRAM < estimatedRAM × 1.2`  → **error**  (insufficient RAM)
 * - `freeRAM < estimatedRAM × 2.0`  → **warning** (may be slow / cause swapping)
 * - Otherwise                        → OK
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

  const freeRAM = os.freemem();
  const needed = preset.estimatedRAM;

  if (freeRAM < needed * 1.2) {
    result.canRun = false;
    result.errors.push(
      `Insufficient free RAM for ${preset.model}: ` +
      `needs ~${formatBytes(needed)}, only ${formatBytes(freeRAM)} available. ` +
      `Consider using a lighter model (e.g. minilm ~90 MB).`
    );
  } else if (freeRAM < needed * 2.0) {
    result.warnings.push(
      `Low free RAM for ${preset.model}: ` +
      `needs ~${formatBytes(needed)}, ${formatBytes(freeRAM)} available. ` +
      `The model may run slowly or cause swapping.`
    );
  }

  return result;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}
