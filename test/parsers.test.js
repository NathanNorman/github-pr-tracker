import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureTrackerNav, fetchOpenPrs, isSameOriginGitHubUrl, isTrackerRoute, parsePullListDocument, trackerSearchUrl, trackerUrl } from "../src/github.js";
import { findDeferredStatusEndpoint, mergeNativeDetails, parsePrDetailDocument, parsePrDetailPayload } from "../src/detail-parser.js";
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

test("fetchOpenPrs follows unique same-origin pagination links", async () => {
  const pages = new Map([
    ["https://github.com/search?q=is%3Aopen+is%3Apr+author%3A%40me&type=pullrequests", await fixture("pulls-page1.html")],
    ["https://github.com/pulls?page=2", await fixture("pulls-page2.html")]
  ]);
  const summaries = await fetchOpenPrs({
    fetchImpl: async (url) => ({ ok: true, text: async () => pages.get(url) }),
    parser: (html) => parseHtml(html)
  });
  assert.deepEqual(summaries.map((item) => item.key), ["acme/api#12", "acme/web#44", "acme/api#13"]);
});

test("parsePrUrl parses stable key", () => {
  assert.deepEqual(parsePrUrl("https://github.com/acme/api/pull/12/files"), {
    owner: "acme",
    repo: "api",
    number: 12,
    key: "acme/api#12",
    url: "https://github.com/acme/api/pull/12"
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
  const doc = parseHtml(await fixture("detail-current-github.html"), "https://github.com/acme/api/pull/12");
  assert.deepEqual(parsePrDetailDocument(doc), {
    review: "changes_requested",
    checks: "unknown",
    merge: "unknown",
    draft: true
  });
  assert.equal(
    findDeferredStatusEndpoint(doc, "https://github.com/acme/api/pull/12"),
    "https://github.com/acme/api/pull/12/partials/commit_status_icon?oid=abc123"
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

test("detail parser reads current GitHub reviewer approval text", () => {
  const doc = parseHtml(`
    <div data-url="/acme/api/issues/12/show_partial?partial=pull_requests%2Fsidebar%2Fshow%2Freviewers">
      <h3>Reviewers</h3><tool-tip>sam approved these changes</tool-tip>
    </div>
  `);
  assert.equal(parsePrDetailDocument(doc).review, "approved");
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
  const doc = parseHtml(await fixture("detail-history-only.html"), "https://github.com/acme/api/pull/12");
  assert.equal(findDeferredStatusEndpoint(doc, "https://github.com/acme/api/pull/12"), "https://github.com/acme/api/pull/12/status");
  assert.equal(isSameOriginGitHubUrl("https://evil.example/acme/api/pull/12/status"), false);
});

test("ensureTrackerNav targets the pulls nav and not unrelated navs", async () => {
  const doc = parseHtml(await fixture("pulls-duplicate-links.html"));
  ensureTrackerNav(doc);
  const trackerLink = doc.getElementById("pr-tracker-nav-link");
  assert.ok(trackerLink);
  assert.equal(trackerLink.closest("nav").getAttribute("aria-label"), "Global");
  assert.equal(trackerLink.getAttribute("href"), "/pulls/inbox#pr-tracker");
});

test("tracker route survives GitHub's canonical pulls inbox redirect", () => {
  assert.equal(trackerUrl(), "/pulls/inbox#pr-tracker");
  assert.equal(isTrackerRoute("https://github.com/pulls/inbox#pr-tracker"), true);
  assert.equal(isTrackerRoute("https://github.com/pulls/inbox?pr_tracker=1"), true);
  assert.equal(isTrackerRoute("https://github.com/pulls?pr_tracker=1"), true);
  assert.equal(isTrackerRoute("https://github.com/pulls/inbox"), false);
  assert.equal(isTrackerRoute("https://github.com/pulls/assigned#pr-tracker"), false);
});

test("authored PR discovery uses GitHub search instead of the redirected pulls route", () => {
  const url = new URL(trackerSearchUrl());
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("type"), "pullrequests");
  assert.match(url.searchParams.get("q"), /author:@me/);
});
