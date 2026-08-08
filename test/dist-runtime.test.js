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
  window.GM_info = { script: { version: "1.7.7" } };
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
  assert.equal(host.dataset.trackerVersion, "1.7.7");
  assert.ok(host.shadowRoot.querySelector(".sort-summary"), errors.join("\n"));
  assert.ok(host.shadowRoot.querySelector(".filter-summary"), errors.join("\n"));
  assert.equal(host.shadowRoot.querySelector(".pr-group-title")?.textContent, "toast-analytics");
  assert.deepEqual(errors, []);
});

test("built userscript keeps a green authored-list current head authoritative over stale PR failure markup", async () => {
  const source = await readFile(new URL("../dist/github-pr-tracker.user.js", import.meta.url), "utf8");
  const headSha = "c90c99a44c02d34e8717d83fa00dab560b218d6d";
  const prUrl = "https://github.toasttab.com/toasttab/toast-labor/pull/704";
  const requests = [];
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
  let envelope = {
    schemaVersion: 1,
    accountLogin: "octocat",
    records: {},
    openListCache: { updatedAt: 0, items: [] },
    detailCache: {
      "toasttab/toast-labor#704": {
        updatedAt: Date.now(),
        parserVersion: 9,
        headSha,
        checksUrl: `https://github.toasttab.com/toasttab/toast-labor/commit/${headSha}/status-details?popover=true`,
        detail: { review: "approved", checks: "failing", merge: "blocked", draft: false }
      }
    }
  };

  window.console.error = (...args) => errors.push(args.map(String).join(" "));
  window.GM_info = { script: { version: "1.7.7" } };
  window.GM_getValue = async () => structuredClone(envelope);
  window.GM_setValue = async (_key, value) => {
    envelope = structuredClone(value);
  };
  window.GM_addValueChangeListener = () => 1;
  window.GM_removeValueChangeListener = () => {};
  window.fetch = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl), "https://github.toasttab.com");
    requests.push({ url: url.href, accept: options.headers?.Accept || "" });
    if (url.pathname === "/pulls" && url.searchParams.has("q")) {
      return response(`
        <div data-issue-and-pr-hovercards-enabled="true">
          <a data-hovercard-type="pull_request" href="/toasttab/toast-labor/pull/704">[AAP-490] Preserve restaurant currency in labor cost events</a>
          <details
            class="commit-build-statuses"
            data-checks-state="passing"
            data-head-sha="${headSha}"
            data-deferred-details-content-url="/toasttab/toast-labor/commit/${headSha}/status-details?popover=true"
          >
            <summary class="color-fg-success"><svg aria-label="37 / 81 checks OK" class="octicon octicon-check"></svg></summary>
          </details>
        </div>`);
    }
    if (url.href === prUrl) {
      return response(`
        <div data-url="/toasttab/toast-labor/pull/704/partials/commit_status_icon?oid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"></div>
        <div data-url="/toasttab/toast-labor/pull/704/partials/commit_status_icon?oid=${headSha}"></div>
        <div class="mergeability-details">
          <div class="branch-action-item"><h3 class="status-heading">Some checks failed</h3></div>
          <div class="branch-action-item"><h3 class="status-heading">Merging is blocked</h3></div>
        </div>`);
    }
    if (url.href === `${prUrl}/files`) {
      return response('<div class="js-diff-progressive-container"></div>');
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };

  assert.match(source, /^\/\/ @version\s+1\.7\.7$/m);
  window.eval(source);
  await waitFor(
    () => envelope.detailCache["toasttab/toast-labor#704"]?.detail?.checks === "passing",
    "AAP-490 current-head result"
  );

  const badge = window.document
    .querySelector("#tm-pr-tracker-root")
    ?.shadowRoot?.querySelector('.pr-row[data-pr-key="toasttab/toast-labor#704"] [data-kind="checks"]');
  const host = window.document.querySelector("#tm-pr-tracker-root");
  const row = host?.shadowRoot?.querySelector('.pr-row[data-pr-key="toasttab/toast-labor#704"]');
  const summary = envelope.openListCache.items.find(({ key }) => key === "toasttab/toast-labor#704");
  assert.equal(badge?.dataset.state, "passing");
  assert.equal(badge?.textContent, "Checks passing");
  assert.equal(row?.dataset.checksState, "passing");
  assert.equal(row?.dataset.headSha, headSha);
  assert.equal(summary?.checks, "passing");
  assert.equal(summary?.headSha, headSha);
  assert.equal(envelope.detailCache["toasttab/toast-labor#704"].headSha, headSha);
  assert.equal(envelope.detailCache["toasttab/toast-labor#704"].detail.checks, "passing");
  assert.equal(requests.filter(({ url }) => url === prUrl).length, 1);
  assert.equal(host?.dataset.trackerVersion, "1.7.7");
  assert.deepEqual(
    requests.filter(({ url }) => url.includes("/partials/commit_status_icon") || url.includes("/status-details")),
    []
  );
  assert.deepEqual(errors, []);
});

test("built userscript keeps note and private-label editors mounted across remote storage rerenders", async () => {
  const source = await readFile(new URL("../dist/github-pr-tracker.user.js", import.meta.url), "utf8");
  const prUrl = "https://github.toasttab.com/acme/api/pull/1";
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="user-login" content="octocat"></head><body><input id="github-search" type="search"><main><div>Native pulls</div></main></body></html>',
    {
      url: "https://github.toasttab.com/pulls#pr-tracker",
      pretendToBeVisual: true,
      runScripts: "outside-only"
    }
  );
  const { window } = dom;
  const errors = [];
  let remoteStorageListener = null;
  let envelope = {
    schemaVersion: 1,
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: { updatedAt: 0, items: [] },
    detailCache: {}
  };

  window.console.error = (...args) => errors.push(args.map(String).join(" "));
  window.GM_info = { script: { version: "1.7.7" } };
  window.GM_getValue = async () => structuredClone(envelope);
  window.GM_setValue = async (_key, value) => {
    envelope = structuredClone(value);
  };
  window.GM_addValueChangeListener = (_key, listener) => {
    remoteStorageListener = listener;
    return 1;
  };
  window.GM_removeValueChangeListener = () => {};
  window.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl), "https://github.toasttab.com");
    if (url.pathname === "/pulls" && url.searchParams.has("q")) {
      return response('<div data-issue-and-pr-hovercards-enabled="true"><a data-hovercard-type="pull_request" href="/acme/api/pull/1">Fix input focus</a></div>');
    }
    if (url.href === prUrl) {
      return response("<html><body></body></html>");
    }
    if (url.href === `${prUrl}/files`) {
      return response('<div class="js-diff-progressive-container"></div>');
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };

  assert.match(source, /^\/\/ @version\s+1\.7\.7$/m);
  window.eval(source);
  await waitFor(
    () => window.document.querySelector("#tm-pr-tracker-root")?.shadowRoot?.querySelector(".pr-row-select"),
    "tracker row"
  );

  const shadow = window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".pr-row-select").click();
  const notes = shadow.querySelector('textarea[data-focus-id="notes"]');
  const tagInput = shadow.querySelector('[aria-label="Private label name"]');
  const githubSearch = window.document.querySelector("#github-search");
  let escapedKeydowns = 0;
  window.document.addEventListener("keydown", () => {
    escapedKeydowns += 1;
    githubSearch.focus();
  });
  const removedEditors = [];
  const observer = new window.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node === notes || node === tagInput || node.contains?.(notes) || node.contains?.(tagInput)) {
          removedEditors.push(node);
        }
      }
    }
  });
  observer.observe(shadow.querySelector(".drawer"), { childList: true, subtree: true });

  notes.focus();
  notes.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, composed: true, key: "a" }));
  assert.equal(shadow.activeElement, notes);
  notes.value = "ab";
  notes.setSelectionRange(2, 2);
  notes.dispatchEvent(new window.Event("input", { bubbles: true }));
  const remoteEnvelope = structuredClone(envelope);
  remoteEnvelope.records["acme/api#1"].status = "waiting";
  remoteStorageListener("tracker", envelope, remoteEnvelope, true);
  assert.equal(shadow.querySelector('textarea[data-focus-id="notes"]'), notes);
  assert.equal(shadow.activeElement, notes);
  assert.equal(notes.value, "ab");
  assert.equal(notes.selectionStart, 2);

  tagInput.focus();
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, composed: true, key: "u" }));
  assert.equal(shadow.activeElement, tagInput);
  tagInput.value = "urgent";
  tagInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  remoteStorageListener("tracker", envelope, remoteEnvelope, true);
  assert.equal(shadow.querySelector('[aria-label="Private label name"]'), tagInput);
  assert.equal(shadow.activeElement, tagInput);
  assert.equal(tagInput.value, "urgent");
  assert.equal(escapedKeydowns, 0);
  assert.deepEqual(removedEditors, []);
  assert.deepEqual(errors, []);
  observer.disconnect();
});

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => body,
    headers: { get: () => "text/html; charset=utf-8" }
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${message}`);
}
