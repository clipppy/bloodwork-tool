/**
 * Shared sample discovery for the measurement harnesses.
 *
 * Both reconcile.ts and validate-flagging.ts must see the SAME set of reports,
 * or half the backtest can silently skip a sample that was added or renamed.
 * Discovery is dynamic on purpose: no hardcoded list to fall out of date, and a
 * renamed file can never throw ENOENT.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Recursively collect every *.pdf under `root` (default samples/), sorted for
 *  stable report ordering. Returns [] when the folder is absent or empty. */
export function findSamplePdfs(root = "samples"): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
