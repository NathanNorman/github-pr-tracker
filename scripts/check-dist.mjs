import { readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const distFile = path.join(root, "dist", "github-pr-tracker.user.js");
const source = await readFile(distFile, "utf8");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const headerMatches = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/g) || [];
if (headerMatches.length !== 1) {
  throw new Error(`Expected exactly one userscript header, found ${headerMatches.length}.`);
}
const header = headerMatches[0];
if (!header.includes(`// @version      ${packageJson.version}`)) {
  throw new Error("Userscript version does not match package.json.");
}
if (!header.includes(`?version=${packageJson.version}`)) {
  throw new Error("Userscript download URL is not cache-busted for this version.");
}
if (!header.includes("?channel=stable")) {
  throw new Error("Userscript update URL is missing the stable channel cache key.");
}
const stripped = source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, "");
const tempFile = path.join(root, "dist", ".check-dist.tmp.js");
await writeFile(tempFile, stripped, "utf8");
try {
  await execFileAsync(process.execPath, ["--check", tempFile], { cwd: root });
} finally {
  await rm(tempFile, { force: true });
}
if (!/^\(\(\)\s*=>\s*\{[\s\S]*\}\)\(\);\s*$/m.test(stripped)) {
  throw new Error("Expected bundled output to be a self-contained IIFE.");
}
console.log("dist syntax OK");
