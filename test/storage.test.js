import test from "node:test";
import assert from "node:assert/strict";
import { createStorage } from "../src/storage.js";
import { filterSummaries, normalizeEnvelope, normalizeTags } from "../src/models.js";

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
