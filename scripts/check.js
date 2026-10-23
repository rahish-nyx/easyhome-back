/**
 * Syntax check every backend source file without starting the server.
 * Usage: npm run check
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs = ["src", "scripts"];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (full.endsWith(".js")) files.push(full);
  }
  return files;
}

let failed = 0;

for (const dir of dirs) {
  let files = [];
  try {
    files = walk(join(root, dir));
  } catch {
    continue;
  }

  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      console.log(`  ok  ${relative(root, file)}`);
    } catch (error) {
      failed += 1;
      console.error(`\n  FAIL ${relative(root, file)}`);
      console.error(error.stderr?.toString() || error.message);
    }
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.\n`);
  process.exit(1);
}

console.log("\nAll backend files pass the syntax check.\n");
