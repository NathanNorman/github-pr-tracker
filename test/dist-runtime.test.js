import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("built userscript mounts the sorting UI on the Toast tracker route", async () => {
  const source = await readFile(new URL("../dist/github-pr-tracker.user.js", import.meta.url), "utf8");
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="user-login" content="octocat"></head><body><main><div>Native pulls</div></main></body></html>',
    {
      url: "https://github.toasttab.com/pulls#pr-tracker",
      pretendToBeVisual: true,
      runScripts: "outside-only"
    }
  );
  const { window } = dom;
  const errors = [];
  const envelope = {
    accountLogin: "octocat",
    records: {},
    sortPreferences: {
      primary: { field: "repository", direction: "asc" },
      secondary: { field: "updated", direction: "desc" }
    },
    openListCache: { updatedAt: 1, items: [] },
    detailCache: {}
  };
  window.console.error = (...args) => errors.push(args.map(String).join(" "));
  window.GM_getValue = async () => structuredClone(envelope);
  window.GM_setValue = async () => {};
  window.GM_addValueChangeListener = () => 1;
  window.GM_removeValueChangeListener = () => {};
  window.fetch = async (url) => ({
    ok: true,
    text: async () => String(url).includes("/pulls?")
      ? '<!doctype html><html><body><div data-issue-and-pr-hovercards-enabled="true"><a data-hovercard-type="pull_request" href="/toasttab/toast-analytics/pull/1">Analytics update</a></div></body></html>'
      : "<!doctype html><html><body></body></html>",
    headers: { get: () => "text/html" }
  });

  window.eval(source);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const host = window.document.querySelector("#tm-pr-tracker-root");
  assert.ok(host, errors.join("\n"));
  assert.ok(host.shadowRoot.querySelector(".sort-summary"), errors.join("\n"));
  assert.equal(host.shadowRoot.querySelector(".pr-group-title")?.textContent, "toast-analytics");
  assert.deepEqual(errors, []);
});
