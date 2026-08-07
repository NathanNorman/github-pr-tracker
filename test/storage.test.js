import test from "node:test";
import assert from "node:assert/strict";
import { createStorage } from "../src/storage.js";
import {
  DEFAULT_FILTER_PREFERENCES,
  DEFAULT_SORT_PREFERENCES,
  SORT_FIELDS,
  filterSummaries,
  groupSummaries,
  normalizeEnvelope,
  normalizeFilterPreferences,
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
    detailCache: {
      "acme/api#1": {
        updatedAt: 4,
        parserVersion: 2,
        detail: { checks: "passing" },
        headSha: "abc123",
        checksUrl: "https://github.toasttab.com/acme/api/commit/abc123/status-details?popover=true"
      }
    }
  }, "octocat");
  assert.equal(envelope.accountLogin, "octocat");
  assert.equal(envelope.records["acme/api#1"].status, "next_up");
  assert.equal(envelope.detailCache["acme/api#1"].parserVersion, 2);
  assert.equal(envelope.detailCache["acme/api#1"].headSha, "abc123");
  assert.deepEqual(envelope.sortPreferences, DEFAULT_SORT_PREFERENCES);
  assert.deepEqual(envelope.filterPreferences, DEFAULT_FILTER_PREFERENCES);
});

test("normalizeFilterPreferences defaults missing and invalid stored values safely", () => {
  assert.deepEqual(normalizeFilterPreferences(null), DEFAULT_FILTER_PREFERENCES);
  assert.deepEqual(normalizeFilterPreferences({
    hideDrafts: "yes",
    repository: "   ",
    review: "stale",
    checks: 7
  }), DEFAULT_FILTER_PREFERENCES);
  assert.deepEqual(normalizeFilterPreferences({
    hideDrafts: true,
    repository: " acme/api ",
    review: "changes_requested",
    checks: "pending"
  }), {
    hideDrafts: true,
    repository: "acme/api",
    review: "changes_requested",
    checks: "pending"
  });
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

test("filterSummaries composes structured filters with the existing view filters", () => {
  const summaries = [
    { key: "acme/api#1", owner: "acme", repo: "api", title: "Target draft", number: 1, draft: true, review: "approved", checks: "passing" },
    { key: "acme/api#2", owner: "acme", repo: "api", title: "Target ready", number: 2, draft: false, review: "approved", checks: "passing" },
    { key: "acme/api#3", owner: "acme", repo: "api", title: "Target unknown draft state", number: 3, review: "approved", checks: "passing" },
    { key: "acme/web#4", owner: "acme", repo: "web", title: "Target other repo", number: 4, draft: false, review: "required", checks: "passing" },
    { key: "acme/api#5", owner: "acme", repo: "api", title: "Unrelated", number: 5, draft: false, review: "approved", checks: "passing" },
    { key: "acme/api#6", owner: "acme", repo: "api", title: "Target done", number: 6, draft: false, review: "approved", checks: "passing" }
  ];
  const makeRecord = (status = "blocked") => ({
    status,
    blockedBy: "CI",
    notes: "target context",
    tags: [{ name: "urgent", color: "red" }],
    modifiedAt: 1
  });
  const records = Object.fromEntries(summaries.map((summary) => [summary.key, makeRecord()]));
  records["acme/api#5"] = { ...makeRecord(), notes: "other context" };
  records["acme/api#6"] = makeRecord("done");

  const filtered = filterSummaries({
    summaries,
    records,
    search: "target",
    statusFilter: "blocked",
    tagFilter: "URGENT",
    showCompleted: false,
    filterPreferences: {
      hideDrafts: true,
      repository: "ACME/API",
      review: "approved",
      checks: "passing"
    }
  });

  assert.deepEqual(filtered.map((summary) => summary.key), ["acme/api#2", "acme/api#3"]);
});

test("filterSummaries treats missing native states as unknown", () => {
  const summaries = [{ key: "acme/api#1", owner: "acme", repo: "api", title: "One", number: 1 }];
  assert.equal(filterSummaries({
    summaries,
    records: {},
    search: "",
    statusFilter: "all",
    tagFilter: "",
    showCompleted: true,
    filterPreferences: { review: "unknown", checks: "unknown" }
  }).length, 1);
});

test("updateFilterPreferences persists normalized preferences", async () => {
  const { gm, read } = makeGm({ accountLogin: "octocat", records: {}, filterPreferences: null });
  const storage = createStorage(gm, "octocat");
  await storage.updateFilterPreferences({
    hideDrafts: true,
    repository: " acme/api ",
    review: "approved",
    checks: "broken"
  });
  assert.deepEqual(read().filterPreferences, {
    hideDrafts: true,
    repository: "acme/api",
    review: "approved",
    checks: "all"
  });
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

test("groupSummaries creates repository sections and preserves the secondary order within each section", () => {
  const summaries = [
    { key: "toasttab/toast-archiving#3", owner: "toasttab", repo: "toast-archiving", number: 3, title: "Archive", updatedAt: 30 },
    { key: "toasttab/toast-analytics#1", owner: "toasttab", repo: "toast-analytics", number: 1, title: "Older", updatedAt: 10 },
    { key: "toasttab/toast-analytics#2", owner: "toasttab", repo: "toast-analytics", number: 2, title: "Newer", updatedAt: 20 }
  ];
  const sortPreferences = {
    primary: { field: SORT_FIELDS.repository, direction: "asc" },
    secondary: { field: SORT_FIELDS.updated, direction: "desc" }
  };
  const sorted = sortSummaries({ summaries, records: {}, sortPreferences });
  const groups = groupSummaries({ summaries: sorted, records: {}, sortPreferences });

  assert.deepEqual(groups.map((group) => [group.label, group.summaries.length]), [
    ["toast-analytics", 2],
    ["toast-archiving", 1]
  ]);
  assert.deepEqual(groups[0].summaries.map((summary) => summary.key), [
    "toasttab/toast-analytics#2",
    "toasttab/toast-analytics#1"
  ]);
});

test("groupSummaries turns an updated primary sort into readable timeframe sections", () => {
  const currentTime = new Date(2026, 7, 7, 16).getTime();
  const startOfToday = new Date(currentTime);
  startOfToday.setHours(0, 0, 0, 0);
  const oneDay = 24 * 60 * 60 * 1000;
  const summaries = [
    { key: "acme/api#1", repo: "api", number: 1, updatedAt: startOfToday.getTime() + 2 * 60 * 60 * 1000 },
    { key: "acme/api#2", repo: "api", number: 2, updatedAt: startOfToday.getTime() - oneDay + 2 * 60 * 60 * 1000 },
    { key: "acme/api#3", repo: "api", number: 3, updatedAt: startOfToday.getTime() - 5 * oneDay },
    { key: "acme/api#4", repo: "api", number: 4, updatedAt: "invalid" }
  ];
  const sortPreferences = {
    primary: { field: SORT_FIELDS.updated, direction: "desc" },
    secondary: { field: SORT_FIELDS.repository, direction: "asc" }
  };
  const sorted = sortSummaries({ summaries, records: {}, sortPreferences });
  const groups = groupSummaries({ summaries: sorted, records: {}, sortPreferences, currentTime });

  assert.deepEqual(groups.map((group) => group.label), [
    "Updated today",
    "Updated yesterday",
    "Updated in the previous 7 days",
    "Update date unavailable"
  ]);
});
