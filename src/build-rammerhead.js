import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const buildScript = require.resolve("rammerhead/src/build.js");
const rammerheadDir = resolve(dirname(buildScript), "..");
const testcafeDir = resolve(dirname(require.resolve("testcafe-hammerhead")), "..");
const nestedModulesDir = join(rammerheadDir, "node_modules");
const nestedTestcafeDir = join(nestedModulesDir, "testcafe-hammerhead");

mkdirSync(nestedModulesDir, { recursive: true });
if (!existsSync(nestedTestcafeDir)) {
  symlinkSync(testcafeDir, nestedTestcafeDir, process.platform === "win32" ? "junction" : "dir");
}

const result = spawnSync(process.execPath, [buildScript], {
  cwd: rammerheadDir,
  stdio: "inherit"
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
