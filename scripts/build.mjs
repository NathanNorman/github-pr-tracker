import { mkdir } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const distDir = path.join(root, "dist");
const outputFile = path.join(distDir, "github-pr-tracker.user.js");

const metadata = `// ==UserScript==
// @name         GitHub Personal PR Tracker
// @namespace    https://github.com/
// @version      1.3.1
// @description  Personal pull request tracker for your own open Toast GitHub PRs.
// @homepageURL  https://github.com/NathanNorman/github-pr-tracker
// @supportURL   https://github.com/NathanNorman/github-pr-tracker/issues
// @downloadURL  https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @match        https://github.toasttab.com/pulls*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// ==/UserScript==
`;

await mkdir(distDir, { recursive: true });
const result = await esbuild.build({
  entryPoints: [path.join(root, "src", "entry.js")],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: outputFile,
  logLevel: "silent",
  banner: { js: metadata }
});

if (result.errors.length) {
  throw new Error(result.errors.map((error) => error.text).join("\n"));
}
