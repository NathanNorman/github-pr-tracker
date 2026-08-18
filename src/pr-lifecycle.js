const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const LIFECYCLE_VERSION = 2;

const TIMELINE_EVENT_PATTERNS = Object.freeze([
  {
    type: "draft_entered",
    pattern: /\b(?:converted to draft|converted this pull request to draft|marked this pull request as draft|marked as draft)\b/i
  },
  {
    type: "ready_for_review",
    pattern: /\bready for review\b/i
  },
  {
    type: "review_requested",
    pattern: /\brequested review from\b/i
  },
  {
    type: "review_request_removed",
    pattern: /\bremoved\b.{0,120}\bfrom review\b/i
  },
  {
    type: "changes_requested",
    pattern: /\b(?:requested changes|changes requested)\b/i
  },
  {
    type: "review_approved",
    pattern: /\b(?:approved these changes|review approved)\b/i
  }
]);

export const LIFECYCLE_PHASE_ORDER = Object.freeze([
  "open",
  "draft",
  "newly_opened",
  "ready_for_review",
  "review_requested",
  "checks_passing",
  "comments",
  "changes_requested",
  "discussions",
  "comments_and_discussions_resolved",
  "merged"
]);

export function buildLifecycleSnapshot({
  summary = {},
  detail = {},
  prDocument,
  observedAt,
  previousLifecycle = null
}) {
  const previous = normalizePreviousLifecycle(previousLifecycle);
  const observedAtIso = normalizeObservationTimestamp(observedAt, previous?.observedAt);
  const createdAt = normalizeTimestamp(detail.createdAt || previous?.createdAt);
  const timelineEvents = parseTimelineEvents(prDocument);
  const mergedAt = parseMergedAt(prDocument, timelineEvents);
  const terminalAt = mergedAt || observedAtIso;
  const isMerged = Boolean(mergedAt);
  const draftActive = typeof detail.draft === "boolean" ? detail.draft : Boolean(summary.draft);
  const unresolvedThreads = Number.isInteger(detail.unresolvedThreads) ? detail.unresolvedThreads : null;
  const checksPassingActive = summary.checks === "passing";
  const changesRequestedActive = detail.review === "changes_requested";

  const exactDraftPhase = createdAt
    ? deriveExactBooleanPhase({
        key: "draft",
        createdAt,
        terminalAt,
        currentActive: draftActive,
        events: timelineEvents
          .filter((event) => event.type === "draft_entered" || event.type === "ready_for_review")
          .map((event) => ({
            timestamp: event.timestamp,
            activeAfter: event.type === "draft_entered"
          })),
        isTerminal: isMerged
      })
    : unavailableDurationPhase("draft", "Draft timing requires a PR creation timestamp.");

  const draftPhase = exactDraftPhase.availability === "exact"
    ? exactDraftPhase
    : deriveObservedBooleanPhase({
        key: "draft",
        currentActive: draftActive,
        observedAt: observedAtIso,
        previousPhase: previous?.phases?.draft,
        previousObservedAt: previous?.observedAt,
        terminalAt,
        note: "Draft timing is bounded by refresh observations because GitHub did not expose full draft history."
      });

  const openPhase = createdAt && terminalAt
    ? durationPhaseFromIntervals("open", [{
        startAt: createdAt,
        endAt: terminalAt,
        ongoing: !isMerged
      }], {
        availability: "exact",
        current: !isMerged,
        note: isMerged
          ? "Merged PRs close the open interval at merge time."
          : "Open intervals stop at the stored observation time."
      })
    : unavailableDurationPhase("open", "Open timing requires a PR creation timestamp.");

  const readyForReviewPhase = createdAt && draftPhase.availability === "exact"
    ? buildReadyForReviewPhase({
        createdAt,
        terminalAt,
        draftIntervals: draftPhase.intervals,
        currentDraft: draftActive,
        isMerged
      })
    : deriveObservedBooleanPhase({
        key: "ready_for_review",
        currentActive: !draftActive,
        observedAt: observedAtIso,
        previousPhase: previous?.phases?.ready_for_review,
        previousObservedAt: previous?.observedAt,
        terminalAt,
        note: "Ready-for-review time is bounded by refresh observations because exact draft history is unavailable."
      });

  const changesRequestedExactPhase = createdAt
    ? deriveExactBooleanPhase({
        key: "changes_requested",
        createdAt,
        terminalAt,
        currentActive: changesRequestedActive,
        events: timelineEvents
          .filter((event) => event.type === "changes_requested" || event.type === "review_approved")
          .map((event) => ({
            timestamp: event.timestamp,
            activeAfter: event.type === "changes_requested"
          })),
        isTerminal: isMerged,
        note: "Derived from explicit review-decision events only."
      })
    : unavailableDurationPhase("changes_requested", "Changes-requested timing requires a PR creation timestamp.");

  const changesRequestedPhase = changesRequestedExactPhase.availability === "exact"
    ? changesRequestedExactPhase
    : deriveObservedBooleanPhase({
        key: "changes_requested",
        currentActive: changesRequestedActive,
        observedAt: observedAtIso,
        previousPhase: previous?.phases?.changes_requested,
        previousObservedAt: previous?.observedAt,
        terminalAt,
        note: "Changes-requested timing is bounded by refresh observations because GitHub did not expose a complete explicit review history."
      });

  const reviewRequestedPhase = deriveReviewRequestedPhase(timelineEvents);
  const commentsPhase = buildCommentsPhase(prDocument);
  const discussionsPhase = deriveObservedDiscussionPhase({
    currentCount: unresolvedThreads,
    observedAt: observedAtIso,
    previousPhase: previous?.phases?.discussions,
    previousObservedAt: previous?.observedAt,
    terminalAt
  });
  const resolvedConversationsPhase = deriveResolvedDiscussionsPhase({
    currentCount: unresolvedThreads,
    observedAt: observedAtIso,
    previousPhase: previous?.phases?.comments_and_discussions_resolved,
    previousObservedAt: previous?.observedAt,
    previousDiscussionsPhase: previous?.phases?.discussions,
    currentDiscussionsPhase: discussionsPhase,
    terminalAt
  });
  const checksPassingPhase = deriveObservedBooleanPhase({
    key: "checks_passing",
    currentActive: checksPassingActive,
    observedAt: observedAtIso,
    previousPhase: previous?.phases?.checks_passing,
    previousObservedAt: previous?.observedAt,
    terminalAt,
    unavailableWhenUnknown: summary.checks === "unknown",
    note: "Checks-passing time is bounded by refresh observations."
  });
  const newlyOpenedPhase = deriveNewlyOpenedPhase({
    createdAt,
    terminalAt,
    exactDraftPhase: draftPhase,
    reviewRequestedPhase,
    changesRequestedExactPhase,
    commentsPhase,
    isMerged
  });

  return {
    version: LIFECYCLE_VERSION,
    observedAt: observedAtIso,
    createdAt,
    terminalAt,
    mergedAt,
    phases: {
      open: openPhase,
      draft: draftPhase,
      newly_opened: newlyOpenedPhase,
      ready_for_review: readyForReviewPhase,
      review_requested: reviewRequestedPhase,
      checks_passing: checksPassingPhase,
      comments: commentsPhase,
      changes_requested: changesRequestedPhase,
      discussions: discussionsPhase,
      comments_and_discussions_resolved: resolvedConversationsPhase,
      merged: terminalPhase("merged", mergedAt)
    }
  };
}

export function summarizeLifecyclePhases(lifecycle) {
  const phases = lifecycle?.phases || {};
  return LIFECYCLE_PHASE_ORDER
    .map((key) => summarizeLifecyclePhase(key, phases[key]))
    .filter(Boolean);
}

function summarizeLifecyclePhase(key, phase) {
  if (!phase) {
    return null;
  }
  const labels = {
    open: "Open",
    draft: "Draft",
    newly_opened: "Newly opened",
    ready_for_review: "Ready",
    review_requested: "Review requested",
    checks_passing: "Checks",
    comments: "Comments",
    changes_requested: "Changes requested",
    discussions: "Discussions",
    comments_and_discussions_resolved: "Comments/discussions resolved",
    merged: "Merged"
  };
  const label = labels[key] || key;
  if (phase.kind === "duration") {
    if (phase.availability === "unavailable") {
      return { key, label, detail: "Unavailable", note: phase.note || "" };
    }
    const suffix = phase.current ? "active" : "total";
    return {
      key,
      label,
      detail: `${formatDuration(phase.totalMs)} ${suffix}`,
      note: phase.note || ""
    };
  }
  if (phase.kind === "event") {
    if (phase.availability === "unavailable") {
      return { key, label, detail: "Unavailable", note: phase.note || "" };
    }
    if (!phase.count) {
      return { key, label, detail: "None seen", note: phase.note || "" };
    }
    return {
      key,
      label,
      detail: `${phase.count} issue comment${phase.count === 1 ? "" : "s"}`,
      note: phase.latestAt ? `Latest ${formatTimestamp(phase.latestAt)}` : phase.note || ""
    };
  }
  if (phase.kind === "terminal") {
    return phase.enteredAt
      ? { key, label, detail: formatTimestamp(phase.enteredAt), note: phase.note || "" }
      : { key, label, detail: "Not merged", note: phase.note || "" };
  }
  return null;
}

function deriveExactBooleanPhase({ key, createdAt, terminalAt, currentActive, events, isTerminal = false, note = "" }) {
  if (!createdAt || !terminalAt) {
    return unavailableDurationPhase(key, "This phase requires created and observation timestamps.");
  }
  const filteredEvents = [...(events || [])]
    .filter((event) => event.timestamp >= createdAt && event.timestamp <= terminalAt)
    .sort((left, right) => compareTimestamps(left.timestamp, right.timestamp));
  if (!filteredEvents.length) {
    return unavailableDurationPhase(
      key,
      "Exact timing requires explicit GitHub transition events; the current state alone is not historical evidence."
    );
  }
  const initialActive = inferInitialBooleanState(currentActive, filteredEvents);
  if (initialActive === null) {
    return unavailableDurationPhase(
      key,
      "GitHub exposed partial transition history, so exact intervals would be fabricated."
    );
  }

  const intervals = [];
  let active = initialActive;
  let intervalStart = active ? createdAt : "";

  for (const event of filteredEvents) {
    if (active && !event.activeAfter) {
      intervals.push({
        startAt: intervalStart,
        endAt: event.timestamp,
        ongoing: false
      });
      intervalStart = "";
    } else if (!active && event.activeAfter) {
      intervalStart = event.timestamp;
    }
    active = event.activeAfter;
  }

  if (active) {
    intervals.push({
      startAt: intervalStart || createdAt,
      endAt: terminalAt,
      ongoing: false
    });
  }

  return durationPhaseFromIntervals(key, intervals, {
    availability: "exact",
    current: active && !isTerminal,
    note
  });
}

function buildReadyForReviewPhase({ createdAt, terminalAt, draftIntervals, currentDraft, isMerged }) {
  const intervals = [];
  let cursor = createdAt;
  const sortedDraftIntervals = [...(draftIntervals || [])].sort((left, right) => compareTimestamps(left.startAt, right.startAt));
  for (const interval of sortedDraftIntervals) {
    if (interval.startAt > cursor) {
      intervals.push({
        startAt: cursor,
        endAt: interval.startAt,
        ongoing: false
      });
    }
    cursor = maxTimestamp(cursor, interval.endAt);
  }
  if (cursor < terminalAt) {
    intervals.push({
      startAt: cursor,
      endAt: terminalAt,
      ongoing: false
    });
  }
  const current = !isMerged && !currentDraft && intervals.length > 0 && intervals.at(-1).endAt === terminalAt;
  return durationPhaseFromIntervals("ready_for_review", intervals, {
    availability: "exact",
    current,
    note: "Ready-for-review is the exact non-draft portion of the PR lifetime."
  });
}

function deriveObservedBooleanPhase({
  key,
  currentActive,
  observedAt,
  previousPhase,
  previousObservedAt,
  terminalAt,
  unavailableWhenUnknown = false,
  note = ""
}) {
  if (!observedAt || unavailableWhenUnknown) {
    const prior = normalizeDurationPhase(previousPhase, key);
    if (!prior) {
      return unavailableDurationPhase(key, note || "This signal is unavailable for the current snapshot.");
    }
    const intervals = normalizeIntervals(prior.intervals);
    const lastKnownAt = normalizeTimestamp(previousObservedAt) || intervals.at(-1)?.endAt || "";
    if (prior.current && lastKnownAt) {
      closeLastInterval(intervals, lastKnownAt);
    }
    return durationPhaseFromIntervals(key, intervals, {
      availability: "observed",
      current: false,
      note: `${note || "This signal is unavailable for the current snapshot."} Prior observed history was retained; the unknown period is not counted.`
    });
  }

  const prior = normalizeDurationPhase(previousPhase, key);
  if (prior && previousObservedAt === observedAt) {
    if (terminalAt && terminalAt !== observedAt) {
      return closeDurationAtTerminal(prior, terminalAt);
    }
    return prior;
  }

  const intervals = normalizeIntervals(prior?.intervals || []);
  const previousCurrent = Boolean(prior?.current);
  const current = terminalAt === observedAt ? currentActive : false;

  if (previousCurrent && !currentActive) {
    closeLastInterval(intervals, terminalAt === observedAt ? observedAt : terminalAt);
  } else if (!previousCurrent && currentActive) {
    intervals.push({
      startAt: observedAt,
      endAt: terminalAt === observedAt ? observedAt : terminalAt,
      ongoing: false
    });
  } else if (previousCurrent && currentActive) {
    extendLastInterval(intervals, terminalAt === observedAt ? observedAt : terminalAt, current);
  } else if (!prior && currentActive) {
    intervals.push({
      startAt: observedAt,
      endAt: terminalAt === observedAt ? observedAt : terminalAt,
      ongoing: false
    });
  }

  if (current && intervals.length) {
    intervals[intervals.length - 1].endAt = observedAt;
    intervals[intervals.length - 1].ongoing = true;
  }

  return durationPhaseFromIntervals(key, intervals, {
    availability: "observed",
    current,
    note
  });
}

function deriveObservedDiscussionPhase({ currentCount, observedAt, previousPhase, previousObservedAt, terminalAt }) {
  if (!observedAt || currentCount === null) {
    return unavailableDurationPhase("discussions", "Discussion timing is unavailable for this snapshot.");
  }
  const phase = deriveObservedBooleanPhase({
    key: "discussions",
    currentActive: currentCount > 0,
    observedAt,
    previousPhase,
    previousObservedAt,
    terminalAt,
    note: "Discussion-open time is bounded by refresh observations."
  });
  phase.count = currentCount;
  return phase;
}

function deriveResolvedDiscussionsPhase({
  currentCount,
  observedAt,
  previousPhase,
  previousObservedAt,
  previousDiscussionsPhase,
  currentDiscussionsPhase,
  terminalAt
}) {
  const hasPriorDiscussionHistory = Boolean(previousDiscussionsPhase?.intervals?.length) ||
    Boolean(currentDiscussionsPhase?.intervals?.length) ||
    Boolean(previousDiscussionsPhase?.current);
  if (!observedAt || currentCount === null || !hasPriorDiscussionHistory) {
    return unavailableDurationPhase(
      "comments_and_discussions_resolved",
      "Discussion-resolution time is unavailable until review-thread activity has been observed."
    );
  }
  return deriveObservedBooleanPhase({
    key: "comments_and_discussions_resolved",
    currentActive: currentCount === 0,
    observedAt,
    previousPhase,
    previousObservedAt,
    terminalAt,
    note: "Resolved-discussion time is bounded by refresh observations after discussions have been seen."
  });
}

function deriveReviewRequestedPhase(events) {
  const requestEvents = events.filter((event) => event.type === "review_requested");
  if (!requestEvents.length) {
    return unavailableDurationPhase(
      "review_requested",
      "Review-request timing is only shown when GitHub exposes explicit request events."
    );
  }

  const sortedEvents = events
    .filter((event) => event.type === "review_requested" || event.type === "review_request_removed")
    .sort((left, right) => compareTimestamps(left.timestamp, right.timestamp));

  const outstanding = new Set();
  const intervals = [];
  let intervalStart = "";

  for (const event of sortedEvents) {
    const target = parseReviewRequestTarget(event.text);
    if (!target) {
      return unavailableDurationPhase(
        "review_requested",
        "Review-request events were seen, but GitHub did not expose reviewer identities clearly enough to pair overlaps safely."
      );
    }

    if (event.type === "review_requested") {
      const wasEmpty = outstanding.size === 0;
      if (outstanding.has(target)) {
        return unavailableDurationPhase(
          "review_requested",
          "Review-request events overlap ambiguously, so exact outstanding-request time would be fabricated."
        );
      }
      outstanding.add(target);
      if (wasEmpty) {
        intervalStart = event.timestamp;
      }
      continue;
    }

    if (!outstanding.has(target)) {
      return unavailableDurationPhase(
        "review_requested",
        "Review-request removals did not match the outstanding reviewer set, so exact durations are unavailable."
      );
    }
    outstanding.delete(target);
    if (outstanding.size === 0 && intervalStart) {
      intervals.push({
        startAt: intervalStart,
        endAt: event.timestamp,
        ongoing: false
      });
      intervalStart = "";
    }
  }

  if (outstanding.size > 0) {
    return unavailableDurationPhase(
      "review_requested",
      `${requestEvents.length} explicit request event${requestEvents.length === 1 ? "" : "s"} were seen, but GitHub did not expose enough removal history to close them exactly.`
    );
  }

  return durationPhaseFromIntervals("review_requested", intervals, {
    availability: "exact",
    current: false,
    note: "Only explicit request/remove events count; reviewer presence alone is not treated as historical truth."
  });
}

function deriveNewlyOpenedPhase({
  createdAt,
  terminalAt,
  exactDraftPhase,
  reviewRequestedPhase,
  changesRequestedExactPhase,
  commentsPhase,
  isMerged
}) {
  if (!createdAt || exactDraftPhase.availability !== "exact") {
    return unavailableDurationPhase(
      "newly_opened",
      "Newly-opened timing requires exact draft history and a PR creation timestamp."
    );
  }

  const firstReadyStart = firstNonDraftStart(createdAt, exactDraftPhase.intervals);
  if (!firstReadyStart) {
    return unavailableDurationPhase(
      "newly_opened",
      "Newly-opened timing is unavailable while the PR has only been observed as draft."
    );
  }

  const firstReviewActivity = [
    reviewRequestedPhase.availability === "exact" ? reviewRequestedPhase.intervals[0]?.startAt : "",
    changesRequestedExactPhase.availability === "exact" ? changesRequestedExactPhase.intervals[0]?.startAt : "",
    commentsPhase.availability !== "unavailable" ? commentsPhase.firstAt : ""
  ].filter(Boolean).sort(compareTimestamps)[0] || "";

  if (!firstReviewActivity) {
    return unavailableDurationPhase(
      "newly_opened",
      "Newly-opened timing is unavailable until explicit review activity is visible."
    );
  }

  const endAt = minTimestamp(firstReviewActivity, terminalAt);
  return durationPhaseFromIntervals("newly_opened", [{
    startAt: firstReadyStart,
    endAt,
    ongoing: false
  }], {
    availability: "exact",
    current: false,
    note: isMerged
      ? "Newly-opened is the initial non-draft interval before explicit review activity."
      : "Newly-opened ends at the first explicit review activity."
  });
}

function buildCommentsPhase(doc) {
  const comments = [];
  const commentSelectors = [
    '[data-comment-type="issue"]',
    '.timeline-comment-group[data-comment-type="issue"]',
    '.js-comment-container[data-comment-type="issue"]'
  ];
  for (const selector of commentSelectors) {
    for (const node of doc?.querySelectorAll?.(selector) || []) {
      const timestamp = normalizeTimestamp(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
      if (timestamp) {
        comments.push(timestamp);
      }
    }
  }
  const uniqueComments = [...new Set(comments)].sort(compareTimestamps);
  return {
    key: "comments",
    kind: "event",
    availability: uniqueComments.length ? "exact" : "unavailable",
    count: uniqueComments.length,
    firstAt: uniqueComments[0] || "",
    latestAt: uniqueComments.at(-1) || "",
    note: uniqueComments.length
      ? "Issue comments are counted separately from review decisions and review threads."
      : "Issue-comment timing is unavailable in the current snapshot markup."
  };
}

function terminalPhase(key, enteredAt) {
  return {
    key,
    kind: "terminal",
    availability: enteredAt ? "exact" : "snapshot_only",
    enteredAt: enteredAt || "",
    note: enteredAt ? "Merged is terminal." : "Open PRs have not entered the merged phase."
  };
}

function durationPhaseFromIntervals(key, intervals, { availability = "exact", current = false, note = "" } = {}) {
  const normalizedIntervals = normalizeIntervals(intervals).map((interval, index, source) => ({
    ...interval,
    ongoing: Boolean(current && index === source.length - 1)
  }));
  return {
    key,
    kind: "duration",
    availability,
    current,
    intervals: normalizedIntervals,
    totalMs: normalizedIntervals.reduce(
      (total, interval) => total + Math.max(0, Date.parse(interval.endAt) - Date.parse(interval.startAt)),
      0
    ),
    note
  };
}

function unavailableDurationPhase(key, note) {
  return {
    key,
    kind: "duration",
    availability: "unavailable",
    current: false,
    intervals: [],
    totalMs: 0,
    note
  };
}

function parseTimelineEvents(doc) {
  const events = [];
  for (const relativeTime of doc?.querySelectorAll?.("relative-time[datetime]") || []) {
    const timestamp = normalizeTimestamp(relativeTime.getAttribute("datetime"));
    if (!timestamp) {
      continue;
    }
    const scope = relativeTime.closest(
      ".TimelineItem, .js-timeline-item, .timeline-comment-group, .discussion-item, article, li, details, div"
    ) || relativeTime.parentElement;
    const text = normalizeWhitespace(scope?.textContent || "");
    for (const { type, pattern } of TIMELINE_EVENT_PATTERNS) {
      if (pattern.test(text)) {
        events.push({ type, timestamp, text });
      }
    }
  }
  return dedupeTimelineEvents(events);
}

function dedupeTimelineEvents(events) {
  const deduped = [];
  const seen = new Set();
  for (const event of events.sort((left, right) => compareTimestamps(left.timestamp, right.timestamp))) {
    const key = `${event.type}:${event.timestamp}:${event.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function parseMergedAt(doc, events) {
  for (const node of doc?.querySelectorAll?.("[data-merged='true'], [data-is-merged='true']") || []) {
    const timestamp = normalizeTimestamp(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
    if (timestamp) {
      return timestamp;
    }
  }
  for (const event of events || []) {
    if (/\bmerged commit\b/i.test(event.text) || /\bmerged this pull request\b/i.test(event.text)) {
      return event.timestamp;
    }
  }
  for (const node of doc?.querySelectorAll?.(".TimelineItem, .discussion-item, article, li") || []) {
    const text = normalizeWhitespace(node.textContent || "");
    if (!(/\bmerged commit\b/i.test(text) || /\bmerged this pull request\b/i.test(text))) {
      continue;
    }
    const timestamp = normalizeTimestamp(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
    if (timestamp) {
      return timestamp;
    }
  }
  return "";
}

function parseReviewRequestTarget(text) {
  const normalized = normalizeWhitespace(text);
  const requestMatch = normalized.match(/\brequested review from\s+(.+?)(?:\.|$)/i);
  if (requestMatch) {
    return requestMatch[1].trim().toLowerCase();
  }
  const removalMatch = normalized.match(/\bremoved\s+(.+?)\s+from review\b/i);
  if (removalMatch) {
    return removalMatch[1].trim().toLowerCase();
  }
  return "";
}

function inferInitialBooleanState(currentActive, events) {
  let state = currentActive;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.activeAfter === state) {
      state = !event.activeAfter;
      continue;
    }
    return null;
  }
  return state;
}

function normalizePreviousLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") {
    return null;
  }
  return lifecycle;
}

function normalizeDurationPhase(phase, key) {
  if (!phase || typeof phase !== "object" || phase.kind !== "duration") {
    return null;
  }
  return {
    key,
    kind: "duration",
    availability: phase.availability,
    current: Boolean(phase.current),
    intervals: normalizeIntervals(phase.intervals || []),
    totalMs: Number.isFinite(phase.totalMs) ? phase.totalMs : 0,
    note: typeof phase.note === "string" ? phase.note : ""
  };
}

function normalizeIntervals(intervals) {
  return (Array.isArray(intervals) ? intervals : [])
    .filter((interval) => interval?.startAt && interval?.endAt)
    .map((interval) => ({
      startAt: normalizeTimestamp(interval.startAt),
      endAt: normalizeTimestamp(interval.endAt),
      ongoing: Boolean(interval.ongoing)
    }))
    .filter((interval) => interval.startAt && interval.endAt && interval.endAt >= interval.startAt)
    .sort((left, right) => compareTimestamps(left.startAt, right.startAt));
}

function closeDurationAtTerminal(phase, terminalAt) {
  if (!terminalAt || !phase.current || !phase.intervals.length) {
    return phase;
  }
  const intervals = normalizeIntervals(phase.intervals);
  const last = intervals.at(-1);
  if (last) {
    last.endAt = terminalAt;
    last.ongoing = false;
  }
  return durationPhaseFromIntervals(phase.key, intervals, {
    availability: phase.availability,
    current: false,
    note: phase.note
  });
}

function closeLastInterval(intervals, endAt) {
  const last = intervals.at(-1);
  if (!last) {
    return;
  }
  last.endAt = endAt;
  last.ongoing = false;
}

function extendLastInterval(intervals, endAt, ongoing) {
  const last = intervals.at(-1);
  if (!last) {
    return;
  }
  if (Date.parse(endAt) >= Date.parse(last.endAt)) {
    last.endAt = endAt;
  }
  last.ongoing = ongoing;
}

function firstNonDraftStart(createdAt, draftIntervals) {
  const firstDraft = normalizeIntervals(draftIntervals || [])[0];
  if (!firstDraft) {
    return createdAt;
  }
  if (firstDraft.startAt > createdAt) {
    return createdAt;
  }
  return firstDraft.endAt || "";
}

function normalizeObservationTimestamp(value, fallback) {
  const normalized = normalizeTimestamp(value);
  if (normalized) {
    return normalized;
  }
  return normalizeTimestamp(fallback);
}

function normalizeTimestamp(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : "";
  }
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compareTimestamps(left, right) {
  return Date.parse(left) - Date.parse(right);
}

function minTimestamp(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareTimestamps(left, right) <= 0 ? left : right;
}

function maxTimestamp(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareTimestamps(left, right) >= 0 ? left : right;
}

function formatTimestamp(value) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value || "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatDuration(value) {
  const totalMs = Number.isFinite(value) ? Math.max(0, value) : 0;
  const days = Math.floor(totalMs / MS_PER_DAY);
  const hours = Math.floor((totalMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((totalMs % MS_PER_HOUR) / MS_PER_MINUTE);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}
