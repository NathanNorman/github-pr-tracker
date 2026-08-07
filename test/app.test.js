import test from "node:test";
import assert from "node:assert/strict";
import { createTrackerApp } from "../src/app.js";
import { DETAIL_PARSER_VERSION } from "../src/constants.js";
import { makeDom, parseHtml } from "./helpers.js";

function makeStorage(seed) {
  let envelope = structuredClone(seed);
  const subscribers = new Set();
  return {
    async load() {
      return structuredClone(envelope);
    },
    async save(nextEnvelope) {
      envelope = structuredClone(nextEnvelope);
      return nextEnvelope;
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    async upsertRecord(key, patch, modifiedAt) {
      envelope.records[key] = { ...(envelope.records[key] || {}), ...patch, modifiedAt };
      for (const callback of subscribers) {
        callback(structuredClone(envelope));
      }
      return envelope;
    },
    async updateSortPreferences(sortPreferences) {
      envelope.sortPreferences = structuredClone(sortPreferences);
      for (const callback of subscribers) {
        callback(structuredClone(envelope));
      }
      return envelope;
    },
    async updateFilterPreferences(filterPreferences) {
      envelope.filterPreferences = structuredClone(filterPreferences);
      for (const callback of subscribers) {
        callback(structuredClone(envelope));
      }
      return envelope;
    },
    async importEnvelope(raw) {
      if (raw.accountLogin && raw.accountLogin !== envelope.accountLogin) {
        throw new Error(`Import account ${raw.accountLogin} does not match signed-in account ${envelope.accountLogin}.`);
      }
      envelope.records = { ...envelope.records, ...raw.records };
      for (const callback of subscribers) {
        callback(structuredClone(envelope));
      }
      return envelope;
    },
    getEnvelope() {
      return envelope;
    }
  };
}

function buildApp({ dom, storage, fetchImpl }) {
  return createTrackerApp({
    doc: dom.window.document,
    win: dom.window,
    fetchImpl,
    parser: (html, url) => parseHtml(html, url),
    storage,
    login: "octocat"
  });
}

function pullsHtml(items) {
  return `<!doctype html><html><body><main>${items
    .map(
      (item) =>
        `<div data-issue-and-pr-hovercards-enabled="true"><a data-hovercard-type="pull_request" href="${item.href}">${item.title}</a>${
          item.draft ? "<span> Draft </span>" : ""
        }</div>`
    )
    .join("")}</main></body></html>`;
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for ${message}.`);
}

test("handleRoute only auto-refreshes once per route entry", async () => {
  const dom = makeDom();
  const storage = makeStorage({ accountLogin: "octocat", records: {}, openListCache: { updatedAt: 1, items: [] }, detailCache: {} });
  let pullFetches = 0;
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls")) {
        pullFetches += 1;
        return { ok: true, text: async () => "<html><body></body></html>" };
      }
      return { ok: true, text: async () => "<html><body></body></html>", headers: { get: () => "text/html" } };
    }
  });
  await app.init();
  await app.handleRoute();
  await app.handleRoute();
  await app.handleRoute();
  assert.equal(pullFetches, 1);
});

test("search and notes keep focus and value across updates", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "blocked", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Fix CI", url: "https://github.toasttab.com/acme/api/pull/1", draft: false }]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([{ href: "/acme/api/pull/1", title: "Fix CI", draft: false }])
          : "<html><body></body></html>"
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const search = shadow.querySelector('input[type="search"]');
  search.focus();
  for (const value of ["C", "CI", "CI "]) {
    search.value = value;
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(shadow.activeElement, search);
    assert.equal(search.value, value);
  }

  shadow.querySelector(".pr-row-select").click();
  const notes = shadow.querySelector("textarea");
  notes.focus();
  for (const value of ["a", "ab", "abc"]) {
    notes.value = value;
    notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(shadow.activeElement, notes);
    assert.equal(notes.value, value);
  }
});

test("pending edits stay keyed to the correct PR and flush on close", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 },
      "acme/api#2": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Two", url: "https://github.toasttab.com/acme/api/pull/2", draft: false }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([
              { href: "/acme/api/pull/1", title: "One", draft: false },
              { href: "/acme/api/pull/2", title: "Two", draft: false }
            ])
          : "<html><body></body></html>"
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const rows = shadow.querySelectorAll(".pr-row-select");
  rows[0].click();
  let notes = shadow.querySelector("textarea");
  notes.value = "alpha";
  notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  rows[1].click();
  notes = shadow.querySelector("textarea");
  notes.value = "beta";
  notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  shadow.querySelector(".drawer .icon-btn").click();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "alpha");
  assert.equal(storage.getEnvelope().records["acme/api#2"].notes, "beta");
});

test("refresh preserves concurrent personal edits made during fetch", async () => {
  const dom = makeDom("https://github.toasttab.com/pulls");
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: { updatedAt: 1, items: [] },
    detailCache: {}
  });
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls")) {
        await gate;
        return {
          ok: true,
          text: async () => '<html><body><div data-issue-and-pr-hovercards-enabled="true"><a data-hovercard-type="pull_request" href="/acme/api/pull/1">One</a></div></body></html>'
        };
      }
      return { ok: true, text: async () => "<html><body></body></html>", headers: { get: () => "text/html" } };
    }
  });
  await app.init();
  dom.window.history.pushState({}, "", "/pulls#pr-tracker");
  const refreshPromise = app.refresh(true);
  await storage.upsertRecord("acme/api#1", { notes: "keep me" }, 99);
  releaseFetch();
  await refreshPromise;
  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "keep me");
});

test("detail refresh invalidates older parser results, merges deferred fields, and preserves the list draft flag", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: { updatedAt: 1, items: [] },
    detailCache: {
      "acme/api#1": {
        updatedAt: Date.now(),
        parserVersion: DETAIL_PARSER_VERSION - 1,
        detail: { review: "required", checks: "failing", merge: "blocked", draft: true }
      }
    }
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes("/pulls")) {
        return {
          ok: true,
          text: async () => pullsHtml([{ href: "/acme/api/pull/1", title: "One", draft: true }])
        };
      }
      if (value.endsWith("/pull/1")) {
        return {
          ok: true,
          text: async () => '<html><body><section data-test-selector="required-review-banner">Approved</section><div data-status-details-url="/acme/api/pull/1/status"></div></body></html>'
        };
      }
      if (value.endsWith("/pull/1/files")) {
        return {
          ok: true,
          text: async () => `
            <div class="js-diff-progressive-container">
              <div class="js-resolvable-timeline-thread-container"><button>Resolve conversation</button></div>
              <div class="js-resolvable-timeline-thread-container"><button>Resolve conversation</button></div>
              <div class="js-resolvable-timeline-thread-container is-resolved"><button>Unresolve conversation</button></div>
            </div>`
        };
      }
      return {
        ok: true,
        json: async () => ({ checks_state: "SUCCESS", mergeStateStatus: "BLOCKED" }),
        headers: { get: () => "application/json" }
      };
    }
  });
  await app.init();
  const summary = app.getState().allSummaries[0];
  assert.equal(summary.review, "approved");
  assert.equal(summary.checks, "passing");
  assert.equal(summary.merge, "blocked");
  assert.equal(summary.draft, true);
  assert.equal(summary.unresolvedThreads, 2);
  assert.equal(storage.getEnvelope().detailCache["acme/api#1"].parserVersion, DETAIL_PARSER_VERSION);
});

test("default sort is updated desc then repository asc with invalid timestamps last", async () => {
  const dom = makeDom("https://github.toasttab.com/pulls");
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    sortPreferences: null,
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/zebra#5", owner: "acme", repo: "zebra", number: 5, title: "Five", url: "https://github.toasttab.com/acme/zebra/pull/5", updatedAt: "2026-08-05T10:00:00Z" },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Two", url: "https://github.toasttab.com/acme/api/pull/2", updatedAt: "2026-08-06T10:00:00Z" },
        { key: "acme/core#1", owner: "acme", repo: "core", number: 1, title: "One", url: "https://github.toasttab.com/acme/core/pull/1", updatedAt: "invalid-date" }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => ({ ok: true, text: async () => "<html><body></body></html>", headers: { get: () => "text/html" } })
  });
  await app.init();
  assert.deepEqual(app.getState().filteredSummaries.map((summary) => summary.key), [
    "acme/api#2",
    "acme/zebra#5",
    "acme/core#1"
  ]);
});

test("sort menu can disable secondary sort and persists null", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    sortPreferences: null,
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Bravo", url: "https://github.toasttab.com/acme/api/pull/2", updatedAt: "2026-08-06T10:00:00Z", review: "approved" },
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Alpha", url: "https://github.toasttab.com/acme/api/pull/1", updatedAt: "2026-08-06T10:00:00Z", review: "approved" }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([
              { href: "/acme/api/pull/2", title: "Bravo", draft: false },
              { href: "/acme/api/pull/1", title: "Alpha", draft: false }
            ])
          : "<html><body></body></html>",
      headers: { get: () => "text/html" }
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const selects = [...shadow.querySelectorAll(".sort-row select")];
  const [primaryField, primaryDirection, secondaryField] = selects;

  assert.equal(primaryField.getAttribute("aria-label"), "Group field");
  assert.equal(primaryDirection.options[0].textContent, "Newest first");
  assert.equal([...secondaryField.options].find((option) => option.value === "updated").disabled, true);

  primaryField.value = "title";
  primaryField.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  primaryDirection.value = "asc";
  primaryDirection.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  secondaryField.value = "none";
  secondaryField.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  assert.equal(storage.getEnvelope().sortPreferences.secondary, null);
  assert.deepEqual(app.getState().filteredSummaries.map((summary) => summary.key), ["acme/api#1", "acme/api#2"]);
});

test("primary repository sorting renders separate sections and secondary updated sorting orders each section", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    sortPreferences: {
      primary: { field: "repository", direction: "asc" },
      secondary: { field: "updated", direction: "desc" }
    },
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "toasttab/toast-archiving#3", owner: "toasttab", repo: "toast-archiving", number: 3, title: "Archive", url: "https://github.toasttab.com/toasttab/toast-archiving/pull/3", updatedAt: 30 },
        { key: "toasttab/toast-analytics#1", owner: "toasttab", repo: "toast-analytics", number: 1, title: "Older", url: "https://github.toasttab.com/toasttab/toast-analytics/pull/1", updatedAt: 10 },
        { key: "toasttab/toast-analytics#2", owner: "toasttab", repo: "toast-analytics", number: 2, title: "Newer", url: "https://github.toasttab.com/toasttab/toast-analytics/pull/2", updatedAt: 20 }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });

  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const groups = [...shadow.querySelectorAll(".pr-group")];

  assert.deepEqual(groups.map((group) => group.querySelector(".pr-group-title").textContent), [
    "toast-analytics",
    "toast-archiving"
  ]);
  assert.equal(groups[0].querySelector(".pr-group-count").textContent, "2");
  assert.deepEqual([...groups[0].querySelectorAll(".pr-row")].map((row) => row.dataset.prKey), [
    "toasttab/toast-analytics#2",
    "toasttab/toast-analytics#1"
  ]);
  assert.match(shadow.querySelector(".sort-summary").textContent, /Group: Repository/);
});

test("filter popover persists structured filters, filters before grouping, and clears them", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    filterPreferences: {
      hideDrafts: false,
      repository: "ACME/API",
      review: "all",
      checks: "all"
    },
    sortPreferences: {
      primary: { field: "repository", direction: "asc" },
      secondary: { field: "updated", direction: "desc" }
    },
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Draft API", url: "https://github.toasttab.com/acme/api/pull/1", draft: true, review: "approved", checks: "passing", updatedAt: 10 },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Ready API", url: "https://github.toasttab.com/acme/api/pull/2", draft: false, review: "approved", checks: "passing", updatedAt: 20 },
        { key: "acme/web#3", owner: "acme", repo: "web", number: 3, title: "Ready Web", url: "https://github.toasttab.com/acme/web/pull/3", draft: false, review: "required", checks: "failing", updatedAt: 30 }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const filterSummary = shadow.querySelector(".filter-summary");
  const hideDrafts = shadow.querySelector('[data-focus-id="filter-hide-drafts"]');
  const repository = shadow.querySelector('[data-focus-id="filter-repository"]');
  const review = shadow.querySelector('[data-focus-id="filter-review"]');
  const checks = shadow.querySelector('[data-focus-id="filter-checks"]');

  assert.equal(filterSummary.textContent, "Filter · 1");
  assert.deepEqual([...repository.options].map((option) => option.value), ["all", "acme/api", "acme/web"]);
  assert.equal(repository.value, "acme/api");

  hideDrafts.checked = true;
  hideDrafts.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  repository.value = "acme/api";
  repository.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  review.value = "approved";
  review.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  checks.value = "passing";
  checks.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(storage.getEnvelope().filterPreferences, {
    hideDrafts: true,
    repository: "acme/api",
    review: "approved",
    checks: "passing"
  });
  assert.equal(filterSummary.textContent, "Filter · 4");
  assert.deepEqual(app.getState().filteredSummaries.map((summary) => summary.key), ["acme/api#2"]);
  assert.deepEqual([...shadow.querySelectorAll(".pr-group-title")].map((node) => node.textContent), ["api"]);

  shadow.querySelector(".clear-filters").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(storage.getEnvelope().filterPreferences, {
    hideDrafts: false,
    repository: "all",
    review: "all",
    checks: "all"
  });
  assert.equal(filterSummary.textContent, "Filter");
  assert.deepEqual([...shadow.querySelectorAll(".pr-group-title")].map((node) => node.textContent), ["api", "web"]);
});

test("invalid nested buttons are avoided and row selection remains keyboard-accessible", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "waiting", blockedBy: "", notes: "", tags: [{ name: "urgent", color: "red" }], modifiedAt: 1 }
    },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false }]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([{ href: "/acme/api/pull/1", title: "One", draft: false }])
          : "<html><body></body></html>"
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  assert.equal(shadow.querySelectorAll("button button").length, 0);
  assert.doesNotMatch(shadow.querySelector(".tracker-root").textContent, /unknown/i);
  const rowButton = shadow.querySelector(".pr-row-select");
  rowButton.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(app.getState().selectedKey, "acme/api#1");
});

test("review and check states render independently on separate status lines", async () => {
  const dom = makeDom();
  const cachedAt = Date.now();
  const items = [
    { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Approved with failing checks", url: "https://github.toasttab.com/acme/api/pull/1", draft: false },
    { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Review needed with passing checks", url: "https://github.toasttab.com/acme/api/pull/2", draft: false }
  ];
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: { updatedAt: cachedAt, items },
    detailCache: {
      "acme/api#1": { updatedAt: cachedAt, parserVersion: DETAIL_PARSER_VERSION, detail: { review: "approved", checks: "failing", merge: "blocked", draft: false } },
      "acme/api#2": { updatedAt: cachedAt, parserVersion: DETAIL_PARSER_VERSION, detail: { review: "required", checks: "passing", merge: "blocked", draft: false } }
    }
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () => String(url).includes("/pulls")
        ? pullsHtml(items.map((item) => ({ href: `/acme/api/pull/${item.number}`, title: item.title, draft: false })))
        : "<html><body></body></html>",
      headers: { get: () => "text/html" }
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const approvedRow = shadow.querySelector('[data-pr-key="acme/api#1"]');
  const neededRow = shadow.querySelector('[data-pr-key="acme/api#2"]');

  assert.equal(approvedRow.querySelector('[data-kind="review"]').textContent, "Review approved");
  assert.equal(approvedRow.querySelector('[data-kind="review"]').dataset.state, "approved");
  assert.equal(approvedRow.querySelector('[data-kind="checks"]').textContent, "Checks failing");
  assert.equal(approvedRow.querySelector('[data-kind="checks"]').dataset.state, "failing");
  assert.equal(neededRow.querySelector('[data-kind="review"]').textContent, "Review needed");
  assert.equal(neededRow.querySelector('[data-kind="review"]').dataset.state, "required");
  assert.equal(neededRow.querySelector('[data-kind="checks"]').textContent, "Checks passing");
  assert.equal(neededRow.querySelector('[data-kind="checks"]').dataset.state, "passing");
  assert.deepEqual(
    [...neededRow.querySelector(".row-status-lines").children].map((node) => node.dataset.kind),
    ["review", "checks"]
  );
  const rowButton = neededRow.querySelector(".pr-row-select");
  assert.equal(rowButton.getAttribute("aria-describedby"), neededRow.querySelector(".row-details").id);
  assert.match(neededRow.querySelector(".row-details").textContent, /Review needed.*Checks passing/s);
});

test("Escape and outside pointer presses dismiss disclosures and the PR panel", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false }]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const filterMenu = shadow.querySelector(".structured-filter-menu");
  const filterSummary = shadow.querySelector(".filter-summary");
  filterMenu.open = true;
  filterSummary.focus();
  filterSummary.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  assert.equal(filterMenu.open, false);
  assert.equal(shadow.activeElement, filterSummary);

  shadow.querySelector(".pr-row-select").click();
  assert.equal(app.getState().selectedKey, "acme/api#1");
  shadow.querySelector(".drawer textarea").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.getState().selectedKey, null);
  assert.equal(shadow.querySelector(".drawer").hidden, true);

  shadow.querySelector(".pr-row-select").click();
  const sortMenu = shadow.querySelector(".sort-menu");
  sortMenu.open = true;
  dom.window.document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, composed: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sortMenu.open, false);
  assert.equal(app.getState().selectedKey, null);
});

test("each row surfaces its unresolved-thread count and a direct GitHub link", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [{
        key: "acme/api#1",
        owner: "acme",
        repo: "api",
        number: 1,
        title: "One",
        url: "https://github.toasttab.com/acme/api/pull/1",
        draft: false,
        unresolvedThreads: 3
      }]
    },
    detailCache: {}
  });
  const app = buildApp({ dom, storage, fetchImpl: async () => { throw new Error("offline"); } });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const openLink = shadow.querySelector(".row-open-link");
  assert.equal(openLink.href, "https://github.toasttab.com/acme/api/pull/1");
  assert.equal(openLink.target, "_blank");
  assert.equal(openLink.rel, "noreferrer");
  assert.equal(openLink.closest("button"), null);
  assert.equal(shadow.querySelector(".thread-count").textContent, "3 unresolved threads");
});

test("eligible PR rows merge directly without selecting the row and prevent duplicate submissions", async () => {
  const dom = makeDom();
  let confirmResult = false;
  let confirmationCount = 0;
  let confirmationMessage = "";
  dom.window.confirm = (message) => {
    confirmationCount += 1;
    confirmationMessage = message;
    return confirmResult;
  };
  const storage = makeStorage({
    accountLogin: "octocat",
    records: { "acme/api#1": { status: "next_up", blockedBy: "", notes: "keep", tags: [], modifiedAt: 1 } },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" }]
    },
    detailCache: { "acme/api#1": { updatedAt: 1, parserVersion: DETAIL_PARSER_VERSION, detail: { merge: "clean" } } }
  });
  let actionPhase = false;
  let releaseMergePage;
  const mergePageGate = new Promise((resolve) => {
    releaseMergePage = resolve;
  });
  const calls = [];
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url, options = {}) => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      calls.push({ url: String(url), options });
      if (options.method === "POST") {
        return { ok: true, status: 200, text: async () => '<span class="State State--merged">Merged</span>' };
      }
      await mergePageGate;
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form action="/acme/api/pull/1/merge" method="post">
            <input type="hidden" name="authenticity_token" value="csrf">
            <input type="hidden" name="head_sha" value="abc123">
            <input name="commit_title" value="One (#1)">
            <textarea name="commit_message">generated body</textarea>
            <input type="hidden" name="do" value="squash">
          </form>`
      };
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const row = shadow.querySelector('[data-pr-key="acme/api#1"]');
  const rowMerge = row.querySelector(".row-merge-action");

  assert.equal(rowMerge.tagName, "BUTTON");
  assert.equal(rowMerge.type, "button");
  assert.equal(rowMerge.classList.contains("merge-action"), true);
  assert.match(rowMerge.textContent, /merge/i);
  assert.match(rowMerge.getAttribute("aria-label"), /acme\/api #1.*empty commit message/i);
  assert.equal(rowMerge.closest(".pr-row-select"), null);
  assert.equal(app.getState().selectedKey, null);
  assert.equal(shadow.querySelector(".drawer").hidden, true);

  rowMerge.click();
  assert.equal(confirmationCount, 1);
  assert.match(confirmationMessage, /acme\/api#1/);
  assert.match(confirmationMessage, /commit message body will be empty/i);
  assert.equal(calls.length, 0);
  assert.equal(app.getState().prAction.pending, false);

  confirmResult = true;
  rowMerge.click();
  await waitFor(() => calls.length === 1, "row merge request");

  const pendingMerge = shadow.querySelector('[data-pr-key="acme/api#1"] .row-merge-action');
  assert.equal(app.getState().selectedKey, null);
  assert.equal(shadow.querySelector(".drawer").hidden, true);
  assert.equal(pendingMerge.textContent, "Merging…");
  assert.equal(pendingMerge.disabled, true);
  pendingMerge.click();
  rowMerge.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(confirmationCount, 2);
  assert.equal(calls.length, 1);

  releaseMergePage();
  await waitFor(() => app.getState().allSummaries.length === 0, "row merge completion");

  assert.equal(calls.length, 2);
  const submission = new URLSearchParams(calls[1].options.body);
  assert.equal(submission.get("do"), "squash");
  assert.equal(submission.get("commit_message"), "");
  assert.equal(storage.getEnvelope().openListCache.items.length, 0);
  assert.equal(storage.getEnvelope().detailCache["acme/api#1"], undefined);
  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "keep");
});

test("a direct row merge preserves the open drawer for a different pull request", async () => {
  const dom = makeDom();
  dom.window.confirm = () => true;
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Ready", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Keep open", url: "https://github.toasttab.com/acme/api/pull/2", draft: false, merge: "blocked" }
      ]
    },
    detailCache: {}
  });
  let actionPhase = false;
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url, options = {}) => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      if (options.method === "POST") {
        return { ok: true, status: 200, text: async () => '<span class="State State--merged">Merged</span>' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form action="/acme/api/pull/1/merge" method="post">
            <input type="hidden" name="authenticity_token" value="csrf">
            <input type="hidden" name="head_sha" value="abc123">
            <input name="commit_title" value="Ready (#1)">
            <textarea name="commit_message"></textarea>
            <input type="hidden" name="do" value="squash">
          </form>`
      };
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector('[data-pr-key="acme/api#2"] .pr-row-select').click();
  shadow.querySelector('[data-pr-key="acme/api#1"] .row-merge-action').click();
  await waitFor(() => app.getState().allSummaries.length === 1, "direct row merge completion");

  assert.equal(app.getState().selectedKey, "acme/api#2");
  assert.equal(shadow.querySelector(".drawer").hidden, false);
  assert.equal(shadow.querySelector(".drawer-identity .title").textContent, "Keep open");
  assert.equal(shadow.querySelector('[data-pr-key="acme/api#1"]'), null);
});

test("row merge actions are hidden for blocked and draft pull requests", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Ready", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Blocked", url: "https://github.toasttab.com/acme/api/pull/2", draft: false, merge: "blocked" },
        { key: "acme/api#3", owner: "acme", repo: "api", number: 3, title: "Draft", url: "https://github.toasttab.com/acme/api/pull/3", draft: true, merge: "clean" },
        { key: "acme/api#4", owner: "acme", repo: "api", number: 4, title: "Conflicting", url: "https://github.toasttab.com/acme/api/pull/4", draft: false, merge: "conflicting" },
        { key: "acme/api#5", owner: "acme", repo: "api", number: 5, title: "Unknown", url: "https://github.toasttab.com/acme/api/pull/5", draft: false, merge: "unknown" }
      ]
    },
    detailCache: {}
  });
  const app = buildApp({ dom, storage, fetchImpl: async () => { throw new Error("offline"); } });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;

  assert.ok(shadow.querySelector('[data-pr-key="acme/api#1"] .row-merge-action'));
  assert.equal(shadow.querySelector('[data-pr-key="acme/api#2"] .row-merge-action'), null);
  assert.equal(shadow.querySelector('[data-pr-key="acme/api#3"] .row-merge-action'), null);
  assert.equal(shadow.querySelector('[data-pr-key="acme/api#4"] .row-merge-action'), null);
  assert.equal(shadow.querySelector('[data-pr-key="acme/api#5"] .row-merge-action'), null);
});

test("a failed direct row merge exposes an alert while the drawer stays closed", async () => {
  const dom = makeDom();
  dom.window.confirm = () => true;
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" }]
    },
    detailCache: {}
  });
  let actionPhase = false;
  let failMerge = true;
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (_url, options = {}) => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      if (failMerge) {
        throw new Error("merge request failed");
      }
      if (options.method === "POST") {
        return { ok: true, status: 200, text: async () => '<span class="State State--merged">Merged</span>' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form action="/acme/api/pull/1/merge" method="post">
            <input type="hidden" name="authenticity_token" value="csrf">
            <input type="hidden" name="head_sha" value="abc123">
            <input name="commit_title" value="One (#1)">
            <textarea name="commit_message">generated body</textarea>
            <input type="hidden" name="do" value="squash">
          </form>`
      };
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".row-merge-action").click();
  await waitFor(() => app.getState().prAction.error, "row merge error");

  const alert = shadow.querySelector('[role="alert"]');
  assert.equal(app.getState().selectedKey, null);
  assert.equal(shadow.querySelector(".drawer").hidden, true);
  assert.ok(alert);
  assert.equal(alert.closest(".drawer"), null);
  assert.match(alert.textContent, /merge request failed/i);
  assert.ok(shadow.querySelector('[data-pr-key="acme/api#1"]'));
  assert.equal(shadow.querySelector(".row-merge-action").disabled, false);

  failMerge = false;
  shadow.querySelector(".row-merge-action").click();
  await waitFor(() => app.getState().allSummaries.length === 0, "row merge retry");
  assert.equal(shadow.querySelector(".warning").hidden, true);
});

test("a failed drawer merge announces the error only once", async () => {
  const dom = makeDom();
  dom.window.confirm = () => true;
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" }]
    },
    detailCache: {}
  });
  let actionPhase = false;
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      throw new Error("drawer merge failed");
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".pr-row-select").click();
  shadow.querySelector(".drawer .merge-action").click();
  await waitFor(() => app.getState().prAction.error, "drawer merge error");

  const visibleAlerts = [...shadow.querySelectorAll('[role="alert"]')].filter((element) => !element.hidden);
  assert.equal(visibleAlerts.length, 1);
  assert.equal(visibleAlerts[0].classList.contains("pr-action-error"), true);
  assert.match(visibleAlerts[0].textContent, /drawer merge failed/i);
});

test("merge action confirms, forces squash with an empty message body, and removes only the open-list item", async () => {
  const dom = makeDom();
  dom.window.confirm = () => true;
  const storage = makeStorage({
    accountLogin: "octocat",
    records: { "acme/api#1": { status: "next_up", blockedBy: "", notes: "keep", tags: [], modifiedAt: 1 } },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "clean" }]
    },
    detailCache: {}
  });
  let actionPhase = false;
  const calls = [];
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url, options = {}) => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      calls.push({ url: String(url), options });
      if (options.method === "POST") {
        return { ok: true, status: 200, text: async () => '<span class="State State--merged">Merged</span>' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form action="/acme/api/pull/1/merge" method="post">
            <input type="hidden" name="authenticity_token" value="csrf">
            <input type="hidden" name="head_sha" value="abc123">
            <input name="commit_title" value="One (#1)">
            <textarea name="commit_message">generated body</textarea>
            <input type="hidden" name="do" value="squash">
          </form>`
      };
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".pr-row-select").click();
  shadow.querySelector(".drawer .merge-action").click();
  await waitFor(() => app.getState().allSummaries.length === 0, "merge completion");

  assert.equal(calls.length, 2);
  assert.match(calls[1].options.body, /commit_message=&do=squash/);
  assert.equal(storage.getEnvelope().openListCache.items.length, 0);
  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "keep");
});

test("close action accepts an optional comment and removes the closed PR", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false, merge: "blocked" }]
    },
    detailCache: {}
  });
  let actionPhase = false;
  const calls = [];
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url, options = {}) => {
      if (!actionPhase) {
        throw new Error("offline");
      }
      calls.push({ url: String(url), options });
      if (options.method === "POST") {
        return { ok: true, status: 200, text: async () => '<span class="State State--closed">Closed</span>' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form action="/acme/api/pull/1/comment?sticky=true" method="post">
            <input type="hidden" name="authenticity_token" value="csrf">
            <textarea name="comment[body]"></textarea>
            <button name="comment_and_close" value="1">Close with comment</button>
          </form>`
      };
    }
  });
  await app.init();
  actionPhase = true;
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".pr-row-select").click();
  assert.equal(shadow.querySelector(".merge-action"), null);
  shadow.querySelector(".close-action").click();
  const comment = shadow.querySelector(".close-comment");
  comment.value = "Superseded by #2";
  comment.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  shadow.querySelector(".close-confirm").click();
  await waitFor(() => app.getState().allSummaries.length === 0, "close completion");

  assert.equal(calls.length, 2);
  assert.match(calls[1].options.body, /comment%5Bbody%5D=Superseded\+by\+%232/);
  assert.match(calls[1].options.body, /comment_and_close=1/);
});

test("personal status can be changed directly from a PR row", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false }]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([{ href: "/acme/api/pull/1", title: "One", draft: false }])
          : "<html><body></body></html>"
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  const select = shadow.querySelector(".quick-status .status-select");
  select.value = "blocked";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(storage.getEnvelope().records["acme/api#1"].status, "blocked");
  assert.equal(app.getState().selectedKey, "acme/api#1");
  assert.equal(shadow.querySelector(".drawer").hidden, false);
  assert.equal(shadow.querySelector('[data-focus-id="blockedBy"]').hidden, false);
});

test("import errors surface as warnings", async () => {
  const dom = makeDom();
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: { updatedAt: 1, items: [] },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => ({ ok: true, text: async () => "<html><body></body></html>" })
  });
  await app.init();
  await app.importFromText("{bad json");
  assert.match(app.getState().warning, /Import failed/);
  await app.importFromText(JSON.stringify({ accountLogin: "other", records: {} }));
  assert.match(app.getState().warning, /does not match signed-in account/i);
});

test("awaited export flush includes the latest pending note", async () => {
  const dom = makeDom();
  let exportedJson = null;
  dom.window.URL.createObjectURL = () => "blob:test";
  dom.window.URL.revokeObjectURL = () => {};
  const originalCreateElement = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tagName) => {
    const element = originalCreateElement(tagName);
    if (tagName === "a") {
      element.click = () => {
        exportedJson = element.href;
      };
    }
    return element;
  };

  const storage = makeStorage({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "unsorted", blockedBy: "", notes: "", tags: [], modifiedAt: 1 }
    },
    openListCache: {
      updatedAt: 1,
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.toasttab.com/acme/api/pull/1", draft: false }]
    },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async (url) => ({
      ok: true,
      text: async () =>
        String(url).includes("/pulls")
          ? pullsHtml([{ href: "/acme/api/pull/1", title: "One", draft: false }])
          : "<html><body></body></html>"
    })
  });
  await app.init();
  const shadow = dom.window.document.querySelector("#tm-pr-tracker-root").shadowRoot;
  shadow.querySelector(".pr-row-select").click();
  const notes = shadow.querySelector("textarea");
  notes.value = "flush me";
  notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await app.exportData();
  const envelope = await storage.load();
  assert.equal(envelope.records["acme/api#1"].notes, "flush me");
  assert.equal(exportedJson, "blob:test");
});

test("unmount restores original hidden state exactly", async () => {
  const dom = makeDom();
  const main = dom.window.document.querySelector("main");
  const layout = dom.window.document.createElement("div");
  layout.style.display = "grid";
  layout.style.gridTemplateColumns = "minmax(0, 1fr) 320px";
  const sidebar = dom.window.document.createElement("aside");
  sidebar.textContent = "Native GitHub sidebar";
  const githubHeader = dom.window.document.createElement("header");
  githubHeader.setAttribute("role", "banner");
  githubHeader.textContent = "Native GitHub header";
  dom.window.document.body.insertBefore(layout, main);
  layout.append(githubHeader, main, sidebar);
  const hiddenChild = dom.window.document.createElement("div");
  hiddenChild.id = "was-hidden";
  hiddenChild.hidden = true;
  main.append(hiddenChild);
  const storage = makeStorage({
    accountLogin: "octocat",
    records: {},
    openListCache: { updatedAt: 1, items: [] },
    detailCache: {}
  });
  const app = buildApp({
    dom,
    storage,
    fetchImpl: async () => ({ ok: true, text: async () => "<html><body></body></html>" })
  });
  await app.init();
  assert.equal(sidebar.hidden, true);
  assert.equal(githubHeader.hidden, false);
  assert.equal(main.style.gridColumn, "1 / -1");
  dom.window.history.pushState({}, "", "/pulls");
  await app.handleRoute();
  assert.equal(hiddenChild.hidden, true);
  assert.equal(sidebar.hidden, false);
  assert.equal(githubHeader.hidden, false);
  assert.equal(main.getAttribute("style"), null);
  assert.equal(layout.style.gridTemplateColumns, "minmax(0, 1fr) 320px");
});
