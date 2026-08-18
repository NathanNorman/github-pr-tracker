import test from "node:test";
import assert from "node:assert/strict";
import { buildLifecycleSnapshot, summarizeLifecyclePhases } from "../src/pr-lifecycle.js";
import { parseHtml } from "./helpers.js";

function phase(snapshot, key) {
  return snapshot.phases[key];
}

test("lifecycle survives replay and passing failing passing yields two observed passing intervals", () => {
  const first = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-01T11:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  const replay = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-01T11:00:00.000Z",
    previousLifecycle: first,
    prDocument: parseHtml("<main></main>")
  });
  const failing = buildLifecycleSnapshot({
    summary: { checks: "failing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-01T12:00:00.000Z",
    previousLifecycle: replay,
    prDocument: parseHtml("<main></main>")
  });
  const passingAgain = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-01T13:00:00.000Z",
    previousLifecycle: failing,
    prDocument: parseHtml("<main></main>")
  });

  assert.deepEqual(first, replay);
  assert.equal(phase(passingAgain, "checks_passing").availability, "observed");
  assert.deepEqual(phase(passingAgain, "checks_passing").intervals, [
    {
      startAt: "2026-08-01T11:00:00.000Z",
      endAt: "2026-08-01T12:00:00.000Z",
      ongoing: false
    },
    {
      startAt: "2026-08-01T13:00:00.000Z",
      endAt: "2026-08-01T13:00:00.000Z",
      ongoing: true
    }
  ]);
});

test("discussion open to zero yields an observed resolved interval and no-history stays unavailable", () => {
  const unavailable = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-01T11:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  assert.equal(phase(unavailable, "comments_and_discussions_resolved").availability, "unavailable");

  const open = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 3 },
    observedAt: "2026-08-01T12:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  const resolved = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-01T13:00:00.000Z",
    previousLifecycle: open,
    prDocument: parseHtml("<main></main>")
  });

  assert.equal(phase(resolved, "discussions").current, false);
  assert.equal(phase(resolved, "comments_and_discussions_resolved").availability, "observed");
  assert.deepEqual(phase(resolved, "comments_and_discussions_resolved").intervals, [
    {
      startAt: "2026-08-01T13:00:00.000Z",
      endAt: "2026-08-01T13:00:00.000Z",
      ongoing: true
    }
  ]);
});

test("current draft and merged ready phases are not active or ongoing", () => {
  const currentDraft = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: true },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: true, review: "approved" },
    observedAt: "2026-08-01T11:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  assert.equal(phase(currentDraft, "ready_for_review").current, false);
  assert.equal(phase(currentDraft, "ready_for_review").intervals.length, 0);

  const merged = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-02T11:00:00.000Z",
    prDocument: parseHtml(`
      <div class="TimelineItem" data-merged="true">
        <relative-time datetime="2026-08-02T10:30:00.000Z"></relative-time>
        Merged commit abc into main
      </div>
    `)
  });
  assert.equal(phase(merged, "ready_for_review").current, false);
  assert.equal(phase(merged, "ready_for_review").intervals.every((interval) => !interval.ongoing), true);
});

test("merged closes active observed phases exactly once", () => {
  const open = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "changes_requested", unresolvedThreads: 2 },
    observedAt: "2026-08-02T09:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  const merged = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "changes_requested", unresolvedThreads: 2 },
    observedAt: "2026-08-02T11:00:00.000Z",
    previousLifecycle: open,
    prDocument: parseHtml(`
      <div class="TimelineItem" data-merged="true">
        <relative-time datetime="2026-08-02T10:30:00.000Z"></relative-time>
        Merged commit abc into main
      </div>
    `)
  });
  const replay = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "changes_requested", unresolvedThreads: 2 },
    observedAt: "2026-08-02T11:00:00.000Z",
    previousLifecycle: merged,
    prDocument: parseHtml(`
      <div class="TimelineItem" data-merged="true">
        <relative-time datetime="2026-08-02T10:30:00.000Z"></relative-time>
        Merged commit abc into main
      </div>
    `)
  });

  assert.equal(phase(merged, "checks_passing").current, false);
  assert.equal(phase(merged, "discussions").current, false);
  assert.equal(phase(merged, "changes_requested").current, false);
  assert.equal(phase(merged, "changes_requested").intervals.every((interval) => !interval.ongoing), true);
  assert.deepEqual(phase(merged, "checks_passing").intervals, replay.phases.checks_passing.intervals);
});

test("unknown checks retain prior intervals without counting the unknown gap", () => {
  const passing = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-01T11:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  const unknown = buildLifecycleSnapshot({
    summary: { checks: "unknown", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-01T12:00:00.000Z",
    previousLifecycle: passing,
    prDocument: parseHtml("<main></main>")
  });
  const passingAgain = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-01T13:00:00.000Z",
    previousLifecycle: unknown,
    prDocument: parseHtml("<main></main>")
  });

  assert.deepEqual(phase(unknown, "checks_passing").intervals, [
    {
      startAt: "2026-08-01T11:00:00.000Z",
      endAt: "2026-08-01T11:00:00.000Z",
      ongoing: false
    }
  ]);
  assert.equal(phase(unknown, "checks_passing").availability, "observed");
  assert.match(phase(unknown, "checks_passing").note, /unknown period is not counted/i);
  assert.equal(phase(passingAgain, "checks_passing").intervals.length, 2);
  assert.equal(phase(passingAgain, "checks_passing").intervals[1].startAt, "2026-08-01T13:00:00.000Z");
});

test("overlapping review requests without safe reviewer pairing are not falsely exact", () => {
  const snapshot = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "required" },
    observedAt: "2026-08-02T10:00:00.000Z",
    prDocument: parseHtml(`
      <div class="TimelineItem">
        <relative-time datetime="2026-08-01T12:00:00.000Z"></relative-time>
        Requested review from alex
      </div>
      <div class="TimelineItem">
        <relative-time datetime="2026-08-01T13:00:00.000Z"></relative-time>
        Requested review from sam
      </div>
      <div class="TimelineItem">
        <relative-time datetime="2026-08-01T14:00:00.000Z"></relative-time>
        Removed from review
      </div>
      <div class="TimelineItem">
        <relative-time datetime="2026-08-01T15:00:00.000Z"></relative-time>
        Removed alex from review
      </div>
    `)
  });

  assert.equal(phase(snapshot, "review_requested").availability, "unavailable");
  assert.match(phase(snapshot, "review_requested").note, /reviewer identities clearly enough|overlap/i);
});

test("automatically merged text is not treated as a merge", () => {
  const snapshot = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-02T10:00:00.000Z",
    prDocument: parseHtml(`
      <div>
        This branch can be automatically merged once checks pass.
        <relative-time datetime="2026-08-02T09:00:00.000Z"></relative-time>
      </div>
    `)
  });

  assert.equal(snapshot.mergedAt, "");
  assert.equal(phase(snapshot, "merged").enteredAt, "");
});

test("requested rows include newly opened and comments/discussions resolved", () => {
  const snapshot = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 0 },
    observedAt: "2026-08-02T10:00:00.000Z",
    previousLifecycle: buildLifecycleSnapshot({
      summary: { checks: "passing", draft: false },
      detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved", unresolvedThreads: 2 },
      observedAt: "2026-08-02T09:00:00.000Z",
      prDocument: parseHtml("<main></main>")
    }),
    prDocument: parseHtml(`
      <div class="TimelineItem">
        <relative-time datetime="2026-08-01T11:00:00.000Z"></relative-time>
        Requested review from alex
      </div>
    `)
  });
  const rows = summarizeLifecyclePhases(snapshot);
  assert.ok(rows.some((row) => row.key === "newly_opened"));
  assert.ok(rows.some((row) => row.key === "comments_and_discussions_resolved"));
});

test("unavailable comments render Unavailable", () => {
  const snapshot = buildLifecycleSnapshot({
    summary: { checks: "passing", draft: false },
    detail: { createdAt: "2026-08-01T10:00:00.000Z", draft: false, review: "approved" },
    observedAt: "2026-08-02T10:00:00.000Z",
    prDocument: parseHtml("<main></main>")
  });
  const rows = summarizeLifecyclePhases(snapshot);
  assert.equal(rows.find((row) => row.key === "comments").detail, "Unavailable");
});
