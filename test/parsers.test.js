import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureTrackerNav, fetchOpenPrs, isSameOriginGitHubUrl, isTrackerRoute, parsePullListDocument, trackerSearchUrl, trackerUrl } from "../src/github.js";
import {
  findDeferredStatusEndpoint,
  mergeNativeDetails,
  parsePrDetailDocument,
  parsePrDetailPayload,
  parseUnresolvedThreadCountDocument
} from "../src/detail-parser.js";
import { parsePrUrl } from "../src/models.js";
import { parseHtml } from "./helpers.js";

const fixtures = path.resolve(new URL(".", import.meta.url).pathname, "fixtures");

async function fixture(name) {
  return readFile(path.join(fixtures, name), "utf8");
}

test("parsePullListDocument groups duplicate links and ignores cross-origin pagination", async () => {
  const doc = parseHtml(await fixture("pulls-duplicate-links.html"));
  const result = parsePullListDocument(doc);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "Improve search indexing with real title");
  assert.equal(result.nextHref, null);
});

test("parsePullListDocument reads Toast Enterprise review and check signals", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const doc = parseHtml(`
    <div class="Box-row">
      <a href="/acme/api/pull/12">Improve the API</a>
      <div
        class="commit-build-statuses"
        data-deferred-details-content-url="/acme/api/commit/${sha}/status-details?popover=true"
      ></div>
      <svg class="color-fg-success" aria-label="7 / 7 checks OK"></svg>
      <span>Review required before merging</span>
    </div>
    <div class="Box-row">
      <a href="/acme/web/pull/13">Draft the UI</a>
      <svg class="color-fg-danger octicon-x" aria-label="5 / 6 checks OK"></svg>
      <span>Draft</span>
    </div>
  `);
  const result = parsePullListDocument(doc);
  assert.deepEqual(
    result.items.map(({ key, review, checks, draft }) => ({ key, review, checks, draft })),
    [
      { key: "acme/api#12", review: "required", checks: "passing", draft: false },
      { key: "acme/web#13", review: "unknown", checks: "failing", draft: true }
    ]
  );
  assert.equal(result.items[0].headSha, sha);
  assert.equal(result.items[0].checksUrl, `https://github.toasttab.com/acme/api/commit/${sha}/status-details?popover=true`);
});

test("parsePullListDocument trusts the green rollup wrapper when successful checks exclude skipped checks", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const doc = parseHtml(`
    <div class="Box-row">
      <a href="/acme/api/pull/12">Improve the API</a>
      <details
        class="commit-build-statuses"
        data-deferred-details-content-url="/acme/api/commit/${sha}/status-details?popover=true"
      >
        <summary class="color-fg-success">
          <svg aria-label="37 / 81 checks OK" class="octicon octicon-check"></svg>
        </summary>
      </details>
    </div>
  `);
  assert.equal(parsePullListDocument(doc).items[0].checks, "passing");
});

test("parsePullListDocument rejects mismatched data-head-sha against the validated status-details url", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const doc = parseHtml(`
    <div class="Box-row">
      <a href="/acme/api/pull/12">Improve the API</a>
      <div
        class="commit-build-statuses"
        data-head-sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        data-deferred-details-content-url="/acme/api/commit/${sha}/status-details?popover=true"
      ></div>
    </div>
  `);
  assert.equal(parsePullListDocument(doc).items[0].headSha, undefined);
  assert.equal(parsePullListDocument(doc).items[0].checksUrl, undefined);
});

test("parsePullListDocument isolates checks from generic review and merge icons", () => {
  const doc = parseHtml(`
    <div class="Box-row">
      <a href="/acme/api/pull/14">Mixed native states</a>
      <span class="color-fg-danger">Code owner review required</span>
      <svg class="color-fg-danger" aria-label="Merging is blocked"></svg>
      <svg class="color-fg-success" aria-label="7 / 7 checks OK"></svg>
    </div>
    <div class="Box-row">
      <a href="/acme/web/pull/15">No check status</a>
      <svg class="color-fg-danger octicon-x" aria-label="Merging is blocked"></svg>
    </div>
  `);
  const result = parsePullListDocument(doc);
  assert.deepEqual(
    result.items.map(({ key, review, checks }) => ({ key, review, checks })),
    [
      { key: "acme/api#14", review: "required", checks: "passing" },
      { key: "acme/web#15", review: "unknown", checks: "unknown" }
    ]
  );
});

test("parsePullListDocument ignores ambiguous aggregate status containers", () => {
  const doc = parseHtml(`
    <div class="Box-row">
      <a href="/acme/api/pull/16">Nested aggregate state</a>
      <div class="status-checks color-fg-danger">
        <div class="status-check-row color-fg-danger">Review required</div>
        <div class="status-check-row color-fg-danger">Merging is blocked</div>
        <div class="status-check-row color-fg-success">All checks have passed</div>
      </div>
    </div>
  `);
  assert.equal(parsePullListDocument(doc).items[0].checks, "unknown");
});

test("parsePullListDocument does not infer draft state from the PR title", () => {
  const doc = parseHtml(`
    <div data-issue-and-pr-hovercards-enabled="true">
      <a data-hovercard-type="pull_request" href="/acme/api/pull/14">Draft documentation for the API</a>
      <a class="label"><span>Draft</span></a>
    </div>
  `);
  assert.equal(parsePullListDocument(doc).items[0].draft, false);
});

test("fetchOpenPrs follows unique same-origin pagination links", async () => {
  const pages = new Map([
    ["https://github.toasttab.com/pulls?q=is%3Aopen+is%3Apr+archived%3Afalse+author%3A%40me", await fixture("pulls-page1.html")],
    ["https://github.toasttab.com/pulls?page=2", await fixture("pulls-page2.html")]
  ]);
  const summaries = await fetchOpenPrs({
    fetchImpl: async (url) => ({ ok: true, text: async () => pages.get(url) }),
    parser: (html) => parseHtml(html)
  });
  assert.deepEqual(summaries.map((item) => item.key), ["acme/api#12", "acme/web#44", "acme/api#13"]);
});

test("parsePrUrl parses stable key", () => {
  assert.deepEqual(parsePrUrl("https://github.toasttab.com/acme/api/pull/12/files"), {
    owner: "acme",
    repo: "api",
    number: 12,
    key: "acme/api#12",
    url: "https://github.toasttab.com/acme/api/pull/12"
  });
});

test("detail parser prefers nested embedded payloads", async () => {
  const detail = parsePrDetailDocument(parseHtml(await fixture("detail-embedded-nested.html")));
  assert.deepEqual(detail, {
    review: "changes_requested",
    checks: "passing",
    merge: "conflicting",
    draft: true
  });
});

test("detail parser falls back to semantic DOM states", async () => {
  const detail = parsePrDetailDocument(parseHtml(await fixture("detail-dom.html")));
  assert.deepEqual(detail, {
    review: "required",
    checks: "passing",
    merge: "clean",
    draft: undefined
  });
});

test("detail parser extracts creation time and Jira references from the PR page", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <div class="gh-header-meta">
      <relative-time datetime="2026-08-04T14:30:00Z"></relative-time>
    </div>
    <a href="https://toasttab.atlassian.net/browse/ENG-42">ENG-42</a>
    <a href="https://toasttab.atlassian.net/browse/PLAT-7">Platform work for PLAT-7</a>
    <a href="https://example.com/not-jira">ENG-42</a>
    <a href="https://toasttab.atlassian.net/browse/OPS-9">ENG-42</a>
  `, "https://github.toasttab.com/acme/api/pull/12"));

  assert.equal(detail.createdAt, "2026-08-04T14:30:00Z");
  assert.equal(detail.jiraBaseUrl, "https://toasttab.atlassian.net/browse/");
  assert.deepEqual(detail.jiraReferences, [
    { key: "ENG-42", url: "https://toasttab.atlassian.net/browse/ENG-42" },
    { key: "PLAT-7", url: "https://toasttab.atlassian.net/browse/PLAT-7" }
  ]);
});

test("detail parser ignores jira-looking labels when the href is unrelated or mismatched", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <a href="https://example.com/not-jira">ENG-42</a>
    <a href="https://toasttab.atlassian.net/browse/OPS-9">ENG-42</a>
    <a href="javascript:alert('xss')">SEC-1</a>
  `, "https://github.toasttab.com/acme/api/pull/12"));

  assert.equal(detail.jiraBaseUrl, undefined);
  assert.equal(detail.jiraReferences, undefined);
});

test("detail parser uses the current merge-box rollup instead of an older failed commit", async () => {
  const detail = parsePrDetailDocument(parseHtml(await fixture("detail-mixed-states.html")));
  assert.deepEqual(detail, {
    review: "required",
    checks: "passing",
    merge: "blocked",
    draft: undefined
  });
});

test("detail parser lets the current merge box override a stale embedded failure", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <script type="application/json" data-target="react-app.embeddedData">
      {"payload":{"pullRequestsLayoutRoute":{"pullRequest":{"number":30,"reviewDecision":"APPROVED","statusCheckRollup":{"state":"FAILURE"},"mergeStateStatus":"BLOCKED"}}}}
    </script>
    <div class="mergeability-details">
      <div class="branch-action-item"><h3 class="status-heading">Code owner review required</h3></div>
      <div class="branch-action-item"><h3 class="status-heading">All checks have passed</h3><span class="status-meta">7 successful checks</span></div>
      <div class="branch-action-item"><h3 class="status-heading">Merging is blocked</h3></div>
    </div>
  `, "https://github.toasttab.com/toasttab/apex-copilot/pull/30"));

  assert.deepEqual(detail, {
    review: "required",
    checks: "passing",
    merge: "blocked",
    draft: undefined
  });
});

test("detail parser does not treat merge-blocked danger markers as failing checks when checks have passed", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <div data-test-selector="mergebox" class="mergeability-details">
      <div class="branch-action-item">
        <svg class="octicon octicon-x color-fg-danger"></svg>
        <h3 class="status-heading">Merging is blocked</h3>
        <span class="status-meta">Merging can be performed automatically once required checks pass and 1 approving review is given</span>
      </div>
      <div class="branch-action-item">
        <svg class="octicon octicon-check color-fg-success"></svg>
        <h3 class="status-heading">All checks have passed</h3>
        <span class="status-meta">7 successful checks</span>
      </div>
      <div class="branch-action-item">
        <svg class="octicon octicon-x color-fg-danger"></svg>
        <h3 class="status-heading">Code owner review required</h3>
      </div>
    </div>
  `));

  assert.equal(detail.checks, "passing");
  assert.equal(detail.merge, "blocked");
  assert.equal(detail.review, "required");
});

test("detail parser ignores unrelated embedded check rollups for the current PR", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <script type="application/json" data-target="react-app.embeddedData">
      {
        "timeline":{"commit":{"number":29,"statusCheckRollup":{"state":"FAILURE"}}},
        "payload":{"pullRequestsLayoutRoute":{"pullRequest":{"number":30,"reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":{"state":"SUCCESS"},"mergeStateStatus":"BLOCKED"}}}
      }
    </script>
  `, "https://github.toasttab.com/toasttab/apex-copilot/pull/30"));

  assert.equal(detail.review, "required");
  assert.equal(detail.checks, "passing");
  assert.equal(detail.merge, "blocked");
});

test("detail parser keeps reviews and checks independent in alternate merge-box markup", () => {
  const cases = [
    {
      reviewHeading: "Code owner review required",
      checksHeading: "All checks have passed",
      expected: { review: "required", checks: "passing" }
    },
    {
      reviewHeading: "Review approved",
      checksHeading: "Some checks failed",
      expected: { review: "approved", checks: "failing" }
    }
  ];

  for (const { reviewHeading, checksHeading, expected } of cases) {
    const detail = parsePrDetailDocument(parseHtml(`
      <div data-test-selector="mergebox">
        <div class="branch-action-item"><h3 class="status-heading">${reviewHeading}</h3></div>
        <div class="branch-action-item"><h3 class="status-heading">${checksHeading}</h3></div>
      </div>
    `));
    assert.equal(detail.review, expected.review);
    assert.equal(detail.checks, expected.checks);
  }
});

test("detail parser does not reuse an old failed commit when the current merge box has no checks row", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <details class="commit-build-statuses">
      <summary class="color-fg-danger"><svg class="octicon octicon-x" aria-label="6 / 7 checks OK"></svg></summary>
    </details>
    <div class="mergeability-details">
      <div class="branch-action-item"><h3 class="status-heading">Review approved</h3></div>
    </div>
  `));
  assert.equal(detail.review, "approved");
  assert.equal(detail.checks, "unknown");
});

test("detail parser stays unknown for historical timeline text", async () => {
  const detail = parsePrDetailDocument(parseHtml(await fixture("detail-history-only.html")));
  assert.deepEqual(detail, {
    review: "unknown",
    checks: "unknown",
    merge: "unknown",
    draft: undefined
  });
});

test("detail parser reads GitHub's current embedded draft and reviewer sidebar", async () => {
  const doc = parseHtml(await fixture("detail-current-github.html"), "https://github.toasttab.com/acme/api/pull/12");
  assert.deepEqual(parsePrDetailDocument(doc), {
    review: "changes_requested",
    checks: "unknown",
    merge: "unknown",
    draft: true
  });
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.toasttab.com/acme/api/pull/12"),
    "https://github.toasttab.com/acme/api/pull/12/partials/commit_status_icon?oid=abc123"
  );
});

test("detail parser reads current GitHub check rollup fragments", async () => {
  assert.equal(parsePrDetailDocument(parseHtml(await fixture("detail-checks-current.html"))).checks, "failing");
  assert.equal(
    parsePrDetailDocument(
      parseHtml('<details class="commit-build-statuses"><summary class="hx_dot-fill-pending-icon"><svg aria-label="21 / 28 checks OK"></svg></summary></details>')
    ).checks,
    "pending"
  );
  assert.equal(
    parsePrDetailDocument(
      parseHtml('<details class="commit-build-statuses"><summary class="color-fg-success"><svg aria-label="1 / 1 checks OK"></svg></summary></details>')
    ).checks,
    "passing"
  );
});

test("detail parser reads standalone current-head status-details markup", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <div class="branch-action-item branch-action-item-simple">
      <h3 class="status-heading">All checks have passed</h3>
      <span class="status-meta">7 successful checks</span>
    </div>
  `));
  assert.equal(detail.checks, "passing");
});

test("detail parser keeps mergeability checks ahead of historical standalone branch-action items", () => {
  const detail = parsePrDetailDocument(parseHtml(`
    <div class="branch-action-item branch-action-item-simple">
      <h3 class="status-heading">Some checks failed</h3>
      <span class="status-meta">historical</span>
    </div>
    <div class="mergeability-details">
      <div class="branch-action-item">
        <h3 class="status-heading">All checks have passed</h3>
        <span class="status-meta">7 successful checks</span>
      </div>
    </div>
  `));
  assert.equal(detail.checks, "passing");
});

test("detail parser reads current GitHub reviewer approval text", () => {
  const doc = parseHtml(`
    <div data-url="/acme/api/issues/12/show_partial?partial=pull_requests%2Fsidebar%2Fshow%2Freviewers">
      <h3>Reviewers</h3><tool-tip>sam approved these changes</tool-tip>
    </div>
  `);
  assert.equal(parsePrDetailDocument(doc).review, "approved");
});

test("thread parser counts only unresolved review conversations", () => {
  const doc = parseHtml(`
    <div class="js-diff-progressive-container">
      <div class="js-resolvable-timeline-thread-container" data-review-thread-id="one">
        <button>Resolve conversation</button>
      </div>
      <div class="js-resolvable-timeline-thread-container is-resolved" data-review-thread-id="two">
        <button>Unresolve conversation</button>
      </div>
      <div class="js-resolvable-timeline-thread-container" data-review-thread-id="three">
        <div class="js-resolvable-thread"><button>Resolve conversation</button></div>
      </div>
    </div>
  `);
  assert.equal(parseUnresolvedThreadCountDocument(doc), 2);
});

test("thread parser reports zero for a loaded files view and unknown for unrelated HTML", () => {
  assert.equal(
    parseUnresolvedThreadCountDocument(parseHtml('<div class="js-diff-progressive-container"></div>')),
    0
  );
  assert.equal(parseUnresolvedThreadCountDocument(parseHtml("<main>Conversation</main>")), undefined);
});

test("parsePrDetailPayload maps uppercase current-state values", () => {
  assert.deepEqual(
    parsePrDetailPayload({
      currentReviewState: "REVIEW_REQUIRED",
      checks_state: "IN_PROGRESS",
      mergeStateStatus: "DIRTY"
    }),
    {
      review: "required",
      checks: "pending",
      merge: "conflicting",
      draft: undefined
    }
  );
});

test("parsePrDetailPayload does not overstate behind or unstable merge states", () => {
  assert.equal(parsePrDetailPayload({ mergeStateStatus: "BEHIND" }).merge, "unknown");
  assert.equal(parsePrDetailPayload({ mergeStateStatus: "UNSTABLE" }).merge, "unknown");
});

test("mergeNativeDetails fills unknown fields without downgrading known values", () => {
  assert.deepEqual(
    mergeNativeDetails(
      { review: "approved", checks: "unknown", merge: "unknown", draft: undefined },
      { review: "unknown", checks: "passing", merge: "blocked", draft: false }
    ),
    {
      review: "approved",
      checks: "passing",
      merge: "blocked",
      draft: false
    }
  );
});

test("semantic DOM merge parsing prefers conflict text over generic can-merge phrasing", () => {
  const doc = parseHtml('<html><body><div data-mergeability-message>This branch can be merged but has conflicts that must be resolved.</div></body></html>');
  assert.equal(parsePrDetailDocument(doc).merge, "conflicting");
});

test("findDeferredStatusEndpoint returns only same-origin current-status URLs from HTML", async () => {
  const doc = parseHtml(await fixture("detail-history-only.html"), "https://github.toasttab.com/acme/api/pull/12");
  assert.equal(findDeferredStatusEndpoint(doc, "https://github.toasttab.com/acme/api/pull/12"), "https://github.toasttab.com/acme/api/pull/12/status");
  assert.equal(isSameOriginGitHubUrl("https://evil.example/acme/api/pull/12/status"), false);
});

test("findDeferredStatusEndpoint scopes to the current PR and prefers the current head oid", () => {
  const doc = parseHtml(`
    <input type="hidden" name="head_sha" value="abc123">
    <div data-url="/acme/api/pull/99/partials/commit_status_icon?oid=wrong-pr"></div>
    <div data-url="/acme/api/pull/12/partials/commit_status_icon?oid=old111"></div>
    <div data-url="/acme/api/pull/12/partials/commit_status_icon?oid=abc123"></div>
    <script>
      window.__seed = "https://github.toasttab.com/acme/other/pull/12/partials/commit_status_icon?oid=abc123";
    </script>
  `, "https://github.toasttab.com/acme/api/pull/12");
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.toasttab.com/acme/api/pull/12"),
    "https://github.toasttab.com/acme/api/pull/12/partials/commit_status_icon?oid=abc123"
  );
});

test("findDeferredStatusEndpoint uses the supplied head when merge-form metadata is absent", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const doc = parseHtml(`
    <div data-url="/acme/api/pull/12/partials/commit_status_icon?oid=old111"></div>
    <div data-url="/acme/api/pull/12/partials/commit_status_icon?oid=${sha}"></div>
  `, "https://github.toasttab.com/acme/api/pull/12");
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.toasttab.com/acme/api/pull/12", sha),
    `https://github.toasttab.com/acme/api/pull/12/partials/commit_status_icon?oid=${sha}`
  );
});

test("findDeferredStatusEndpoint picks the newest commit's status icon when no head sha is known", () => {
  const doc = parseHtml(`
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=a9a5d890"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=71d058e3"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=ed059b18"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=36f3e0b6"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/reviews/1"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/title"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/body"></div>
    <a href="/toasttab/apex-copilot/pull/30/checks"></a>
  `, "https://github.toasttab.com/toasttab/apex-copilot/pull/30");
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.toasttab.com/toasttab/apex-copilot/pull/30"),
    "https://github.toasttab.com/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=36f3e0b6"
  );
});

test("findDeferredStatusEndpoint on a React-shell PR page parses all-unknown detail but selects the newest deferred commit status", () => {
  const doc = parseHtml(`
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=a9a5d890"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=71d058e3"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=ed059b18"></div>
    <div data-url="/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=36f3e0b6"></div>
    <div class="commit-build-statuses"><span class="Skeleton d-inline-block"></span></div>
  `, "https://github.toasttab.com/toasttab/apex-copilot/pull/30");
  assert.deepEqual(parsePrDetailDocument(doc), {
    review: "unknown",
    checks: "unknown",
    merge: "unknown",
    draft: undefined
  });
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.toasttab.com/toasttab/apex-copilot/pull/30"),
    "https://github.toasttab.com/toasttab/apex-copilot/pull/30/partials/commit_status_icon?oid=36f3e0b6"
  );
});

test("ensureTrackerNav targets the pulls nav and not unrelated navs", async () => {
  const doc = parseHtml(await fixture("pulls-duplicate-links.html"));
  ensureTrackerNav(doc);
  const trackerLink = doc.getElementById("pr-tracker-nav-link");
  assert.ok(trackerLink);
  assert.equal(trackerLink.closest("nav").getAttribute("aria-label"), "Global");
  assert.equal(trackerLink.getAttribute("href"), "/pulls#pr-tracker");
});

test("tracker uses the valid Toast GitHub Enterprise pulls route", () => {
  assert.equal(trackerUrl(), "/pulls#pr-tracker");
  assert.equal(isTrackerRoute("https://github.toasttab.com/pulls/inbox#pr-tracker"), true);
  assert.equal(isTrackerRoute("https://github.toasttab.com/pulls/inbox?pr_tracker=1"), true);
  assert.equal(isTrackerRoute("https://github.toasttab.com/pulls?pr_tracker=1"), true);
  assert.equal(isTrackerRoute("https://github.toasttab.com/pulls/inbox"), false);
  assert.equal(isTrackerRoute("https://github.toasttab.com/pulls/assigned#pr-tracker"), false);
});

test("authored PR discovery uses the Toast GitHub Enterprise pulls route", () => {
  const url = new URL(trackerSearchUrl());
  assert.equal(url.origin, "https://github.toasttab.com");
  assert.equal(url.pathname, "/pulls");
  assert.match(url.searchParams.get("q"), /author:@me/);
  assert.match(url.searchParams.get("q"), /archived:false/);
  assert.match(new URL(trackerSearchUrl("nathannorman-toast")).searchParams.get("q"), /author:nathannorman-toast/);
});
