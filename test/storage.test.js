import test from "node:test";
import assert from "node:assert/strict";
import { createStorage } from "../src/storage.js";
import {
  DEFAULT_SORT_PREFERENCES,
  SORT_FIELDS,
  filterSummaries,
  normalizeEnvelope,
  normalizeSortPreferencesForSummaries,
  normalizeTags,
  sortSummaries
} from "../src/models.js";

function makeGm(initialValue = null) {
  let stored = initialValue;
  let nextId = 0;
  const listeners = new Map();
  return {
    gm: {
      getValue: async () => stored,
      setValue: async (_key, value) => {
        stored = value;
      },
      addValueChangeListener: (_key, callback) => {
        const id = nextId++;
        listeners.set(id, callback);
        return id;
      },
      removeValueChangeListener: (id) => listeners.delete(id)
    },
    emitRemote(value) {
      stored = value;
      for (const listener of listeners.values()) {
        listener("key", null, value, true);
      }
    },
    read: () => stored
  };
}

test("normalizeEnvelope namespaces records for account", () => {
  const envelope = normalizeEnvelope({
    records: { "acme/api#1": { status: "next_up" } },
    detailCache: { "acme/api#1": { updatedAt: 4, parserVersion: 2, detail: { checks: "passing" } } }
  }, "octocat");
  assert.equal(envelope.accountLogin, "octocat");
  assert.equal(envelope.records["acme/api#1"].status, "next_up");
  assert.equal(envelope.detailCache["acme/api#1"].parserVersion, 2);
  assert.deepEqual(envelope.sortPreferences, DEFAULT_SORT_PREFERENCES);
});

test("import merges newest modifiedAt without deleting unmatched records", async () => {
  const { gm, read } = makeGm({
    records: {
      "acme/api#1": { status: "waiting", modifiedAt: 30 },
      "acme/api#2": { status: "blocked", modifiedAt: 50 }
    }
  });
  const storage = createStorage(gm, "octocat");
  await storage.importEnvelope({
    accountLogin: "octocat",
    records: {
      "acme/api#1": { status: "done", modifiedAt: 20 },
      "acme/api#3": { status: "next_up", modifiedAt: 70 }
    }
  });
  assert.equal(read().records["acme/api#1"].status, "waiting");
  assert.equal(read().records["acme/api#2"].status, "blocked");
  assert.equal(read().records["acme/api#3"].status, "next_up");
});

test("import rejects a different account login", async () => {
  const { gm } = makeGm({ accountLogin: "octocat", records: {} });
  const storage = createStorage(gm, "octocat");
  await assert.rejects(
    () => storage.importEnvelope({ accountLogin: "someone-else", records: {} }),
    /does not match signed-in account/
  );
});

test("normalizeTags trims names, deduplicates case-insensitively, and defaults colors", () => {
  assert.deepEqual(normalizeTags([{ name: "  Team  ", color: "pink" }, { name: "team", color: "red" }, { name: "", color: "blue" }, { name: "Ops", color: "bad" }]), [
    { name: "Team", color: "pink" },
    { name: "Ops", color: "gray" }
  ]);
});

test("filterSummaries hides done by default and supports recovery", () => {
  const summaries = [
    { key: "acme/api#1", title: "One", repo: "api", number: 1 },
    { key: "acme/api#2", title: "Two", repo: "api", number: 2 }
  ];
  const records = {
    "acme/api#1": { status: "done", blockedBy: "", notes: "", tags: [], modifiedAt: 1 },
    "acme/api#2": { status: "blocked", blockedBy: "CI", notes: "", tags: [], modifiedAt: 1 }
  };
  assert.equal(filterSummaries({ summaries, records, search: "", statusFilter: "all", tagFilter: "", showCompleted: false }).length, 1);
  assert.equal(filterSummaries({ summaries, records, search: "", statusFilter: "all", tagFilter: "", showCompleted: true }).length, 2);
});

test("updateSortPreferences persists normalized preferences", async () => {
  const { gm, read } = makeGm({ accountLogin: "octocat", records: {}, sortPreferences: null });
  const storage = createStorage(gm, "octocat");
  await storage.updateSortPreferences({
    primary: { field: SORT_FIELDS.repository, direction: "asc" },
    secondary: { field: SORT_FIELDS.repository, direction: "desc" }
  });
  assert.deepEqual(read().sortPreferences, {
    primary: { field: SORT_FIELDS.repository, direction: "asc" },
    secondary: { field: SORT_FIELDS.updated, direction: "desc" }
  });
});

test("updateSortPreferences merges a primary-only patch with the current secondary", async () => {
  const { gm, read } = makeGm({
    accountLogin: "octocat",
    records: {},
    sortPreferences: {
      primary: { field: SORT_FIELDS.updated, direction: "desc" },
      secondary: { field: SORT_FIELDS.repository, direction: "asc" }
    }
  });
  const storage = createStorage(gm, "octocat");
  await storage.updateSortPreferences({
    primary: { field: SORT_FIELDS.title, direction: "asc" }
  });
  assert.deepEqual(read().sortPreferences, {
    primary: { field: SORT_FIELDS.title, direction: "asc" },
    secondary: { field: SORT_FIELDS.repository, direction: "asc" }
  });
});

test("normalizeSortPreferencesForSummaries keeps checks available when some states are unknown", () => {
  const normalized = normalizeSortPreferencesForSummaries(
    {
      primary: { field: SORT_FIELDS.checks, direction: "desc" },
      secondary: { field: SORT_FIELDS.updated, direction: "asc" }
    },
    [{ key: "acme/api#1", repo: "api", number: 1, checks: "unknown" }]
  );
  assert.deepEqual(normalized, {
    primary: { field: SORT_FIELDS.checks, direction: "desc" },
    secondary: { field: SORT_FIELDS.updated, direction: "asc" }
  });
});

test("sortSummaries applies primary secondary and deterministic fallback ordering", () => {
  const summaries = [
    { key: "acme/zebra#5", repo: "zebra", number: 5, title: "Gamma", updatedAt: 0, review: "required", checks: "passing" },
    { key: "acme/api#9", repo: "api", number: 9, title: "Alpha", updatedAt: 50, review: "approved", checks: "passing" },
    { key: "acme/api#2", repo: "api", number: 2, title: "Beta", updatedAt: 50, review: "approved", checks: "passing" },
    { key: "acme/core#1", repo: "core", number: 1, title: "Delta", updatedAt: Number.NaN, review: "changes_requested", checks: "failing" }
  ];
  const records = {
    "acme/zebra#5": { status: "waiting" },
    "acme/api#9": { status: "blocked" },
    "acme/api#2": { status: "blocked" },
    "acme/core#1": { status: "next_up" }
  };
  const sorted = sortSummaries({
    summaries,
    records,
    sortPreferences: {
      primary: { field: SORT_FIELDS.updated, direction: "desc" },
      secondary: { field: SORT_FIELDS.status, direction: "desc" }
    }
  });
  assert.deepEqual(sorted.map((summary) => summary.key), [
    "acme/api#2",
    "acme/api#9",
    "acme/zebra#5",
    "acme/core#1"
  ]);
});

test("sortSummaries supports every exposed field and keeps unknown native states last", () => {
  const summaries = [
    { key: "beta/api#2", owner: "beta", repo: "api", number: 2, title: "Alpha", updatedAt: 20, review: "unknown", checks: "unknown" },
    { key: "acme/web#9", owner: "acme", repo: "web", number: 9, title: "Charlie", updatedAt: 30, review: "required", checks: "pending" },
    { key: "acme/api#4", owner: "acme", repo: "api", number: 4, title: "Bravo", updatedAt: 10, review: "approved", checks: "passing" }
  ];
  const records = {
    "beta/api#2": { status: "blocked" },
    "acme/web#9": { status: "next_up" },
    "acme/api#4": { status: "waiting" }
  };
  const cases = [
    [SORT_FIELDS.repository, "asc", ["acme/api#4", "acme/web#9", "beta/api#2"]],
    [SORT_FIELDS.status, "asc", ["acme/web#9", "acme/api#4", "beta/api#2"]],
    [SORT_FIELDS.title, "desc", ["acme/web#9", "acme/api#4", "beta/api#2"]],
    [SORT_FIELDS.number, "desc", ["acme/web#9", "acme/api#4", "beta/api#2"]],
    [SORT_FIELDS.review, "asc", ["acme/api#4", "acme/web#9", "beta/api#2"]],
    [SORT_FIELDS.checks, "desc", ["acme/web#9", "acme/api#4", "beta/api#2"]]
  ];
  for (const [field, direction, expected] of cases) {
    const sorted = sortSummaries({
      summaries,
      records,
      sortPreferences: { primary: { field, direction }, secondary: null }
    });
    assert.deepEqual(sorted.map((summary) => summary.key), expected, `${field} ${direction}`);
  }
  assert.deepEqual(summaries.map((summary) => summary.key), ["beta/api#2", "acme/web#9", "acme/api#4"]);
});
