import test from "node:test";
import assert from "node:assert/strict";
import { createTrackerApp } from "../src/app.js";
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
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "Fix CI", url: "https://github.com/acme/api/pull/1", draft: false }]
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
        { key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.com/acme/api/pull/1", draft: false },
        { key: "acme/api#2", owner: "acme", repo: "api", number: 2, title: "Two", url: "https://github.com/acme/api/pull/2", draft: false }
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
  shadow.querySelector(".drawer .action-btn").click();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "alpha");
  assert.equal(storage.getEnvelope().records["acme/api#2"].notes, "beta");
});

test("refresh preserves concurrent personal edits made during fetch", async () => {
  const dom = makeDom("https://github.com/pulls");
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
  dom.window.history.pushState({}, "", "/pulls?pr_tracker=1");
  const refreshPromise = app.refresh(true);
  await storage.upsertRecord("acme/api#1", { notes: "keep me" }, 99);
  releaseFetch();
  await refreshPromise;
  assert.equal(storage.getEnvelope().records["acme/api#1"].notes, "keep me");
});

test("detail refresh merges deferred fields and preserves list draft flag", async () => {
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
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.com/acme/api/pull/1", draft: false }]
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
  const rowButton = shadow.querySelector(".pr-row-select");
  rowButton.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(app.getState().selectedKey, "acme/api#1");
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
      items: [{ key: "acme/api#1", owner: "acme", repo: "api", number: 1, title: "One", url: "https://github.com/acme/api/pull/1", draft: false }]
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
  const hiddenChild = dom.window.document.createElement("div");
  hiddenChild.id = "was-hidden";
  hiddenChild.hidden = true;
  dom.window.document.querySelector("main").append(hiddenChild);
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
  dom.window.history.pushState({}, "", "/pulls");
  await app.handleRoute();
  assert.equal(hiddenChild.hidden, true);
});
