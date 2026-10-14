// Runs every *.test.ts under packages/*/test and apps/*/test with Node's built-in test runner.
// (A tiny script instead of a glob so it works the same on Windows, macOS and Linux.)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["packages", "apps"];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".test.ts")) files.push(p);
  }
};
for (const root of roots) {
  for (const pkg of readdirSync(root)) {
    const testDir = join(root, pkg, "test");
    try {
      if (statSync(testDir).isDirectory()) walk(testDir);
    } catch {
      /* no tests in this package */
    }
  }
}

const filter = process.argv.slice(2);
const selected = filter.length ? files.filter((f) => filter.some((x) => f.includes(x))) : files;
console.log(`Running ${selected.length} test files…`);
const res = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", ...selected], { stdio: "inherit" });
process.exit(res.status ?? 1);
