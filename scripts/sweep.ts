// scripts/sweep.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runSweep, DEFAULT_SWEEP_CONFIG, formatSweepTable } from "../lib/eval/sweep";

async function main() {
  console.log("Running sensitivity sweep...");
  const start = Date.now();

  const results = runSweep(DEFAULT_SWEEP_CONFIG);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Completed in ${elapsed}s`);

  const table = formatSweepTable(results);
  console.log(table);

  const outputDir = resolve(process.cwd(), "data/generated");
  mkdirSync(outputDir, { recursive: true });

  const jsonPath = resolve(outputDir, `sweep-${Date.now()}.json`);
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nWritten ${jsonPath}`);

  // Append to RESULTS.md
  const mdPath = resolve(process.cwd(), "RESULTS.md");
  const existing = require("fs").existsSync(mdPath) ? require("fs").readFileSync(mdPath, "utf-8") : "";
  // Splice the section in place. The previous version replaced everything from the
  // heading to EOF, which silently deleted the "Known limitations" section that
  // follows it — deleting your own caveats to make room for a results table is
  // exactly the wrong failure mode for this file.
  const section = /## Sensitivity Sweep[\s\S]*?(?=\n---\n|\n## |$)/;
  const updated = section.test(existing)
    ? existing.replace(section, table.trimEnd() + "\n")
    : existing.trimEnd() + "\n\n" + table + "\n";
  writeFileSync(mdPath, updated);
  console.log(`Updated ${mdPath}`);

  const losing = results.filter((r) => r.netPaiseDiff <= 0);
  if (losing.length === 0) {
    console.warn("\n⚠️  No losing cells found — widen the grid until at least one exists.");
    process.exitCode = 1;
  } else {
    console.log(`\n✅ Found ${losing.length} losing cell(s) — sweep is honest.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});