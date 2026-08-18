// ==UserScript==
// @name         GitHub Personal PR Tracker
// @namespace    https://github.com/
// @version      1.10.0
// @description  Personal pull request tracker for your own open Toast GitHub PRs.
// @homepageURL  https://github.com/NathanNorman/github-pr-tracker
// @supportURL   https://github.com/NathanNorman/github-pr-tracker/issues
// @downloadURL  https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js?version=1.10.0
// @updateURL    https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js?channel=stable
// @match        https://github.toasttab.com/pulls*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

(() => {
  // src/constants.js
  var APP_ID = "tm-github-pr-tracker";
  var GITHUB_ORIGIN = "https://github.toasttab.com";
  var SCHEMA_VERSION = 1;
  var DETAIL_CACHE_TTL_MS = 10 * 60 * 1e3;
  var DETAIL_PARSER_VERSION = 10;
  var OPEN_LIST_CACHE_TTL_MS = 5 * 60 * 1e3;
  var SAVE_DEBOUNCE_MS = 400;
  var MAX_COLLAPSED_GROUPS = 500;
  var PERSONAL_STATUSES = ["unsorted", "next_up", "waiting", "blocked", "done"];
  var ACTIVE_STATUSES = PERSONAL_STATUSES.filter((status) => status !== "done");
  var REVIEW_STATES = ["approved", "changes_requested", "required", "none", "unknown"];
  var CHECK_STATES = ["passing", "failing", "pending", "none", "unknown"];
  var MERGE_STATES = ["clean", "blocked", "conflicting", "unknown"];
  var TAG_COLORS = ["gray", "blue", "purple", "green", "yellow", "orange", "red", "pink"];
  var DEFAULT_RECORD = Object.freeze({
    status: "unsorted",
    blockedBy: "",
    notes: "",
    tags: [],
    modifiedAt: 0
  });
  var TAG_COLOR_TOKENS = {
    gray: {
      fg: "var(--button-default-fgColor-rest, var(--fgColor-default, inherit))",
      bg: "var(--bgColor-neutral-muted, rgba(175,184,193,0.2))",
      border: "var(--borderColor-neutral-muted, rgba(175,184,193,0.4))"
    },
    blue: {
      fg: "var(--fgColor-accent, #0969da)",
      bg: "var(--bgColor-accent-muted, rgba(84,174,255,0.2))",
      border: "var(--borderColor-accent-muted, rgba(84,174,255,0.4))"
    },
    purple: {
      fg: "var(--fgColor-done, #8250df)",
      bg: "var(--bgColor-done-muted, rgba(194,151,255,0.2))",
      border: "var(--borderColor-done-muted, rgba(194,151,255,0.4))"
    },
    green: {
      fg: "var(--fgColor-success, #1a7f37)",
      bg: "var(--bgColor-success-muted, rgba(74,194,107,0.2))",
      border: "var(--borderColor-success-muted, rgba(74,194,107,0.4))"
    },
    yellow: {
      fg: "var(--fgColor-attention, #9a6700)",
      bg: "var(--bgColor-attention-muted, rgba(212,167,44,0.2))",
      border: "var(--borderColor-attention-muted, rgba(212,167,44,0.4))"
    },
    orange: {
      fg: "var(--fgColor-severe, #bc4c00)",
      bg: "var(--bgColor-severe-muted, rgba(251,143,68,0.2))",
      border: "var(--borderColor-severe-muted, rgba(251,143,68,0.4))"
    },
    red: {
      fg: "var(--fgColor-danger, #d1242f)",
      bg: "var(--bgColor-danger-muted, rgba(255,129,130,0.2))",
      border: "var(--borderColor-danger-muted, rgba(255,129,130,0.4))"
    },
    pink: {
      fg: "var(--fgColor-sponsors, #bf3989)",
      bg: "var(--bgColor-sponsors-muted, rgba(255,128,200,0.2))",
      border: "var(--borderColor-sponsors-muted, rgba(255,128,200,0.4))"
    }
  };

  // src/utils.js
  function safeJsonParse(text2, fallback = null) {
    try {
      return JSON.parse(text2);
    } catch {
      return fallback;
    }
  }
  function debounce(fn, wait) {
    let timeoutId = null;
    const debounced = (...args) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        timeoutId = null;
        fn(...args);
      }, wait);
    };
    debounced.flush = (...args) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
        fn(...args);
      }
    };
    return debounced;
  }
  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  var JIRA_ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
  function extractJiraIssueKeys(value) {
    const textValue = text(value);
    const matches = textValue.match(JIRA_ISSUE_KEY_PATTERN) || [];
    return [...new Set(matches.map((match) => match.toUpperCase()))];
  }
  function calendarDaysSince(value, currentTime = Date.now()) {
    const createdAt = new Date(value);
    const current = new Date(currentTime);
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(current.getTime())) {
      return null;
    }
    const createdDay = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate());
    const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    return Math.max(0, Math.round((currentDay.getTime() - createdDay.getTime()) / 864e5));
  }
  function normalizeHttpUrl(value, baseUrl = void 0) {
    if (!value) {
      return "";
    }
    try {
      const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }
  function now() {
    return Date.now();
  }

  // src/detail-parser.js
  function normalizeReviewState(value) {
    const normalized = String(value || "").toLowerCase();
    const aliases = {
      changesrequested: "changes_requested",
      changes_requested: "changes_requested",
      review_required: "required",
      required: "required",
      approved: "approved",
      none: "none"
    };
    if (aliases[normalized]) {
      return aliases[normalized];
    }
    if (REVIEW_STATES.includes(value)) {
      return value;
    }
    return "unknown";
  }
  function normalizeCheckState(value) {
    const normalized = String(value || "").toLowerCase();
    if (CHECK_STATES.includes(normalized)) {
      return normalized;
    }
    if (["success", "successful", "pass", "passing"].includes(normalized)) {
      return "passing";
    }
    if (["failure", "failed", "error", "failing"].includes(normalized)) {
      return "failing";
    }
    if (["expected", "in_progress", "running", "pending"].includes(normalized)) {
      return "pending";
    }
    return "unknown";
  }
  function normalizeMergeState(value) {
    const normalized = String(value || "").toLowerCase();
    if (MERGE_STATES.includes(normalized)) {
      return normalized;
    }
    if (["dirty", "conflicting"].includes(normalized)) {
      return "conflicting";
    }
    if (["clean", "has_hooks", "mergeable", "can_merge"].includes(normalized)) {
      return "clean";
    }
    if (["blocked", "unknown", "draft"].includes(normalized)) {
      return normalized === "draft" ? "blocked" : normalized;
    }
    return "unknown";
  }
  function parsePrDetailPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const reviewState = payload.reviewDecision || payload.review_state || payload.currentReviewState;
    const checksState = payload.statusCheckRollup?.state || payload.checks_state || payload.checkState;
    const mergeState = payload.mergeStateStatus || payload.merge_state || payload.mergeState;
    const createdAt = normalizeTimestamp(payload.createdAt || payload.created_at);
    const draft = typeof payload.isDraft === "boolean" ? payload.isDraft : typeof payload.draft === "boolean" ? payload.draft : payload.state === "DRAFT" ? true : payload.state === "OPEN" ? false : void 0;
    if (!reviewState && !checksState && !mergeState && typeof draft !== "boolean" && !createdAt) {
      return null;
    }
    const detail = {
      review: normalizeReviewState(reviewState || "unknown"),
      checks: normalizeCheckState(checksState || "unknown"),
      merge: normalizeMergeState(mergeState || "unknown"),
      draft: typeof draft === "boolean" ? draft : void 0
    };
    if (createdAt) {
      detail.createdAt = createdAt;
    }
    return detail;
  }
  function findEmbeddedPayload(doc, baseUrl) {
    const expectedNumber = pullRequestNumber(baseUrl);
    for (const script of doc.querySelectorAll("script")) {
      const text2 = script.textContent || "";
      const isCurrentEmbeddedData = script.matches('script[type="application/json"][data-target*="embeddedData"]');
      if (!isCurrentEmbeddedData && !text2.includes("reviewDecision") && !text2.includes("statusCheckRollup") && !text2.includes("mergeStateStatus")) {
        continue;
      }
      const matches = text2.match(/\{[\s\S]*\}/g) || [];
      for (const candidate of matches) {
        const parsed = safeJsonParse(candidate);
        const detail = extractNestedPayloadDetail(parsed, expectedNumber);
        if (detail) {
          return detail;
        }
      }
    }
    return null;
  }
  function classifyCheckSignal(text2) {
    const normalized = String(text2 || "");
    if (/color-fg-danger|octicon-x|failing|failed|checks? not successful|checks? have failed/i.test(normalized)) {
      return "failing";
    }
    if (/hx_dot-fill-pending-icon|color-fg-attention|pending|expected|running|in progress|checks? (?:are|is) still/i.test(normalized)) {
      return "pending";
    }
    if (/color-fg-success|octicon-check|successful|passed|all checks have passed/i.test(normalized)) {
      return "passing";
    }
    if (/no checks/i.test(normalized)) {
      return "none";
    }
    const totals = normalized.match(/(\d+)\s*\/\s*(\d+)\s*checks? OK/i);
    if (totals && totals[1] === totals[2]) {
      return "passing";
    }
    return "unknown";
  }
  function checkSignalText(root) {
    if (!root) {
      return "";
    }
    const heading = root.querySelector?.(".status-heading");
    if (heading && (/\bchecks?\b/i.test(heading.textContent || "") || /all checks have passed/i.test(heading.textContent || ""))) {
      const meta = heading.parentElement?.querySelector?.(".status-meta");
      return [heading.className, heading.textContent, meta?.className, meta?.textContent].filter(Boolean).join(" ");
    }
    const nodes = [
      root,
      ...root.querySelectorAll(
        'summary, .status-heading, .status-meta, [aria-label*="check" i], img[alt*="check" i], [data-checks-state]'
      )
    ];
    return nodes.map((node) => [
      node.className,
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("alt"),
      node.getAttribute?.("data-checks-state"),
      node.textContent
    ].filter(Boolean).join(" ")).join(" ");
  }
  function findCurrentCheckRoot(doc) {
    const mergeabilityRoot = doc.querySelector('.mergeability-details, [data-test-selector="mergebox"]');
    if (mergeabilityRoot) {
      const actionItems = [...mergeabilityRoot.querySelectorAll(".branch-action-item")];
      const currentRollup = actionItems.find((item) => {
        const heading = item.querySelector(".status-heading")?.textContent || "";
        return /\bchecks?\b/i.test(heading);
      });
      if (currentRollup) {
        return currentRollup;
      }
      const nestedRollup = mergeabilityRoot.querySelector(".commit-build-statuses, [data-checks-state]");
      if (nestedRollup) {
        return nestedRollup;
      }
      return null;
    }
    const standaloneCurrentRollup = [...doc.querySelectorAll(".branch-action-item, .branch-action-item-simple")].find((item) => {
      const heading = item.querySelector(".status-heading")?.textContent || "";
      return /\bchecks?\b|all checks have passed|some checks failed|no checks/i.test(heading);
    });
    if (standaloneCurrentRollup) {
      return standaloneCurrentRollup;
    }
    const explicitRollups = [...doc.querySelectorAll("[data-checks-state]")];
    if (explicitRollups.length) {
      return explicitRollups.at(-1);
    }
    const commitRollups = [...doc.querySelectorAll(".commit-build-statuses")];
    if (commitRollups.length) {
      return commitRollups.at(-1);
    }
    const labelledRollups = [...doc.querySelectorAll('[aria-label*="checks" i], img[alt*="checks" i]')];
    return labelledRollups.at(-1) || null;
  }
  function detailFromDom(doc) {
    let review = "unknown";
    let checks = "unknown";
    let merge = "unknown";
    const mergeabilityRoot = doc.querySelector('.mergeability-details, [data-test-selector="mergebox"]');
    const mergeabilityReviewRoot = [...mergeabilityRoot?.querySelectorAll(".branch-action-item") || []].find((item) => /\breview(?:ers?)?\b/i.test(item.querySelector(".status-heading")?.textContent || ""));
    const currentReviewRoot = mergeabilityReviewRoot || doc.querySelector('[data-url*="pull_requests%2Fsidebar%2Fshow%2Freviewers"]') || doc.querySelector('form[id^="pull-request-reviewers-form-"]') || doc.querySelector('[data-test-selector="required-review-banner"], [data-review-state]');
    const reviewText = currentReviewRoot ? [
      currentReviewRoot.textContent,
      ...[...currentReviewRoot.querySelectorAll("tool-tip, [aria-label]")].map(
        (node) => `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`
      )
    ].join(" ") : "";
    if (/changes requested|requested changes/i.test(reviewText)) {
      review = "changes_requested";
    } else if (/approved(?: these changes)?/i.test(reviewText)) {
      review = "approved";
    } else if (/review required|required review|review requested|requested review|approving review is required/i.test(reviewText)) {
      review = "required";
    } else if (/no reviews/i.test(reviewText)) {
      review = "none";
    }
    checks = classifyCheckSignal(checkSignalText(findCurrentCheckRoot(doc)));
    const mergeText = doc.querySelector('.mergeability-details, [data-mergeability-message], [data-test-selector="mergebox"], [aria-label*="merge"]')?.textContent || "";
    if (/\bconflicts?\b/i.test(mergeText) && !/\bno conflicts?\b/i.test(mergeText)) {
      merge = "conflicting";
    } else if (/cannot be merged|blocked|merge is blocked/i.test(mergeText)) {
      merge = "blocked";
    } else if (/has no conflicts|can be merged|merge pull request/i.test(mergeText)) {
      merge = "clean";
    }
    const draft = /draft/i.test(doc.querySelector('[aria-label="Pull request state"]')?.textContent || "") ? true : void 0;
    const createdAt = createdAtFromDom(doc);
    const jiraReferences = extractJiraReferences(doc);
    const jiraBaseUrl = jiraBaseUrlFromReferences(jiraReferences);
    return {
      review,
      checks,
      merge,
      draft,
      ...createdAt ? { createdAt } : {},
      ...jiraReferences.length ? { jiraReferences } : {},
      ...jiraBaseUrl ? { jiraBaseUrl } : {}
    };
  }
  function parsePrDetailDocument(doc, baseUrl = doc?.URL) {
    const embedded = findEmbeddedPayload(doc, baseUrl);
    const dom = detailFromDom(doc);
    return mergeNativeDetails(dom, embedded);
  }
  function parseUnresolvedThreadCountDocument(doc) {
    const candidates = [
      ...doc.querySelectorAll(
        ".js-resolvable-timeline-thread-container, .js-resolvable-thread, [data-review-thread-id], [data-pull-review-thread-id]"
      )
    ];
    const threadRoots = candidates.filter(
      (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate))
    );
    if (threadRoots.length) {
      return threadRoots.filter((thread) => !isResolvedThread(thread)).length;
    }
    const conversationButtons = [...doc.querySelectorAll("button, input[type='submit']")].map((node) => (node.textContent || node.getAttribute("value") || "").trim()).filter((label) => /^(?:un)?resolve (?:conversation|thread)$/i.test(label));
    if (conversationButtons.length) {
      return conversationButtons.filter((label) => /^resolve /i.test(label)).length;
    }
    if (doc.querySelector(
      ".js-diff-progressive-container, #files, [data-diff-anchor], [data-path][data-tagsearch-path], .js-file"
    )) {
      return 0;
    }
    return void 0;
  }
  function findDeferredStatusEndpoint(doc, baseUrl = GITHUB_ORIGIN, expectedHeadSha = "") {
    const base = new URL(baseUrl, GITHUB_ORIGIN);
    const baseOrigin = base.origin;
    const baseMatch = base.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    const expectedOwner = baseMatch?.[1] || "";
    const expectedRepo = baseMatch?.[2] || "";
    const expectedNumber = baseMatch?.[3] || "";
    const currentHeadSha = String(expectedHeadSha || "").trim() || doc.querySelector('input[name="head_sha"]')?.getAttribute("value")?.trim() || "";
    const candidateAttributes = [
      "data-status-details-url",
      "data-checks-status-url",
      "data-checks-url",
      "data-details-url",
      "data-url",
      "href"
    ];
    const candidates = [];
    for (const attribute of candidateAttributes) {
      for (const node of doc.querySelectorAll(`[${attribute}]`)) {
        const value = node.getAttribute(attribute);
        const candidate = classifyDeferredStatusCandidate(value, baseUrl, {
          baseOrigin,
          expectedOwner,
          expectedRepo,
          expectedNumber
        });
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
    for (const script of doc.querySelectorAll("script")) {
      const text2 = script.textContent || "";
      const matches = text2.match(
        /https?:\/\/[^"'\\s]+\/[^"'\\s]+\/[^"'\\s]+\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)[^"'\\s]*/g
      ) || [];
      for (const match of matches) {
        const candidate = classifyDeferredStatusCandidate(match, baseUrl, {
          baseOrigin,
          expectedOwner,
          expectedRepo,
          expectedNumber
        });
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
    const preferredCurrentOid = currentHeadSha ? candidates.find((candidate) => candidate.type === "commit_status_icon" && candidate.oid === currentHeadSha) : null;
    if (currentHeadSha) {
      return preferredCurrentOid?.url || null;
    }
    const dedupedCandidates = [];
    const seenUrls = /* @__PURE__ */ new Set();
    for (const candidate of candidates) {
      if (seenUrls.has(candidate.url)) {
        continue;
      }
      seenUrls.add(candidate.url);
      dedupedCandidates.push(candidate);
    }
    const iconCandidates = dedupedCandidates.filter((candidate) => candidate.type === "commit_status_icon");
    if (iconCandidates.length) {
      return iconCandidates.at(-1).url;
    }
    return dedupedCandidates[0]?.url || null;
  }
  function mergeNativeDetails(primary, fallback) {
    const left = primary || {};
    const right = fallback || {};
    const merged = {
      review: left.review && left.review !== "unknown" ? left.review : right.review || "unknown",
      checks: left.checks && left.checks !== "unknown" ? left.checks : right.checks || "unknown",
      merge: left.merge && left.merge !== "unknown" ? left.merge : right.merge || "unknown",
      draft: typeof left.draft === "boolean" ? left.draft : right.draft
    };
    const createdAt = normalizeTimestamp(left.createdAt || right.createdAt);
    if (createdAt) {
      merged.createdAt = createdAt;
    }
    const unresolvedThreads = Number.isInteger(left.unresolvedThreads) ? left.unresolvedThreads : Number.isInteger(right.unresolvedThreads) ? right.unresolvedThreads : void 0;
    if (Number.isInteger(unresolvedThreads) && unresolvedThreads >= 0) {
      merged.unresolvedThreads = unresolvedThreads;
    }
    const jiraReferences = normalizeJiraReferences(
      Array.isArray(left.jiraReferences) && left.jiraReferences.length ? left.jiraReferences : right.jiraReferences
    );
    if (jiraReferences.length) {
      merged.jiraReferences = jiraReferences;
    }
    const jiraBaseUrl = normalizeJiraBaseUrl(left.jiraBaseUrl || right.jiraBaseUrl);
    if (jiraBaseUrl) {
      merged.jiraBaseUrl = jiraBaseUrl;
    }
    return merged;
  }
  function normalizeTimestamp(value) {
    const raw = text(value).trim();
    if (!raw) {
      return "";
    }
    return Number.isNaN(new Date(raw).getTime()) ? "" : raw;
  }
  function createdAtFromDom(doc) {
    const selectors = [
      ".gh-header-meta relative-time[datetime]",
      '[data-test-selector="pr-timestamp"] relative-time[datetime]',
      ".timeline-comment-header relative-time[datetime]",
      "relative-time[datetime]"
    ];
    for (const selector of selectors) {
      const timestamp = normalizeTimestamp(doc.querySelector(selector)?.getAttribute("datetime"));
      if (timestamp) {
        return timestamp;
      }
    }
    return "";
  }
  function extractJiraReferences(doc) {
    const references = [];
    const seenKeys = /* @__PURE__ */ new Set();
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const reference = jiraReferenceFromAnchor(anchor, doc.baseURI);
      if (!reference || seenKeys.has(reference.key)) {
        continue;
      }
      seenKeys.add(reference.key);
      references.push(reference);
    }
    return references;
  }
  function jiraReferenceFromAnchor(anchor, baseUrl = GITHUB_ORIGIN) {
    const url = normalizeReferenceUrl(anchor.getAttribute("href"), baseUrl);
    if (!url) {
      return null;
    }
    const browseKey = extractIssueKeysFromBrowseUrl(url)[0] || "";
    const labelKey = extractJiraIssueKeys(anchor.textContent)[0] || "";
    if (!browseKey || labelKey && labelKey !== browseKey) {
      return null;
    }
    return { key: browseKey, url };
  }
  function extractIssueKeysFromBrowseUrl(url) {
    const match = String(url).match(/\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/gi) || [];
    return match.map((entry) => entry.match(/([A-Z][A-Z0-9]+-\d+)/i)?.[1]?.toUpperCase() || "").filter(Boolean);
  }
  function normalizeReferenceUrl(value, baseUrl = GITHUB_ORIGIN) {
    return normalizeHttpUrl(value, baseUrl);
  }
  function normalizeJiraReferences(references) {
    const normalized = [];
    const seenKeys = /* @__PURE__ */ new Set();
    for (const reference of Array.isArray(references) ? references : []) {
      const key = extractJiraIssueKeys(reference?.key)[0] || "";
      const url = normalizeReferenceUrl(reference?.url);
      if (!key || !url || seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      normalized.push({ key, url });
    }
    return normalized;
  }
  function jiraBaseUrlFromReferences(references) {
    for (const reference of references) {
      const baseUrl = normalizeJiraBaseUrl(reference?.url, reference?.key);
      if (baseUrl) {
        return baseUrl;
      }
    }
    return "";
  }
  function normalizeJiraBaseUrl(value, issueKey = "") {
    const url = normalizeReferenceUrl(value);
    if (!url) {
      return "";
    }
    if (/\/browse\/?$/i.test(new URL(url).pathname)) {
      return url.endsWith("/") ? url : `${url}/`;
    }
    const key = extractJiraIssueKeys(issueKey)[0] || extractIssueKeysFromBrowseUrl(url)[0] || "";
    if (!key) {
      return "";
    }
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(new RegExp(`^(.*\\/browse\\/)${key}$`, "i"));
      return match ? `${parsed.origin}${match[1]}` : "";
    } catch {
      return "";
    }
  }
  function isResolvedThread(thread) {
    if (thread.matches('.is-resolved, [data-resolved="true" i], [data-is-resolved="true" i]') || thread.querySelector('.is-resolved, [data-resolved="true" i], [data-is-resolved="true" i]')) {
      return true;
    }
    const controlsText = [...thread.querySelectorAll("button, input[type='submit']")].map((node) => node.textContent || node.getAttribute("value") || "").join(" ");
    return /unresolve (?:conversation|thread)/i.test(controlsText);
  }
  function extractNestedPayloadDetail(root, expectedNumber) {
    if (!root || typeof root !== "object") {
      return null;
    }
    const candidates = [
      root.payload?.pullRequestsLayoutRoute?.pullRequest,
      root.pullRequestsLayoutRoute?.pullRequest,
      root.props?.pullRequest,
      root.data?.repository?.pullRequest,
      root.pullRequest
    ];
    for (const candidate of candidates) {
      if (!matchesPullRequestNumber(candidate, expectedNumber)) {
        continue;
      }
      const detail = parsePrDetailPayload(candidate);
      if (detail) {
        return detail;
      }
    }
    if (expectedNumber && !matchesPullRequestNumber(root, expectedNumber, true)) {
      return null;
    }
    return parsePrDetailPayload(root);
  }
  function matchesPullRequestNumber(candidate, expectedNumber, requireIdentity = false) {
    if (!candidate || typeof candidate !== "object" || !expectedNumber) {
      return !requireIdentity;
    }
    const candidateNumber = Number(candidate.number);
    if (Number.isInteger(candidateNumber)) {
      return candidateNumber === expectedNumber;
    }
    const identity = String(candidate.url || candidate.permalink || candidate.resourcePath || "");
    if (identity) {
      return new RegExp(`/pull/${expectedNumber}(?:/|$)`).test(identity);
    }
    return !requireIdentity;
  }
  function pullRequestNumber(baseUrl) {
    const match = String(baseUrl || "").match(/\/pull\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
  }
  function classifyDeferredStatusCandidate(value, baseUrl, { baseOrigin, expectedOwner, expectedRepo, expectedNumber }) {
    if (!value || !/\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)/.test(value)) {
      return null;
    }
    try {
      const resolved = new URL(value, baseUrl);
      if (resolved.origin !== baseOrigin) {
        return null;
      }
      const match = resolved.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/([^?#]+)$/);
      if (!match) {
        return null;
      }
      const [, owner, repo, number, suffix] = match;
      if (owner !== expectedOwner || repo !== expectedRepo || number !== expectedNumber) {
        return null;
      }
      const type = /partials\/commit_status_icon$/.test(suffix) ? "commit_status_icon" : "other";
      return {
        url: resolved.href,
        type,
        oid: type === "commit_status_icon" ? resolved.searchParams.get("oid") || "" : ""
      };
    } catch {
      return null;
    }
  }

  // src/models.js
  var SORT_FIELDS = Object.freeze({
    updated: "updated",
    repository: "repository",
    status: "status",
    title: "title",
    number: "number",
    review: "review",
    checks: "checks"
  });
  var SORT_DIRECTIONS = Object.freeze({
    asc: "asc",
    desc: "desc"
  });
  var DEFAULT_SORT_PREFERENCES = Object.freeze({
    primary: {
      field: SORT_FIELDS.updated,
      direction: SORT_DIRECTIONS.desc
    },
    secondary: {
      field: SORT_FIELDS.repository,
      direction: SORT_DIRECTIONS.asc
    }
  });
  var DEFAULT_FILTER_PREFERENCES = Object.freeze({
    hideDrafts: false,
    repository: "all",
    review: "all",
    checks: "all"
  });
  var SORT_FIELD_SET = new Set(Object.values(SORT_FIELDS));
  var SORT_DIRECTION_SET = new Set(Object.values(SORT_DIRECTIONS));
  var PERSONAL_STATUS_ORDER = new Map(PERSONAL_STATUSES.map((status, index) => [status, index]));
  var REVIEW_ORDER = new Map(REVIEW_STATES.map((status, index) => [status, index]));
  var CHECK_ORDER = new Map(CHECK_STATES.map((status, index) => [status, index]));
  var PERSONAL_STATUS_LABELS = /* @__PURE__ */ new Map([
    ["unsorted", "Unsorted"],
    ["next_up", "Next up"],
    ["waiting", "Waiting"],
    ["blocked", "Blocked"],
    ["done", "Done"]
  ]);
  var REVIEW_LABELS = /* @__PURE__ */ new Map([
    ["approved", "Approved"],
    ["changes_requested", "Changes requested"],
    ["required", "Review required"],
    ["none", "No review required"],
    ["unknown", "Review unknown"]
  ]);
  var CHECK_LABELS = /* @__PURE__ */ new Map([
    ["passing", "Checks passing"],
    ["failing", "Checks failing"],
    ["pending", "Checks pending"],
    ["none", "No checks"],
    ["unknown", "Checks unknown"]
  ]);
  function createPrKey(owner, repo, number) {
    return `${owner}/${repo}#${number}`;
  }
  function parsePrUrl(input) {
    const url = new URL(input, GITHUB_ORIGIN);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }
    const [, owner, repo, number] = match;
    return {
      owner,
      repo,
      number: Number(number),
      key: createPrKey(owner, repo, Number(number)),
      url: `${url.origin}/${owner}/${repo}/pull/${number}`
    };
  }
  function normalizeTag(rawTag) {
    const name = typeof rawTag?.name === "string" ? rawTag.name.trim() : "";
    if (!name) {
      return null;
    }
    const color = TAG_COLORS.includes(rawTag?.color) ? rawTag.color : "gray";
    return { name, color };
  }
  function normalizeTags(rawTags) {
    const deduped = /* @__PURE__ */ new Map();
    for (const tag of Array.isArray(rawTags) ? rawTags : []) {
      const normalized = normalizeTag(tag);
      if (!normalized) {
        continue;
      }
      const key = normalized.name.toLocaleLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, normalized);
      }
    }
    return [...deduped.values()];
  }
  function normalizeRecord(rawRecord = {}) {
    const status = PERSONAL_STATUSES.includes(rawRecord.status) ? rawRecord.status : DEFAULT_RECORD.status;
    return {
      status,
      blockedBy: typeof rawRecord.blockedBy === "string" ? rawRecord.blockedBy : "",
      notes: typeof rawRecord.notes === "string" ? rawRecord.notes : "",
      tags: normalizeTags(rawRecord.tags),
      modifiedAt: Number.isFinite(rawRecord.modifiedAt) ? rawRecord.modifiedAt : 0
    };
  }
  function normalizeEnvelope(rawEnvelope, login) {
    const records = {};
    const sourceRecords = rawEnvelope?.records && typeof rawEnvelope.records === "object" ? rawEnvelope.records : {};
    for (const [key, record] of Object.entries(sourceRecords)) {
      records[key] = normalizeRecord(record);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      accountLogin: login,
      records,
      openListCache: normalizeOpenListCache(rawEnvelope?.openListCache),
      detailCache: normalizeDetailCache(rawEnvelope?.detailCache),
      sortPreferences: normalizeSortPreferences(rawEnvelope?.sortPreferences),
      filterPreferences: normalizeFilterPreferences(rawEnvelope?.filterPreferences),
      collapsedGroups: normalizeCollapsedGroups(rawEnvelope?.collapsedGroups)
    };
  }
  function normalizeCollapsedGroups(rawCollapsedGroups) {
    const normalized = [];
    const seen = /* @__PURE__ */ new Set();
    for (const value of Array.isArray(rawCollapsedGroups) ? rawCollapsedGroups : []) {
      if (typeof value !== "string") {
        continue;
      }
      const key = value.trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(key);
      if (normalized.length >= MAX_COLLAPSED_GROUPS) {
        break;
      }
    }
    return normalized;
  }
  function normalizeOpenListCache(rawCache) {
    const items = Array.isArray(rawCache?.items) ? rawCache.items : [];
    return {
      updatedAt: Number.isFinite(rawCache?.updatedAt) ? rawCache.updatedAt : 0,
      items: items.filter((item) => item && typeof item.key === "string" && typeof item.url === "string")
    };
  }
  function normalizeDetailCache(rawCache) {
    const cache = {};
    const input = rawCache && typeof rawCache === "object" ? rawCache : {};
    for (const [key, value] of Object.entries(input)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      cache[key] = {
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
        parserVersion: Number.isFinite(value.parserVersion) ? value.parserVersion : 0,
        detail: value.detail && typeof value.detail === "object" ? value.detail : {},
        headSha: typeof value.headSha === "string" ? value.headSha : "",
        checksUrl: typeof value.checksUrl === "string" ? value.checksUrl : ""
      };
    }
    return cache;
  }
  function mergeImportedRecords(currentRecords, incomingRecords) {
    const merged = { ...currentRecords };
    for (const [key, record] of Object.entries(incomingRecords)) {
      const normalized = normalizeRecord(record);
      const existing = merged[key];
      if (!existing || normalized.modifiedAt >= existing.modifiedAt) {
        merged[key] = normalized;
      }
    }
    return merged;
  }
  function normalizeSortPreferences(rawPreferences) {
    const primary = normalizeSortLevel(rawPreferences?.primary, DEFAULT_SORT_PREFERENCES.primary);
    const hasSecondaryPreference = Boolean(rawPreferences) && Object.hasOwn(rawPreferences, "secondary");
    const secondary = normalizeSecondarySortLevel(
      hasSecondaryPreference ? rawPreferences.secondary : void 0,
      primary.field,
      { useDefaultWhenMissing: !hasSecondaryPreference }
    );
    return {
      primary,
      secondary
    };
  }
  function normalizeFilterPreferences(rawPreferences) {
    const repository = typeof rawPreferences?.repository === "string" ? rawPreferences.repository.trim() : "";
    return {
      hideDrafts: rawPreferences?.hideDrafts === true,
      repository: repository && repository.toLocaleLowerCase() !== "all" ? repository : DEFAULT_FILTER_PREFERENCES.repository,
      review: REVIEW_STATES.includes(rawPreferences?.review) ? rawPreferences.review : DEFAULT_FILTER_PREFERENCES.review,
      checks: CHECK_STATES.includes(rawPreferences?.checks) ? rawPreferences.checks : DEFAULT_FILTER_PREFERENCES.checks
    };
  }
  function getAvailableSortOptions(summaries) {
    return [
      { value: SORT_FIELDS.updated, label: "Updated" },
      { value: SORT_FIELDS.repository, label: "Repository" },
      { value: SORT_FIELDS.status, label: "My status" },
      { value: SORT_FIELDS.title, label: "Title" },
      { value: SORT_FIELDS.number, label: "PR number" },
      { value: SORT_FIELDS.review, label: "Review state" },
      { value: SORT_FIELDS.checks, label: "Checks state" }
    ];
  }
  function getAvailableGroupOptions(summaries) {
    return getAvailableSortOptions(summaries).map((option) => {
      if (option.value === SORT_FIELDS.updated) {
        return { ...option, label: "Updated timeframe" };
      }
      if (option.value === SORT_FIELDS.title) {
        return { ...option, label: "Title initial" };
      }
      if (option.value === SORT_FIELDS.number) {
        return { ...option, label: "PR number range" };
      }
      return option;
    });
  }
  function normalizeSortPreferencesForSummaries(rawPreferences, summaries) {
    const availableFields = new Set(getAvailableSortOptions(summaries).map((option) => option.value));
    const normalized = normalizeSortPreferences(rawPreferences);
    const primaryMatchesRequested = availableFields.has(normalized.primary.field);
    const primary = primaryMatchesRequested ? normalized.primary : DEFAULT_SORT_PREFERENCES.primary;
    const secondaryMatchesRequested = normalized.secondary ? availableFields.has(normalized.secondary.field) && normalized.secondary.field !== primary.field : false;
    const secondary = secondaryMatchesRequested ? normalized.secondary : !primaryMatchesRequested ? defaultSecondaryForPrimary(primary.field, availableFields) : null;
    return {
      primary,
      secondary
    };
  }
  function sortSummaries({ summaries, records, sortPreferences }) {
    const normalizedPreferences = normalizeSortPreferencesForSummaries(sortPreferences, summaries);
    return [...summaries].sort((left, right) => {
      const leftRecord = records[left.key] || DEFAULT_RECORD;
      const rightRecord = records[right.key] || DEFAULT_RECORD;
      const comparisons = [normalizedPreferences.primary, normalizedPreferences.secondary].filter(Boolean);
      for (const level of comparisons) {
        const result = compareSortLevel(level, left, right, leftRecord, rightRecord);
        if (result !== 0) {
          return result;
        }
      }
      const repoFallback = compareText(repositoryName(left), repositoryName(right), SORT_DIRECTIONS.asc);
      if (repoFallback !== 0) {
        return repoFallback;
      }
      const numberFallback = compareNumber(left.number, right.number, SORT_DIRECTIONS.asc);
      if (numberFallback !== 0) {
        return numberFallback;
      }
      return compareText(left.key, right.key, SORT_DIRECTIONS.asc);
    });
  }
  function groupSummaries({ summaries, records, sortPreferences, currentTime = Date.now() }) {
    const normalizedPreferences = normalizeSortPreferencesForSummaries(sortPreferences, summaries);
    const groups = [];
    const groupsByKey = /* @__PURE__ */ new Map();
    for (const summary of summaries) {
      const record = records[summary.key] || DEFAULT_RECORD;
      const descriptor = describeGroup(normalizedPreferences.primary.field, summary, record, currentTime);
      let group = groupsByKey.get(descriptor.key);
      if (!group) {
        group = { ...descriptor, summaries: [] };
        groupsByKey.set(descriptor.key, group);
        groups.push(group);
      }
      group.summaries.push(summary);
    }
    return groups;
  }
  function validateImportEnvelope(rawEnvelope) {
    if (!rawEnvelope || typeof rawEnvelope !== "object") {
      throw new Error("Import must be a JSON object.");
    }
    if (!rawEnvelope.accountLogin || typeof rawEnvelope.accountLogin !== "string") {
      throw new Error("Import is missing accountLogin.");
    }
    if (!rawEnvelope.records || typeof rawEnvelope.records !== "object") {
      throw new Error("Import is missing records.");
    }
    return true;
  }
  function filterSummaries({
    summaries,
    records,
    search,
    statusFilter,
    tagFilter,
    showCompleted,
    filterPreferences
  }) {
    const normalizedSearch = (search || "").trim().toLocaleLowerCase();
    const normalizedFilters = normalizeFilterPreferences(filterPreferences);
    return summaries.filter((summary) => {
      const record = records[summary.key] || DEFAULT_RECORD;
      if (!showCompleted && record.status === "done") {
        return false;
      }
      if (statusFilter !== "all" && record.status !== statusFilter) {
        return false;
      }
      if (tagFilter && !record.tags.some((tag) => tag.name.toLocaleLowerCase() === tagFilter.toLocaleLowerCase())) {
        return false;
      }
      if (normalizedFilters.hideDrafts && summary.draft === true) {
        return false;
      }
      if (normalizedFilters.repository !== "all" && repositoryName(summary).toLocaleLowerCase() !== normalizedFilters.repository.toLocaleLowerCase()) {
        return false;
      }
      if (normalizedFilters.review !== "all" && (summary.review || "unknown") !== normalizedFilters.review) {
        return false;
      }
      if (normalizedFilters.checks !== "all" && (summary.checks || "unknown") !== normalizedFilters.checks) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const haystack = [
        summary.title,
        summary.repo,
        String(summary.number),
        record.blockedBy,
        record.notes,
        ...record.tags.map((tag) => tag.name)
      ].join("\n").toLocaleLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }
  function normalizeSortLevel(rawLevel, fallback) {
    const field = SORT_FIELD_SET.has(rawLevel?.field) ? rawLevel.field : fallback.field;
    const direction = SORT_DIRECTION_SET.has(rawLevel?.direction) ? rawLevel.direction : fallback.direction;
    return { field, direction };
  }
  function normalizeSecondarySortLevel(rawLevel, primaryField, { useDefaultWhenMissing = false } = {}) {
    if (rawLevel == null || rawLevel.field === "none") {
      return useDefaultWhenMissing ? defaultSecondaryForPrimary(primaryField) : null;
    }
    const fallback = defaultSecondaryForPrimary(primaryField) || {
      field: SORT_FIELDS.repository,
      direction: SORT_DIRECTIONS.asc
    };
    const level = normalizeSortLevel(rawLevel, fallback);
    return level.field === primaryField ? defaultSecondaryForPrimary(primaryField) : level;
  }
  function defaultSecondaryForPrimary(primaryField, availableFields = SORT_FIELD_SET) {
    if (primaryField !== SORT_FIELDS.repository && availableFields.has(SORT_FIELDS.repository)) {
      return { ...DEFAULT_SORT_PREFERENCES.secondary };
    }
    if (primaryField !== SORT_FIELDS.updated && availableFields.has(SORT_FIELDS.updated)) {
      return { ...DEFAULT_SORT_PREFERENCES.primary };
    }
    return null;
  }
  function compareSortLevel(level, leftSummary, rightSummary, leftRecord, rightRecord) {
    switch (level.field) {
      case SORT_FIELDS.updated:
        return compareUpdated(leftSummary.updatedAt, rightSummary.updatedAt, level.direction);
      case SORT_FIELDS.repository:
        return compareText(repositoryName(leftSummary), repositoryName(rightSummary), level.direction);
      case SORT_FIELDS.status:
        return compareRank(PERSONAL_STATUS_ORDER, leftRecord.status, rightRecord.status, level.direction);
      case SORT_FIELDS.title:
        return compareText(leftSummary.title, rightSummary.title, level.direction);
      case SORT_FIELDS.number:
        return compareNumber(leftSummary.number, rightSummary.number, level.direction);
      case SORT_FIELDS.review:
        return compareRank(REVIEW_ORDER, leftSummary.review, rightSummary.review, level.direction);
      case SORT_FIELDS.checks:
        return compareRank(CHECK_ORDER, leftSummary.checks, rightSummary.checks, level.direction);
      default:
        return 0;
    }
  }
  function compareUpdated(leftValue, rightValue, direction) {
    const leftTimestamp = normalizeUpdatedTimestamp(leftValue);
    const rightTimestamp = normalizeUpdatedTimestamp(rightValue);
    if (leftTimestamp === null && rightTimestamp === null) {
      return 0;
    }
    if (leftTimestamp === null) {
      return 1;
    }
    if (rightTimestamp === null) {
      return -1;
    }
    return direction === SORT_DIRECTIONS.asc ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  }
  function normalizeUpdatedTimestamp(value) {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function compareText(leftValue, rightValue, direction) {
    const leftText = String(leftValue || "");
    const rightText = String(rightValue || "");
    const result = leftText.localeCompare(rightText, void 0, { sensitivity: "base", numeric: true });
    return direction === SORT_DIRECTIONS.desc ? result * -1 : result;
  }
  function compareNumber(leftValue, rightValue, direction) {
    const leftNumber = Number.isFinite(leftValue) ? leftValue : Number.POSITIVE_INFINITY;
    const rightNumber = Number.isFinite(rightValue) ? rightValue : Number.POSITIVE_INFINITY;
    return direction === SORT_DIRECTIONS.desc ? rightNumber - leftNumber : leftNumber - rightNumber;
  }
  function compareRank(rankMap, leftValue, rightValue, direction) {
    const leftKnown = rankMap.has(leftValue) && leftValue !== "unknown";
    const rightKnown = rankMap.has(rightValue) && rightValue !== "unknown";
    if (!leftKnown && !rightKnown) {
      return 0;
    }
    if (!leftKnown) {
      return 1;
    }
    if (!rightKnown) {
      return -1;
    }
    const leftRank = rankMap.get(leftValue);
    const rightRank = rankMap.get(rightValue);
    return direction === SORT_DIRECTIONS.desc ? rightRank - leftRank : leftRank - rightRank;
  }
  function repositoryName(summary) {
    return [summary.owner, summary.repo].filter(Boolean).join("/");
  }
  function describeGroup(field, summary, record, currentTime) {
    switch (field) {
      case SORT_FIELDS.repository: {
        const repository = repositoryName(summary) || "Repository unknown";
        return { key: `repository:${repository.toLocaleLowerCase()}`, label: summary.repo || repository };
      }
      case SORT_FIELDS.status: {
        const status = record.status || "unsorted";
        return { key: `status:${status}`, label: PERSONAL_STATUS_LABELS.get(status) || humanize(status) };
      }
      case SORT_FIELDS.review: {
        const review = summary.review || "unknown";
        return { key: `review:${review}`, label: REVIEW_LABELS.get(review) || humanize(review) };
      }
      case SORT_FIELDS.checks: {
        const checks = summary.checks || "unknown";
        return { key: `checks:${checks}`, label: CHECK_LABELS.get(checks) || humanize(checks) };
      }
      case SORT_FIELDS.title:
        return describeTitleGroup(summary.title);
      case SORT_FIELDS.number:
        return describeNumberGroup(summary.number);
      case SORT_FIELDS.updated:
      default:
        return describeUpdatedGroup(summary.updatedAt, currentTime);
    }
  }
  function describeUpdatedGroup(value, currentTime) {
    const timestamp = normalizeUpdatedTimestamp(value);
    if (timestamp === null) {
      return { key: "updated:unknown", label: "Update date unavailable" };
    }
    const startOfToday = new Date(currentTime);
    startOfToday.setHours(0, 0, 0, 0);
    const oneDay = 24 * 60 * 60 * 1e3;
    const today = startOfToday.getTime();
    if (timestamp >= today) {
      return { key: "updated:today", label: "Updated today" };
    }
    if (timestamp >= today - oneDay) {
      return { key: "updated:yesterday", label: "Updated yesterday" };
    }
    if (timestamp >= today - 7 * oneDay) {
      return { key: "updated:week", label: "Updated in the previous 7 days" };
    }
    if (timestamp >= today - 30 * oneDay) {
      return { key: "updated:month", label: "Updated in the previous 30 days" };
    }
    return { key: "updated:older", label: "Updated more than 30 days ago" };
  }
  function describeTitleGroup(value) {
    const firstCharacter = String(value || "").trim().charAt(0).toLocaleUpperCase();
    if (/^[A-Z0-9]$/u.test(firstCharacter)) {
      return { key: `title:${firstCharacter}`, label: `Titles beginning with ${firstCharacter}` };
    }
    return { key: "title:other", label: "Other titles" };
  }
  function describeNumberGroup(value) {
    if (!Number.isFinite(value) || value < 0) {
      return { key: "number:unknown", label: "PR number unavailable" };
    }
    const lower = Math.floor(value / 100) * 100;
    const upper = lower + 99;
    return {
      key: `number:${lower}`,
      label: `PRs #${lower.toLocaleString()}\u2013#${upper.toLocaleString()}`
    };
  }
  function humanize(value) {
    const label = String(value || "Unknown").replaceAll("_", " ");
    return label.charAt(0).toLocaleUpperCase() + label.slice(1);
  }

  // src/github.js
  function isTrackerRoute(location) {
    const url = typeof location === "string" ? new URL(location, GITHUB_ORIGIN) : new URL(location.href);
    const isPullsRoute = url.pathname === "/pulls" || url.pathname === "/pulls/inbox";
    const hasTrackerMarker = url.hash === "#pr-tracker" || url.searchParams.get("pr_tracker") === "1";
    return isPullsRoute && hasTrackerMarker;
  }
  function trackerUrl() {
    return "/pulls#pr-tracker";
  }
  function detectCurrentLogin(doc = document) {
    const selectors = [
      'meta[name="user-login"]',
      'meta[name="octolytics-actor-login"]'
    ];
    for (const selector of selectors) {
      const value = doc.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }
    const link = doc.querySelector('a[data-hovercard-type="user"][href^="/"]');
    const href = link?.getAttribute("href")?.replace(/^\/+/, "").trim();
    return href || null;
  }
  function ensureTrackerNav(doc = document) {
    if (doc.getElementById("pr-tracker-nav-link")) {
      return;
    }
    const candidates = [...doc.querySelectorAll("nav, [role='navigation'], .UnderlineNav-body, .AppHeader-context-full")];
    const targetLink = candidates.flatMap((container2) => [...container2.querySelectorAll('a[href^="/pulls"], a[href*="/pulls?"]')].map((link2) => ({ container: container2, link: link2 }))).find(({ link: link2 }) => !link2.closest("#pr-tracker-nav-link"));
    if (!targetLink) {
      return;
    }
    const { container, link: referenceLink } = targetLink;
    const link = doc.createElement("a");
    link.id = "pr-tracker-nav-link";
    link.href = trackerUrl();
    link.textContent = "My tracker";
    link.setAttribute("data-pr-tracker-nav", "true");
    if (referenceLink.className) {
      link.className = referenceLink.className;
    }
    if (referenceLink.parentElement === container) {
      referenceLink.insertAdjacentElement("afterend", link);
    } else {
      container.append(link);
    }
  }
  function parsePullListDocument(doc, origin = GITHUB_ORIGIN) {
    const grouped = /* @__PURE__ */ new Map();
    for (const anchor of doc.querySelectorAll('a[href*="/pull/"]')) {
      const href = anchor.getAttribute("href");
      if (!href) {
        continue;
      }
      const resolved = new URL(href, origin).href;
      if (!isSameOriginGitHubUrl(resolved)) {
        continue;
      }
      const parsed = parsePrUrl(resolved);
      if (!parsed) {
        continue;
      }
      const row = anchor.closest('[data-issue-and-pr-hovercards-enabled], .js-issue-row, [role="row"], li[id^="issue_"], .Box-row') || anchor.closest("li, article, section");
      const group = grouped.get(parsed.key) || { parsed, anchors: [], row };
      group.anchors.push(anchor);
      if (!group.row && row) {
        group.row = row;
      }
      grouped.set(parsed.key, group);
    }
    const items = [];
    for (const { parsed, anchors, row } of grouped.values()) {
      const titleAnchor = selectTitleAnchor(anchors, parsed);
      const title = titleAnchor?.textContent?.trim() || "";
      if (!title) {
        continue;
      }
      const updatedAt = row?.querySelector("relative-time")?.getAttribute("datetime") || "";
      const draft = parseListDraftState(row, titleAnchor);
      const listDetail = parsePullListDetail(row, parsed);
      items.push({
        key: parsed.key,
        url: parsed.url,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        title,
        updatedAt,
        draft,
        ...listDetail
      });
    }
    const nextHref = doc.querySelector('a[rel="next"]')?.getAttribute("href") || [...doc.querySelectorAll("a")].find((anchor) => /^next$/i.test(anchor.textContent.trim()))?.getAttribute("href") || null;
    const nextUrl = nextHref ? new URL(nextHref, origin).href : null;
    return { items, nextHref: nextUrl && isSameOriginGitHubUrl(nextUrl) ? nextUrl : null };
  }
  function parseListDraftState(row, titleAnchor) {
    if (!row) {
      return false;
    }
    if (row.querySelector('[data-state="draft" i], [data-draft="true" i], .State--draft')) {
      return true;
    }
    const semanticDraft = [...row.querySelectorAll("[aria-label], [title]")].some((node) => {
      const label = [node.getAttribute("aria-label"), node.getAttribute("title")].filter(Boolean).join(" ");
      return node !== titleAnchor && /^\s*(?:open )?draft(?: pull request)?\s*$/i.test(label);
    });
    if (semanticDraft) {
      return true;
    }
    return [...row.querySelectorAll("span, strong, small")].some(
      (node) => node !== titleAnchor && !node.closest("a") && node.children.length === 0 && /^\s*draft\s*$/i.test(node.textContent || "")
    );
  }
  async function fetchHtml(fetchImpl, url) {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.text();
  }
  async function fetchOpenPrs({ fetchImpl, parser, startUrl = trackerSearchUrl() }) {
    const seenUrls = /* @__PURE__ */ new Set();
    const allItems = [];
    let nextUrl = isSameOriginGitHubUrl(startUrl) ? startUrl : trackerSearchUrl();
    while (nextUrl && !seenUrls.has(nextUrl)) {
      seenUrls.add(nextUrl);
      const html = await fetchHtml(fetchImpl, nextUrl);
      const doc = parser(html);
      const { items, nextHref } = parsePullListDocument(doc);
      for (const item of items) {
        if (!allItems.some((existing) => existing.key === item.key)) {
          allItems.push(item);
        }
      }
      nextUrl = nextHref && isSameOriginGitHubUrl(nextHref) ? nextHref : null;
    }
    return allItems;
  }
  function trackerSearchUrl(login = "@me") {
    const url = new URL("/pulls", GITHUB_ORIGIN);
    url.searchParams.set("q", `is:open is:pr archived:false author:${login || "@me"}`);
    return url.href;
  }
  function isSameOriginGitHubUrl(value) {
    try {
      const url = new URL(value, GITHUB_ORIGIN);
      return url.origin === GITHUB_ORIGIN;
    } catch {
      return false;
    }
  }
  function selectTitleAnchor(anchors, parsed) {
    const scored = anchors.map((anchor) => ({
      anchor,
      score: scoreAnchor(anchor, parsed)
    })).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score);
    return scored[0]?.anchor || anchors[0] || null;
  }
  function scoreAnchor(anchor, parsed) {
    const text2 = anchor.textContent?.trim() || "";
    if (!text2) {
      return 0;
    }
    let score = text2.length;
    if (text2 === `${parsed.owner}/${parsed.repo}` || text2 === `#${parsed.number}`) {
      score -= 100;
    }
    if (/^\d+$/.test(text2) || /^#\d+$/.test(text2)) {
      score -= 100;
    }
    if (anchor.matches('[data-hovercard-type="pull_request"], [id*="issue_"], [data-test-selector]')) {
      score += 20;
    }
    return score;
  }
  function parsePullListDetail(row, parsed) {
    if (!row) {
      return { review: "unknown", checks: "unknown", merge: "unknown" };
    }
    const rowText = row.textContent || "";
    let review = "unknown";
    if (/changes requested|requested changes/i.test(rowText)) {
      review = "changes_requested";
    } else if (/review required/i.test(rowText)) {
      review = "required";
    } else if (/\bapproved\b/i.test(rowText)) {
      review = "approved";
    }
    const checkRoots = [...row.querySelectorAll(
      '[data-checks-state], .commit-build-statuses, [aria-label*="check" i], img[alt*="check" i], [class~="status-check" i], [class~="check-status" i]'
    )];
    const checkRoot = checkRoots.filter(
      (node) => node.matches("[data-checks-state]") || node.matches(".commit-build-statuses") && node.querySelector('summary, [aria-label*="check" i], img[alt*="check" i]')
    ).at(-1) || checkRoots.at(-1);
    const checkNodes = checkRoot ? [
      checkRoot,
      ...checkRoot.querySelectorAll(
        'summary, [aria-label*="check" i], img[alt*="check" i], [data-checks-state]'
      )
    ] : [];
    const checkText = checkNodes.map((node) => [
      node.getAttribute("aria-label"),
      node.getAttribute("alt"),
      node.getAttribute("data-checks-state"),
      node.getAttribute("class"),
      node.textContent
    ].filter(Boolean).join(" ")).join(" ");
    const totals = checkText.match(/(\d+)\s*\/\s*(\d+)\s*checks? OK/i);
    let checks = "unknown";
    if (/color-fg-danger|octicon-x|failing|failed/i.test(checkText)) {
      checks = "failing";
    } else if (/color-fg-attention|pending|expected|running|in progress/i.test(checkText)) {
      checks = "pending";
    } else if (/color-fg-success|successful|passed/i.test(checkText)) {
      checks = "passing";
    } else if (totals && totals[1] === totals[2]) {
      checks = "passing";
    }
    const currentHead = parseCurrentHeadStatus(row, parsed);
    return {
      review,
      checks,
      merge: "unknown",
      ...currentHead.headSha ? { headSha: currentHead.headSha } : {},
      ...currentHead.checksUrl ? { checksUrl: currentHead.checksUrl } : {}
    };
  }
  function parseCurrentHeadStatus(row, parsed) {
    const checksUrl = resolveCurrentHeadStatusUrl(
      row.querySelector(".commit-build-statuses[data-deferred-details-content-url], [data-deferred-details-content-url]")?.getAttribute("data-deferred-details-content-url"),
      parsed
    );
    const urlHeadSha = headShaFromChecksUrl(checksUrl);
    const attributeHeadSha = row.querySelector(".commit-build-statuses[data-head-sha], [data-head-sha]")?.getAttribute("data-head-sha")?.trim();
    if (attributeHeadSha && urlHeadSha && attributeHeadSha.toLowerCase() !== urlHeadSha.toLowerCase()) {
      return rejectCurrentHeadStatus();
    }
    return {
      headSha: resolveCurrentHeadSha(urlHeadSha, attributeHeadSha),
      checksUrl
    };
  }
  function resolveCurrentHeadStatusUrl(value, parsed) {
    if (!value || !parsed) {
      return "";
    }
    try {
      const url = new URL(value, GITHUB_ORIGIN);
      if (url.origin !== GITHUB_ORIGIN) {
        return "";
      }
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{40})\/status-details$/i);
      if (!match) {
        return "";
      }
      const [, owner, repo] = match;
      if (owner !== parsed.owner || repo !== parsed.repo) {
        return "";
      }
      if (url.searchParams.get("popover") !== "true") {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }
  function headShaFromChecksUrl(checksUrl) {
    const match = String(checksUrl || "").match(/\/commit\/([0-9a-f]{40})\/status-details(?:\?|$)/i);
    return match ? match[1] : "";
  }
  function resolveCurrentHeadSha(urlHeadSha, attributeHeadSha) {
    if (!urlHeadSha) {
      return "";
    }
    if (!attributeHeadSha) {
      return urlHeadSha;
    }
    return attributeHeadSha.toLowerCase() === urlHeadSha.toLowerCase() ? urlHeadSha : "";
  }
  function rejectCurrentHeadStatus() {
    return {
      headSha: "",
      checksUrl: ""
    };
  }

  // src/github-actions.js
  var FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
  var HTML_ACCEPT = "text/html,application/xhtml+xml";
  async function squashMergePullRequest({ fetchImpl, parser, summary }) {
    return submitPullRequestAction({
      fetchImpl,
      parser,
      summary,
      action: "merge",
      configure(form, fields) {
        requireSuccessfulFields(fields, ["authenticity_token", "head_sha", "commit_title", "commit_message"]);
        const squashControl = form.querySelector('input[type="hidden"][name="do"]');
        if (!squashControl || squashControl.value !== "squash" || squashControl.matches(":disabled")) {
          throw new Error("The native squash merge form is missing its squash action control.");
        }
        if (!fields.get("authenticity_token") || !fields.get("head_sha")) {
          throw new Error("The native squash merge form is missing required authenticated values.");
        }
        fields.set("commit_message", "");
        fields.set("do", "squash");
      },
      expectedState: "merged"
    });
  }
  async function closePullRequest({ fetchImpl, parser, summary, comment = "" }) {
    return submitPullRequestAction({
      fetchImpl,
      parser,
      summary,
      action: "close",
      configure(form, fields) {
        requireSuccessfulFields(fields, ["authenticity_token", "comment[body]"]);
        const closeButton = form.querySelector('button[name="comment_and_close"]');
        if (!closeButton || closeButton.value !== "1" || closeButton.matches(":disabled")) {
          throw new Error("The native close form is missing its comment-and-close submit control.");
        }
        if (!fields.get("authenticity_token")) {
          throw new Error("The native close form is missing its authenticated value.");
        }
        fields.set("comment[body]", String(comment ?? ""));
        fields.set("comment_and_close", "1");
      },
      expectedState: "closed"
    });
  }
  async function submitPullRequestAction({ fetchImpl, parser, summary, action, configure, expectedState }) {
    if (typeof fetchImpl !== "function" || typeof parser !== "function") {
      throw new TypeError("A fetch implementation and HTML parser are required.");
    }
    const pullRequest = parseCanonicalPullRequest(summary);
    const getResponse = await fetchImpl(summary.url, {
      credentials: "include",
      headers: { Accept: HTML_ACCEPT }
    });
    assertOkResponse(getResponse, `Loading pull request #${pullRequest.number}`);
    const pageHtml = await getResponse.text();
    const pageDocument = parseDocument(parser, pageHtml, pullRequest.url.href);
    const { form, actionUrl } = findNativeForm(pageDocument, pullRequest, action);
    const fields = serializeSuccessfulControls(form);
    configure(form, fields);
    const postResponse = await fetchImpl(actionUrl.href, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: HTML_ACCEPT,
        "Content-Type": FORM_CONTENT_TYPE
      },
      body: fields.toString()
    });
    assertOkResponse(postResponse, `${action === "merge" ? "Merging" : "Closing"} pull request #${pullRequest.number}`);
    const responseHtml = await postResponse.text();
    const responseDocument = parseDocument(parser, responseHtml, pullRequest.url.href);
    if (!documentConfirmsState(responseDocument, expectedState)) {
      throw new Error(`GitHub did not confirm that pull request #${pullRequest.number} was ${expectedState}.`);
    }
    return { state: expectedState };
  }
  function parseCanonicalPullRequest(summary) {
    if (!summary || typeof summary.url !== "string" || !summary.url) {
      throw new TypeError("A pull request summary with a URL is required.");
    }
    let url;
    try {
      url = new URL(summary.url);
    } catch {
      throw new Error("The pull request URL is invalid.");
    }
    if (url.origin !== GITHUB_ORIGIN) {
      throw new Error("The pull request URL must use the authenticated GitHub origin.");
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
    if (!match || url.search || url.hash) {
      throw new Error("The pull request URL must identify one canonical pull request.");
    }
    const [, owner, repo, numberText] = match;
    const number = Number(numberText);
    if (summary.owner != null && String(summary.owner) !== owner || summary.repo != null && String(summary.repo) !== repo || summary.number != null && Number(summary.number) !== number) {
      throw new Error("The pull request summary does not match its URL.");
    }
    return {
      url,
      owner,
      repo,
      number,
      path: `/${owner}/${repo}/pull/${numberText}`
    };
  }
  function findNativeForm(doc, pullRequest, action) {
    const expectedPath = action === "merge" ? `${pullRequest.path}/merge` : `${pullRequest.path}/comment`;
    for (const form of doc.querySelectorAll("form")) {
      if ((form.getAttribute("method") || "get").trim().toLowerCase() !== "post") {
        continue;
      }
      const rawAction = form.getAttribute("action");
      if (!rawAction) {
        continue;
      }
      let actionUrl;
      try {
        actionUrl = new URL(rawAction, pullRequest.url);
      } catch {
        continue;
      }
      if (actionUrl.origin !== pullRequest.url.origin || actionUrl.pathname !== expectedPath || actionUrl.hash) {
        continue;
      }
      if (action === "merge" && actionUrl.search) {
        continue;
      }
      if (action === "close" && !hasExactStickyQuery(actionUrl)) {
        continue;
      }
      return { form, actionUrl };
    }
    throw new Error(`No valid same-origin native ${action} form was found for this pull request.`);
  }
  function hasExactStickyQuery(url) {
    const entries = [...url.searchParams.entries()];
    return entries.length === 1 && entries[0][0] === "sticky" && entries[0][1] === "true";
  }
  function serializeSuccessfulControls(form) {
    const fields = new URLSearchParams();
    for (const control of form.elements) {
      const name = control.getAttribute("name") || "";
      if (!name || control.matches(":disabled")) {
        continue;
      }
      const tagName = control.tagName.toLowerCase();
      if (tagName === "button") {
        continue;
      }
      if (tagName === "select") {
        for (const option of control.selectedOptions) {
          if (!option.disabled) {
            fields.append(name, option.value);
          }
        }
        continue;
      }
      const type = (control.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset", "image", "file"].includes(type)) {
        continue;
      }
      if (["checkbox", "radio"].includes(type) && !control.checked) {
        continue;
      }
      fields.append(name, control.value);
    }
    return fields;
  }
  function requireSuccessfulFields(fields, names) {
    for (const name of names) {
      if (!fields.has(name)) {
        throw new Error(`The native form is missing the required ${name} control.`);
      }
    }
  }
  function parseDocument(parser, html, url) {
    const doc = parser(html, url);
    if (!doc || typeof doc.querySelectorAll !== "function") {
      throw new Error("The HTML parser did not return a document.");
    }
    return doc;
  }
  function assertOkResponse(response, context) {
    if (!response || !response.ok) {
      const status = response?.status == null ? "unknown" : response.status;
      throw new Error(`${context} failed with HTTP ${status}.`);
    }
  }
  function documentConfirmsState(doc, state) {
    const title = state[0].toUpperCase() + state.slice(1);
    const selectors = [
      `.State--${state}`,
      `[title="Status: ${title}"]`,
      `[aria-label="Status: ${title}"]`,
      `[data-test-selector="pr-state"][data-state="${state}"]`,
      `[aria-label="Pull request state"][data-state="${state}"]`
    ];
    for (const element of doc.querySelectorAll(selectors.join(","))) {
      const semanticValue = [
        element.getAttribute("data-state"),
        element.getAttribute("title")?.replace(/^Status:\s*/i, ""),
        element.getAttribute("aria-label")?.replace(/^(?:Status:\s*|Pull request state\s*:?\s*)/i, ""),
        element.textContent
      ].filter(Boolean).map((value) => value.trim().toLowerCase());
      if (semanticValue.includes(state)) {
        return true;
      }
    }
    return false;
  }

  // src/styles.js
  var styles = `
:host {
  display: block;
  width: 100%;
  min-width: 0;
  color: var(--fgColor-default, #1f2328);
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
}
* {
  box-sizing: border-box;
}
button,
input,
select,
textarea {
  font: inherit;
}
button,
select {
  cursor: pointer;
}
.tracker-root {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
  padding: 24px 24px 56px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  margin: 0 0 20px;
}
.page-heading {
  min-width: 0;
}
.page-heading h1 {
  margin: 0;
  color: var(--fgColor-default, #1f2328);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
}
.page-subtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 6px;
  color: var(--fgColor-muted, #59636e);
}
.privacy-note::before {
  content: "\u25CF";
  margin-right: 6px;
  color: var(--fgColor-success, #1a7f37);
  font-size: 8px;
  vertical-align: 2px;
}
.page-header input[type="search"] {
  width: min(360px, 38vw);
  height: 36px;
  padding: 7px 12px 7px 34px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 8px;
  background-color: var(--bgColor-default, #ffffff);
  background-image: radial-gradient(circle, transparent 5px, var(--fgColor-muted, #59636e) 5px, var(--fgColor-muted, #59636e) 6px, transparent 6px), linear-gradient(45deg, transparent 46%, var(--fgColor-muted, #59636e) 47%, var(--fgColor-muted, #59636e) 54%, transparent 55%);
  background-position: 10px 10px, 22px 22px;
  background-repeat: no-repeat;
  background-size: 14px 14px, 7px 7px;
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-inset, inset 0 1px 0 rgba(31,35,40,0.04));
}
.tracker-shell {
  display: grid;
  grid-template-columns: 172px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.tracker-shell.has-drawer {
  grid-template-columns: 172px minmax(0, 1fr) minmax(340px, 380px);
}
.status-sidebar {
  position: sticky;
  top: 20px;
  min-width: 0;
}
.eyebrow {
  margin: 0 10px 8px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.filters {
  display: grid;
  gap: 3px;
}
.filter-btn,
.sidebar-action {
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fgColor-default, #1f2328);
  text-align: left;
}
.filter-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
}
.filter-btn:hover,
.sidebar-action:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
}
.filter-btn[aria-pressed="true"] {
  background: var(--control-transparent-bgColor-selected, rgba(175,184,193,0.22));
  box-shadow: inset 3px 0 0 var(--borderColor-accent-emphasis, #0969da);
  font-weight: 600;
}
.filter-label::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  vertical-align: 1px;
}
.filter-btn[data-status="all"] .filter-label::before,
.filter-btn[data-status="next_up"] .filter-label::before {
  background: var(--fgColor-accent, #0969da);
}
.filter-btn[data-status="waiting"] .filter-label::before {
  background: var(--fgColor-attention, #9a6700);
}
.filter-btn[data-status="blocked"] .filter-label::before {
  background: var(--fgColor-danger, #d1242f);
}
.filter-btn[data-status="done"] .filter-label::before {
  background: var(--fgColor-success, #1a7f37);
}
.filter-count {
  min-width: 26px;
  padding: 1px 7px;
  border: 1px solid var(--borderColor-muted, #d8dee4);
  border-radius: 999px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  text-align: center;
}
.sidebar-tools {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.sidebar-action {
  padding: 7px 10px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.sidebar-action[aria-pressed="true"] {
  color: var(--fgColor-accent, #0969da);
}
.backup-menu {
  margin-top: 14px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.backup-menu summary {
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  list-style-position: inside;
}
.backup-menu summary:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
}
.backup-actions {
  margin-top: 3px;
  padding-left: 10px;
}
.panel,
.drawer {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 10px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-resting-small, 0 1px 0 rgba(31,35,40,0.04));
}
.panel-header {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--borderColor-muted, #d8dee4);
  background: var(--bgColor-muted, #f6f8fa);
}
.result-count {
  font-size: 14px;
  font-weight: 600;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sort-menu,
.structured-filter-menu {
  position: relative;
}
.sort-summary,
.filter-summary {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 7px;
  background: var(--button-default-bgColor-rest, var(--bgColor-default, #ffffff));
  color: var(--button-default-fgColor-rest, var(--fgColor-default, #1f2328));
  font-size: 13px;
  font-weight: 500;
  list-style: none;
  user-select: none;
}
.sort-summary::-webkit-details-marker,
.filter-summary::-webkit-details-marker {
  display: none;
}
.sort-summary::after,
.filter-summary::after {
  content: "\u25BE";
  margin-left: 8px;
  color: var(--fgColor-muted, #59636e);
  font-size: 11px;
}
.sort-menu[open] .sort-summary,
.structured-filter-menu[open] .filter-summary,
.sort-summary:hover,
.filter-summary:hover {
  background: var(--button-default-bgColor-hover, var(--bgColor-neutral-muted, #eaeef2));
}
.sort-rows,
.filter-popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 8px);
  right: 0;
  display: grid;
  gap: 10px;
  min-width: 320px;
  padding: 12px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 10px;
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  box-shadow: var(--shadow-floating-large, 0 12px 28px rgba(31,35,40,0.15));
}
.filter-popover {
  min-width: 280px;
}
.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
  font-weight: 500;
}
.filter-checkbox input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--fgColor-accent, #0969da);
}
.structured-filter-row {
  display: grid;
  gap: 4px;
}
.filter-row-label {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  font-weight: 600;
}
.structured-filter-row select {
  width: 100%;
  height: 32px;
  padding: 5px 9px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 6px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
}
.clear-filters {
  justify-self: start;
  min-height: 28px;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fgColor-accent, #0969da);
  font-size: 12px;
  font-weight: 500;
}
.clear-filters:hover:not(:disabled) {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
}
.clear-filters:disabled {
  color: var(--fgColor-muted, #59636e);
  cursor: default;
  opacity: 0.65;
}
.sort-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 118px;
  gap: 8px;
  align-items: center;
}
.sort-row-label {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  font-weight: 600;
}
.sort-row select {
  height: 32px;
  padding: 5px 9px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 6px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
}
.sort-row select:disabled {
  color: var(--fgColor-muted, #59636e);
  background: var(--bgColor-muted, #f6f8fa);
}
.action-btn,
.link-btn,
.icon-btn {
  border: 1px solid var(--borderColor-default, #d1d9e0);
  background: var(--button-default-bgColor-rest, var(--bgColor-muted, #f6f8fa));
  color: var(--button-default-fgColor-rest, var(--fgColor-default, #1f2328));
  text-decoration: none;
}
.action-btn {
  min-height: 32px;
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
}
.action-btn:hover,
.icon-btn:hover {
  background: var(--button-default-bgColor-hover, var(--bgColor-neutral-muted, #eaeef2));
}
.action-btn:disabled {
  cursor: default;
  opacity: 0.65;
}
.list {
  display: grid;
  gap: 8px;
  background: var(--bgColor-muted, #f6f8fa);
}
.pr-group {
  min-width: 0;
  background: var(--bgColor-default, #ffffff);
}
.pr-group-header {
  min-height: 38px;
  border-bottom: 1px solid var(--borderColor-muted, #d8dee4);
  background: var(--bgColor-neutral-muted, rgba(175,184,193,0.14));
}
.pr-group-title {
  margin: 0;
}
.pr-group-toggle {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}
.pr-group-toggle:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.08));
}
.pr-group-chevron {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
}
.pr-group-label {
  min-width: 0;
  overflow: hidden;
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-group-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--borderColor-muted, #d8dee4);
  border-radius: 999px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-muted, #59636e);
  font-size: 11px;
  font-weight: 600;
}
.pr-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "select controls"
    "tags controls";
  align-items: center;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.pr-group-rows > .pr-row:first-child {
  border-top: 0;
}
.pr-row:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.08));
}
.pr-row:has(.pr-row-select[aria-selected="true"]) {
  background: var(--bgColor-accent-muted, rgba(84,174,255,0.12));
  box-shadow: inset 3px 0 0 var(--borderColor-accent-emphasis, #0969da);
}
.pr-row-select {
  grid-area: select;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 13px;
  width: 100%;
  min-width: 0;
  padding: 14px 12px 12px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}
.pr-icon {
  width: 10px;
  height: 10px;
  margin-top: 21px;
  border: 2px solid var(--fgColor-open, var(--fgColor-success, #1a7f37));
  border-radius: 50%;
}
.row-copy {
  display: block;
  min-width: 0;
}
.title,
.repo,
.row-header,
.row-details,
.blocker-preview {
  display: block;
}
.row-header {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 2px;
}
.note-preview,
.personal-hint {
  display: block;
  overflow: hidden;
  margin-top: 5px;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-preview {
  color: var(--fgColor-default, #1f2328);
}
.personal-hint {
  color: var(--fgColor-muted, #59636e);
  opacity: 0.72;
}
.pr-row:hover .personal-hint,
.pr-row:focus-within .personal-hint {
  color: var(--fgColor-accent, #0969da);
  opacity: 1;
}
.title {
  overflow: hidden;
  color: var(--fgColor-default, #1f2328);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
}
.repo {
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.age-badge {
  font-size: 11px;
  font-weight: 600;
}
.row-details {
  display: grid;
  gap: 5px;
  margin-top: 7px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
}
.row-metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}
.row-status-lines {
  display: grid;
  gap: 4px;
  justify-items: start;
}
.native-status-line {
  display: block;
}
.jira-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
}
.jira-link {
  color: var(--fgColor-accent, #0969da);
  text-decoration: none;
}
.jira-link:hover {
  text-decoration: underline;
}
.thread-count::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 6px;
  margin-right: 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
  vertical-align: 0;
}
.badge {
  white-space: nowrap;
}
.badge::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  vertical-align: 1px;
}
.badge[data-state="approved"]::before,
.badge[data-state="passing"]::before,
.badge[data-state="clean"]::before {
  background: var(--fgColor-success, #1a7f37);
}
.badge[data-state="failing"]::before,
.badge[data-state="changes_requested"]::before,
.badge[data-state="conflicting"]::before,
.badge[data-state="blocked"]::before {
  background: var(--fgColor-danger, #d1242f);
}
.badge[data-state="pending"]::before,
.badge[data-state="required"]::before {
  background: var(--fgColor-attention, #9a6700);
}
.badge[data-state="unknown"] {
  opacity: 0.68;
}
.blocker-preview {
  overflow: hidden;
  margin-top: 5px;
  color: var(--fgColor-danger, #d1242f);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-controls {
  grid-area: controls;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 14px 0 8px;
}
.row-open-link {
  min-height: 32px;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--fgColor-accent, #0969da);
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  text-decoration: none;
  white-space: nowrap;
}
.row-open-link:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
  text-decoration: underline;
}
.row-merge-action {
  min-width: 64px;
  white-space: nowrap;
}
.quick-status {
  position: relative;
  width: 156px;
  margin: 0;
}
.quick-status::before {
  content: "";
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 11px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  transform: translateY(-50%);
  pointer-events: none;
}
.quick-status[data-status="next_up"]::before {
  background: var(--fgColor-accent, #0969da);
}
.quick-status[data-status="waiting"]::before {
  background: var(--fgColor-attention, #9a6700);
}
.quick-status[data-status="blocked"]::before {
  background: var(--fgColor-danger, #d1242f);
}
.quick-status[data-status="done"]::before {
  background: var(--fgColor-success, #1a7f37);
}
.status-select,
.drawer select,
.drawer textarea,
.drawer input[type="text"] {
  width: 100%;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 7px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-inset, inset 0 1px 0 rgba(31,35,40,0.04));
}
.status-select {
  height: 34px;
  padding: 5px 28px 5px 28px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.row-tags {
  grid-area: tags;
  padding: 0 12px 12px 41px;
}
.tag-pill {
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 6px;
  font-size: 12px;
}
.drawer {
  position: sticky;
  top: 20px;
  display: grid;
  gap: 20px;
  max-height: calc(100vh - 40px);
  padding: 20px;
  overflow: auto;
}
.drawer[hidden] {
  display: none;
}
.drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.drawer-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.drawer-subtitle,
.save-state {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  border-color: transparent;
  border-radius: 7px;
  background: transparent;
  font-size: 22px;
  line-height: 1;
}
.drawer-identity {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--borderColor-muted, #d8dee4);
}
.drawer-identity .title {
  white-space: normal;
}
.identity-jira[hidden] {
  display: none;
}
.identity-jira {
  margin-top: 8px;
}
.pr-actions {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--borderColor-muted, #d8dee4);
  border-radius: 8px;
  background: var(--bgColor-muted, #f6f8fa);
}
.pr-action-buttons,
.close-prompt-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.merge-action {
  border-color: var(--borderColor-success-emphasis, #1a7f37);
  background: var(--button-primary-bgColor-rest, #1f883d);
  color: var(--button-primary-fgColor-rest, #ffffff);
}
.merge-action:hover:not(:disabled) {
  background: var(--button-primary-bgColor-hover, #1a7f37);
}
.close-action,
.close-confirm {
  color: var(--fgColor-danger, #d1242f);
}
.close-confirm {
  border-color: var(--borderColor-danger-emphasis, #cf222e);
}
.close-prompt {
  display: grid;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.drawer .close-comment {
  min-height: 76px;
  margin-top: 6px;
  font-weight: 400;
}
.pr-action-error {
  padding: 8px 10px;
  border: 1px solid var(--borderColor-danger-muted, rgba(255,129,130,0.4));
  border-radius: 6px;
  background: var(--bgColor-danger-muted, rgba(255,129,130,0.15));
  color: var(--fgColor-danger, #d1242f);
  font-size: 12px;
}
.field {
  display: grid;
  gap: 7px;
}
.field[hidden] {
  display: none;
}
.field-label {
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
  font-weight: 600;
}
.lifecycle-list {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--borderColor-muted, #d8dee4);
  border-radius: 8px;
}
.lifecycle-row {
  display: grid;
  grid-template-columns: minmax(112px, 1fr) auto;
  gap: 2px 12px;
  padding: 8px 10px;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
  font-size: 12px;
}
.lifecycle-row:first-child {
  border-top: 0;
}
.lifecycle-row-label {
  color: var(--fgColor-muted, #59636e);
}
.lifecycle-row-detail {
  color: var(--fgColor-default, #1f2328);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-align: right;
}
.lifecycle-row-note,
.lifecycle-empty {
  grid-column: 1 / -1;
  color: var(--fgColor-muted, #59636e);
  font-size: 11px;
  line-height: 1.35;
}
.lifecycle-empty {
  padding: 10px;
}
.drawer select,
.drawer input[type="text"] {
  height: 36px;
  padding: 7px 10px;
}
.drawer textarea {
  min-height: 150px;
  padding: 9px 10px;
  line-height: 1.5;
  resize: vertical;
}
.tag-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px auto;
  gap: 7px;
}
.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}
.save-state {
  min-height: 18px;
}
.link-btn {
  border: 0;
  background: transparent;
  color: var(--fgColor-accent, #0969da);
  font-size: 13px;
}
.warning {
  margin: 12px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--borderColor-attention-muted, #d4a72c66);
  border-radius: 7px;
  background: var(--bgColor-attention-muted, #fff8c5);
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
}
.warning[hidden] {
  display: none;
}
.empty {
  display: grid;
  place-items: center;
  gap: 5px;
  min-height: 240px;
  padding: 36px 20px;
  color: var(--fgColor-muted, #59636e);
  text-align: center;
}
.empty strong {
  color: var(--fgColor-default, #1f2328);
  font-size: 16px;
}
.empty span {
  font-size: 13px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
:focus-visible {
  outline: 2px solid var(--focus-outlineColor, var(--borderColor-accent-emphasis, #0969da));
  outline-offset: 2px;
}
@media (max-width: 1180px) {
  .tracker-shell.has-drawer {
    grid-template-columns: 172px minmax(0, 1fr);
  }
  .drawer {
    position: fixed;
    z-index: 1000;
    top: 76px;
    right: 18px;
    bottom: 18px;
    width: min(380px, calc(100vw - 36px));
    max-height: none;
    background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
    box-shadow: var(--shadow-floating-large, 0 8px 24px rgba(31,35,40,0.18));
  }
}
@media (max-width: 820px) {
  .tracker-root {
    padding: 20px 12px 36px;
  }
  .page-header {
    align-items: stretch;
    flex-direction: column;
    gap: 16px;
  }
  .page-header input[type="search"] {
    width: 100%;
  }
  .tracker-shell,
  .tracker-shell.has-drawer {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .panel-header {
    align-items: flex-start;
  }
  .panel-actions {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .status-sidebar {
    position: static;
  }
  .filters {
    display: flex;
    overflow-x: auto;
  }
  .filter-btn {
    width: auto;
    min-width: max-content;
  }
  .sidebar-tools {
    display: none;
  }
  .sort-rows {
    min-width: min(320px, calc(100vw - 48px));
  }
  .filter-popover {
    min-width: min(280px, calc(100vw - 48px));
  }
}
@media (max-width: 620px) {
  .panel-header,
  .drawer-footer {
    flex-direction: column;
    align-items: stretch;
  }
  .sort-row {
    grid-template-columns: 1fr;
  }
  .pr-row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "select"
      "tags"
      "controls";
  }
  .row-controls {
    flex-wrap: wrap;
    margin: 0 16px 14px 52px;
  }
  .quick-status {
    flex: 1;
    width: auto;
    min-width: 140px;
  }
}
`;

  // src/pr-lifecycle.js
  var MS_PER_MINUTE = 60 * 1e3;
  var MS_PER_HOUR = 60 * MS_PER_MINUTE;
  var MS_PER_DAY = 24 * MS_PER_HOUR;
  var LIFECYCLE_VERSION = 2;
  var TIMELINE_EVENT_PATTERNS = Object.freeze([
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
  var LIFECYCLE_PHASE_ORDER = Object.freeze([
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
  function buildLifecycleSnapshot({
    summary = {},
    detail = {},
    prDocument,
    observedAt,
    previousLifecycle = null
  }) {
    const previous = normalizePreviousLifecycle(previousLifecycle);
    const observedAtIso = normalizeObservationTimestamp(observedAt, previous?.observedAt);
    const createdAt = normalizeTimestamp2(detail.createdAt || previous?.createdAt);
    const timelineEvents = parseTimelineEvents(prDocument);
    const mergedAt = parseMergedAt(prDocument, timelineEvents);
    const terminalAt = mergedAt || observedAtIso;
    const isMerged = Boolean(mergedAt);
    const draftActive = typeof detail.draft === "boolean" ? detail.draft : Boolean(summary.draft);
    const unresolvedThreads = Number.isInteger(detail.unresolvedThreads) ? detail.unresolvedThreads : null;
    const checksPassingActive = summary.checks === "passing";
    const changesRequestedActive = detail.review === "changes_requested";
    const exactDraftPhase = createdAt ? deriveExactBooleanPhase({
      key: "draft",
      createdAt,
      terminalAt,
      currentActive: draftActive,
      events: timelineEvents.filter((event) => event.type === "draft_entered" || event.type === "ready_for_review").map((event) => ({
        timestamp: event.timestamp,
        activeAfter: event.type === "draft_entered"
      })),
      isTerminal: isMerged
    }) : unavailableDurationPhase("draft", "Draft timing requires a PR creation timestamp.");
    const draftPhase = exactDraftPhase.availability === "exact" ? exactDraftPhase : deriveObservedBooleanPhase({
      key: "draft",
      currentActive: draftActive,
      observedAt: observedAtIso,
      previousPhase: previous?.phases?.draft,
      previousObservedAt: previous?.observedAt,
      terminalAt,
      note: "Draft timing is bounded by refresh observations because GitHub did not expose full draft history."
    });
    const openPhase = createdAt && terminalAt ? durationPhaseFromIntervals("open", [{
      startAt: createdAt,
      endAt: terminalAt,
      ongoing: !isMerged
    }], {
      availability: "exact",
      current: !isMerged,
      note: isMerged ? "Merged PRs close the open interval at merge time." : "Open intervals stop at the stored observation time."
    }) : unavailableDurationPhase("open", "Open timing requires a PR creation timestamp.");
    const readyForReviewPhase = createdAt && draftPhase.availability === "exact" ? buildReadyForReviewPhase({
      createdAt,
      terminalAt,
      draftIntervals: draftPhase.intervals,
      currentDraft: draftActive,
      isMerged
    }) : deriveObservedBooleanPhase({
      key: "ready_for_review",
      currentActive: !draftActive,
      observedAt: observedAtIso,
      previousPhase: previous?.phases?.ready_for_review,
      previousObservedAt: previous?.observedAt,
      terminalAt,
      note: "Ready-for-review time is bounded by refresh observations because exact draft history is unavailable."
    });
    const changesRequestedExactPhase = createdAt ? deriveExactBooleanPhase({
      key: "changes_requested",
      createdAt,
      terminalAt,
      currentActive: changesRequestedActive,
      events: timelineEvents.filter((event) => event.type === "changes_requested" || event.type === "review_approved").map((event) => ({
        timestamp: event.timestamp,
        activeAfter: event.type === "changes_requested"
      })),
      isTerminal: isMerged,
      note: "Derived from explicit review-decision events only."
    }) : unavailableDurationPhase("changes_requested", "Changes-requested timing requires a PR creation timestamp.");
    const changesRequestedPhase = changesRequestedExactPhase.availability === "exact" ? changesRequestedExactPhase : deriveObservedBooleanPhase({
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
  function summarizeLifecyclePhases(lifecycle) {
    const phases = lifecycle?.phases || {};
    return LIFECYCLE_PHASE_ORDER.map((key) => summarizeLifecyclePhase(key, phases[key])).filter(Boolean);
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
      return phase.enteredAt ? { key, label, detail: formatTimestamp(phase.enteredAt), note: phase.note || "" } : { key, label, detail: "Not merged", note: phase.note || "" };
    }
    return null;
  }
  function deriveExactBooleanPhase({ key, createdAt, terminalAt, currentActive, events, isTerminal = false, note = "" }) {
    if (!createdAt || !terminalAt) {
      return unavailableDurationPhase(key, "This phase requires created and observation timestamps.");
    }
    const filteredEvents = [...events || []].filter((event) => event.timestamp >= createdAt && event.timestamp <= terminalAt).sort((left, right) => compareTimestamps(left.timestamp, right.timestamp));
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
    const sortedDraftIntervals = [...draftIntervals || []].sort((left, right) => compareTimestamps(left.startAt, right.startAt));
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
      const prior2 = normalizeDurationPhase(previousPhase, key);
      if (!prior2) {
        return unavailableDurationPhase(key, note || "This signal is unavailable for the current snapshot.");
      }
      const intervals2 = normalizeIntervals(prior2.intervals);
      const lastKnownAt = normalizeTimestamp2(previousObservedAt) || intervals2.at(-1)?.endAt || "";
      if (prior2.current && lastKnownAt) {
        closeLastInterval(intervals2, lastKnownAt);
      }
      return durationPhaseFromIntervals(key, intervals2, {
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
    const hasPriorDiscussionHistory = Boolean(previousDiscussionsPhase?.intervals?.length) || Boolean(currentDiscussionsPhase?.intervals?.length) || Boolean(previousDiscussionsPhase?.current);
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
    const sortedEvents = events.filter((event) => event.type === "review_requested" || event.type === "review_request_removed").sort((left, right) => compareTimestamps(left.timestamp, right.timestamp));
    const outstanding = /* @__PURE__ */ new Set();
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
      note: isMerged ? "Newly-opened is the initial non-draft interval before explicit review activity." : "Newly-opened ends at the first explicit review activity."
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
        const timestamp = normalizeTimestamp2(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
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
      note: uniqueComments.length ? "Issue comments are counted separately from review decisions and review threads." : "Issue-comment timing is unavailable in the current snapshot markup."
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
      const timestamp = normalizeTimestamp2(relativeTime.getAttribute("datetime"));
      if (!timestamp) {
        continue;
      }
      const scope = relativeTime.closest(
        ".TimelineItem, .js-timeline-item, .timeline-comment-group, .discussion-item, article, li, details, div"
      ) || relativeTime.parentElement;
      const text2 = normalizeWhitespace(scope?.textContent || "");
      for (const { type, pattern } of TIMELINE_EVENT_PATTERNS) {
        if (pattern.test(text2)) {
          events.push({ type, timestamp, text: text2 });
        }
      }
    }
    return dedupeTimelineEvents(events);
  }
  function dedupeTimelineEvents(events) {
    const deduped = [];
    const seen = /* @__PURE__ */ new Set();
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
      const timestamp = normalizeTimestamp2(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
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
      const text2 = normalizeWhitespace(node.textContent || "");
      if (!(/\bmerged commit\b/i.test(text2) || /\bmerged this pull request\b/i.test(text2))) {
        continue;
      }
      const timestamp = normalizeTimestamp2(node.querySelector("relative-time[datetime]")?.getAttribute("datetime"));
      if (timestamp) {
        return timestamp;
      }
    }
    return "";
  }
  function parseReviewRequestTarget(text2) {
    const normalized = normalizeWhitespace(text2);
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
    return (Array.isArray(intervals) ? intervals : []).filter((interval) => interval?.startAt && interval?.endAt).map((interval) => ({
      startAt: normalizeTimestamp2(interval.startAt),
      endAt: normalizeTimestamp2(interval.endAt),
      ongoing: Boolean(interval.ongoing)
    })).filter((interval) => interval.startAt && interval.endAt && interval.endAt >= interval.startAt).sort((left, right) => compareTimestamps(left.startAt, right.startAt));
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
    const normalized = normalizeTimestamp2(value);
    if (normalized) {
      return normalized;
    }
    return normalizeTimestamp2(fallback);
  }
  function normalizeTimestamp2(value) {
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
    return new Intl.DateTimeFormat(void 0, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(timestamp);
  }
  function formatDuration(value) {
    const totalMs = Number.isFinite(value) ? Math.max(0, value) : 0;
    const days = Math.floor(totalMs / MS_PER_DAY);
    const hours = Math.floor(totalMs % MS_PER_DAY / MS_PER_HOUR);
    const minutes = Math.floor(totalMs % MS_PER_HOUR / MS_PER_MINUTE);
    if (days > 0) {
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${minutes}m`;
  }

  // src/ui.js
  var STATUS_LABELS = {
    unsorted: "Unsorted",
    next_up: "Next up",
    waiting: "Waiting",
    blocked: "Blocked",
    done: "Done"
  };
  var REVIEW_FILTER_LABELS = {
    approved: "Approved",
    changes_requested: "Changes requested",
    required: "Review required",
    none: "No review required",
    unknown: "Review unavailable"
  };
  var CHECK_FILTER_LABELS = {
    passing: "Passing",
    failing: "Failing",
    pending: "Pending",
    none: "No checks",
    unknown: "Checks unavailable"
  };
  var REVIEW_ROW_LABELS = {
    approved: "Review approved",
    changes_requested: "Changes requested",
    required: "Review needed",
    none: "No review needed"
  };
  var CHECK_ROW_LABELS = {
    passing: "Checks passing",
    failing: "Checks failing",
    pending: "Checks pending",
    none: "No checks"
  };
  function createUi(container, handlers) {
    const doc = container.ownerDocument;
    const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    const root = doc.createElement("div");
    root.className = "tracker-root";
    shadow.replaceChildren(style, root);
    const containEditorKeyboardEvent = (event) => {
      const origin = event.composedPath?.()[0] || event.target;
      if (origin instanceof HTMLElement && (origin.matches("input, textarea, select") || origin.closest("[contenteditable='true']"))) {
        event.stopPropagation();
      }
    };
    shadow.addEventListener("keydown", containEditorKeyboardEvent);
    shadow.addEventListener("keypress", containEditorKeyboardEvent);
    shadow.addEventListener("keyup", containEditorKeyboardEvent);
    const pageHeader = doc.createElement("header");
    pageHeader.className = "page-header";
    const heading = doc.createElement("div");
    heading.className = "page-heading";
    const pageTitle = doc.createElement("h1");
    pageTitle.textContent = "My pull requests";
    const pageSubtitle = doc.createElement("div");
    pageSubtitle.className = "page-subtitle";
    const subtitleText = doc.createElement("span");
    subtitleText.textContent = "A private workspace for pull requests you opened";
    const privacy = doc.createElement("span");
    privacy.className = "privacy-note";
    privacy.textContent = container.dataset.trackerVersion && container.dataset.trackerVersion !== "unknown" ? `Stored in this browser \xB7 v${container.dataset.trackerVersion}` : "Stored in this browser";
    pageSubtitle.append(subtitleText, privacy);
    heading.append(pageTitle, pageSubtitle);
    const search = doc.createElement("input");
    search.type = "search";
    search.placeholder = "Search PRs, notes, or private labels";
    search.setAttribute("aria-label", "Search pull requests");
    search.setAttribute("data-focus-id", "search");
    search.addEventListener("input", (event) => handlers.onSearch(event.target.value));
    pageHeader.append(heading, search);
    const shell = doc.createElement("div");
    shell.className = "tracker-shell";
    const sidebar = doc.createElement("nav");
    sidebar.className = "status-sidebar";
    sidebar.setAttribute("aria-label", "Personal status filters");
    const sidebarLabel = doc.createElement("div");
    sidebarLabel.className = "eyebrow";
    sidebarLabel.textContent = "My workflow";
    const filters = doc.createElement("div");
    filters.className = "filters";
    const sidebarTools = doc.createElement("div");
    sidebarTools.className = "sidebar-tools";
    const viewLabel = doc.createElement("div");
    viewLabel.className = "eyebrow";
    viewLabel.textContent = "View";
    const showCompleted = makeActionButton("", () => handlers.onToggleCompleted(), "sidebar-action");
    const exportButton = makeActionButton("Export backup", () => handlers.onExport(), "sidebar-action");
    const importButton = makeActionButton("Import backup", () => handlers.onImport(), "sidebar-action");
    const backupMenu = doc.createElement("details");
    backupMenu.className = "backup-menu";
    const backupSummary = doc.createElement("summary");
    backupSummary.textContent = "Backup & restore";
    const backupActions = doc.createElement("div");
    backupActions.className = "backup-actions";
    backupActions.append(exportButton, importButton);
    backupMenu.append(backupSummary, backupActions);
    sidebarTools.append(viewLabel, showCompleted, backupMenu);
    sidebar.append(sidebarLabel, filters, sidebarTools);
    const panel = doc.createElement("section");
    panel.className = "panel";
    const panelHeader = doc.createElement("div");
    panelHeader.className = "panel-header";
    const resultCount = doc.createElement("strong");
    resultCount.className = "result-count";
    const panelActions = doc.createElement("div");
    panelActions.className = "panel-actions";
    const filterMenu = doc.createElement("details");
    filterMenu.className = "structured-filter-menu";
    const filterSummary = doc.createElement("summary");
    filterSummary.className = "filter-summary";
    filterSummary.textContent = "Filter";
    const filterPopover = doc.createElement("div");
    filterPopover.className = "filter-popover";
    const hideDraftsLabel = doc.createElement("label");
    hideDraftsLabel.className = "filter-checkbox";
    const hideDraftsCheckbox = doc.createElement("input");
    hideDraftsCheckbox.type = "checkbox";
    hideDraftsCheckbox.setAttribute("data-focus-id", "filter-hide-drafts");
    const hideDraftsText = doc.createElement("span");
    hideDraftsText.textContent = "Hide draft PRs";
    hideDraftsLabel.append(hideDraftsCheckbox, hideDraftsText);
    const repositorySelect = makeSelect("filter-repository", "Repository filter");
    const reviewSelect = makeSelect("filter-review", "Review state filter");
    const checksSelect = makeSelect("filter-checks", "Checks state filter");
    const repositoryRow = makeFilterRow("Repository", repositorySelect);
    const reviewRow = makeFilterRow("Review state", reviewSelect);
    const checksRow = makeFilterRow("Checks state", checksSelect);
    const clearFiltersButton = makeActionButton("Clear filters", () => handlers.onClearFilters(), "clear-filters");
    filterPopover.append(hideDraftsLabel, repositoryRow, reviewRow, checksRow, clearFiltersButton);
    filterMenu.append(filterSummary, filterPopover);
    const sortMenu = doc.createElement("details");
    sortMenu.className = "sort-menu";
    const sortSummary = doc.createElement("summary");
    sortSummary.className = "sort-summary";
    sortSummary.textContent = "Sort";
    const sortRows = doc.createElement("div");
    sortRows.className = "sort-rows";
    const primaryFieldSelect = makeSelect("sort-primary-field", "Group field");
    const primaryDirectionSelect = makeSelect("sort-primary-direction", "Group direction");
    const secondaryFieldSelect = makeSelect("sort-secondary-field", "Secondary sort field");
    const secondaryDirectionSelect = makeSelect("sort-secondary-direction", "Secondary sort direction");
    const sortByRow = makeSortRow("Group by", primaryFieldSelect, primaryDirectionSelect);
    const thenByRow = makeSortRow("Then sort", secondaryFieldSelect, secondaryDirectionSelect);
    sortRows.append(sortByRow, thenByRow);
    sortMenu.append(sortSummary, sortRows);
    const refreshButton = makeActionButton("Refresh", () => handlers.onRefresh(), "action-btn");
    panelActions.append(filterMenu, sortMenu, refreshButton);
    panelHeader.append(resultCount, panelActions);
    const warning = doc.createElement("div");
    warning.className = "warning";
    warning.setAttribute("role", "alert");
    const list = doc.createElement("div");
    list.className = "list";
    panel.append(panelHeader, warning, list);
    const drawer = doc.createElement("aside");
    drawer.className = "drawer";
    drawer.setAttribute("aria-label", "Personal pull request details");
    shell.append(sidebar, panel, drawer);
    root.append(pageHeader, shell);
    const saveState = doc.createElement("div");
    saveState.className = "save-state";
    saveState.setAttribute("aria-live", "polite");
    const pendingSaves = /* @__PURE__ */ new Map();
    let focusedBeforeDrawer = null;
    let currentState = null;
    let currentSelectedKey = null;
    let closePromptKey = null;
    let drawerView = null;
    const disclosureMenus = [backupMenu, filterMenu, sortMenu];
    function dismissDisclosures(path = []) {
      for (const menu of disclosureMenus) {
        if (menu.open && !path.includes(menu)) {
          menu.open = false;
        }
      }
    }
    async function dismissDrawer({ restoreFocus: restoreFocus2 = false } = {}) {
      const key = currentState?.selectedKey;
      if (!key) {
        return;
      }
      try {
        await flushPending(key);
      } catch {
        return;
      }
      handlers.onSelect(null);
      if (restoreFocus2 && focusedBeforeDrawer instanceof HTMLElement) {
        focusedBeforeDrawer.focus();
      }
    }
    function eventPath(event) {
      return typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    }
    function onDocumentPointerDown(event) {
      const path = eventPath(event);
      dismissDisclosures(path);
      const clickedPrRow = path.some((node) => node instanceof HTMLElement && node.classList.contains("pr-row"));
      if (currentState?.selectedKey && !path.includes(drawer) && !clickedPrRow) {
        void dismissDrawer();
      }
    }
    function onDocumentKeyDown(event) {
      if (event.key !== "Escape") {
        return;
      }
      const openMenus = disclosureMenus.filter((menu) => menu.open);
      if (openMenus.length) {
        for (const menu of openMenus) {
          menu.open = false;
        }
        openMenus.at(-1)?.querySelector("summary")?.focus();
        event.preventDefault();
        return;
      }
      if (currentState?.selectedKey) {
        event.preventDefault();
        void dismissDrawer({ restoreFocus: true });
      }
    }
    doc.addEventListener("pointerdown", onDocumentPointerDown, true);
    doc.addEventListener("keydown", onDocumentKeyDown, true);
    function render(state) {
      const focusSnapshot = captureFocus();
      currentState = state;
      style.textContent = state.styles;
      updateToolbar(state);
      updateWarning(state.warning);
      renderList(state);
      renderDrawer(state);
      restoreFocus(focusSnapshot);
    }
    function updateToolbar(state) {
      if (search.value !== state.search) {
        search.value = state.search;
      }
      const availableCount = state.allSummaries.filter((summary) => {
        const record = state.records[summary.key] || DEFAULT_RECORD;
        return state.showCompleted || record.status !== "done";
      }).length;
      const visibleCount = state.filteredSummaries.length;
      resultCount.textContent = visibleCount === availableCount ? formatCount(visibleCount) : `${visibleCount} of ${formatCount(availableCount)}`;
      showCompleted.textContent = state.showCompleted ? "Hide done from All" : "Include done in All";
      showCompleted.setAttribute("aria-pressed", String(state.showCompleted));
      refreshButton.textContent = state.refreshing ? "Refreshing\u2026" : "Refresh";
      refreshButton.disabled = state.refreshing;
      renderFilterControls(state);
      renderSortControls(state);
      const counts = countStatuses(state);
      const options = ["all", ...PERSONAL_STATUSES];
      const existing = new Map([...filters.querySelectorAll("button")].map((button) => [button.dataset.status, button]));
      for (const status of options) {
        let button = existing.get(status);
        if (!button) {
          button = doc.createElement("button");
          button.type = "button";
          button.className = "filter-btn";
          button.dataset.status = status;
          button.addEventListener("click", () => handlers.onStatusFilter(status));
          const label = doc.createElement("span");
          label.className = "filter-label";
          const count = doc.createElement("span");
          count.className = "filter-count";
          button.append(label, count);
          filters.append(button);
        }
        button.querySelector(".filter-label").textContent = status === "all" ? state.showCompleted ? "All" : "All active" : STATUS_LABELS[status];
        button.querySelector(".filter-count").textContent = String(
          status === "all" ? state.showCompleted ? state.allSummaries.length : counts.active : counts[status]
        );
        button.setAttribute("aria-pressed", String(state.statusFilter === status));
        existing.delete(status);
      }
      for (const stale of existing.values()) {
        stale.remove();
      }
    }
    function renderFilterControls(state) {
      const preferences = state.filterPreferences;
      const repositoryOptions = repositoryFilterOptions(state.allSummaries, preferences.repository);
      syncSelectOptions(repositorySelect, repositoryOptions);
      syncSelectOptions(reviewSelect, [
        { value: "all", label: "All review states" },
        ...REVIEW_STATES.map((value) => ({ value, label: REVIEW_FILTER_LABELS[value] }))
      ]);
      syncSelectOptions(checksSelect, [
        { value: "all", label: "All checks states" },
        ...CHECK_STATES.map((value) => ({ value, label: CHECK_FILTER_LABELS[value] }))
      ]);
      hideDraftsCheckbox.checked = preferences.hideDrafts;
      repositorySelect.value = repositoryOptions.find(
        (option) => option.value.toLocaleLowerCase() === preferences.repository.toLocaleLowerCase()
      )?.value || preferences.repository;
      reviewSelect.value = preferences.review;
      checksSelect.value = preferences.checks;
      const activeCount = countStructuredFilters(preferences);
      filterSummary.textContent = activeCount ? `Filter \xB7 ${activeCount}` : "Filter";
      clearFiltersButton.disabled = activeCount === 0;
    }
    function renderSortControls(state) {
      syncSelectOptions(primaryFieldSelect, state.groupOptions);
      syncSelectOptions(secondaryFieldSelect, [{ value: "none", label: "None" }, ...state.sortOptions]);
      syncSelectOptions(primaryDirectionSelect, directionOptionsForField(state.sortPreferences.primary.field));
      syncSelectOptions(
        secondaryDirectionSelect,
        state.sortPreferences.secondary ? directionOptionsForField(state.sortPreferences.secondary.field) : directionOptionsForField(state.sortPreferences.primary.field)
      );
      primaryFieldSelect.value = state.sortPreferences.primary.field;
      primaryDirectionSelect.value = state.sortPreferences.primary.direction;
      secondaryFieldSelect.value = state.sortPreferences.secondary?.field || "none";
      for (const option of secondaryFieldSelect.options) {
        option.disabled = option.value === state.sortPreferences.primary.field;
      }
      secondaryDirectionSelect.disabled = !state.sortPreferences.secondary;
      secondaryDirectionSelect.value = state.sortPreferences.secondary?.direction || "asc";
      sortSummary.textContent = summarizeSort(state.sortPreferences, state.groupOptions, state.sortOptions);
    }
    function updateWarning(message) {
      warning.hidden = !message;
      warning.textContent = message || "";
    }
    function renderList(state) {
      list.textContent = "";
      if (!state.filteredSummaries.length) {
        const empty = doc.createElement("div");
        empty.className = "empty";
        const emptyTitle = doc.createElement("strong");
        const emptyText = doc.createElement("span");
        if (state.refreshing && !state.allSummaries.length) {
          emptyTitle.textContent = "Loading your pull requests\u2026";
          emptyText.textContent = "Fetching open pull requests authored by you.";
        } else if (!state.allSummaries.length) {
          emptyTitle.textContent = "No open pull requests found";
          emptyText.textContent = "Refresh to check GitHub again.";
        } else {
          emptyTitle.textContent = "Nothing matches this view";
          emptyText.textContent = "Try another status, clear filters, or clear your search.";
        }
        empty.append(emptyTitle, emptyText);
        list.append(empty);
        return;
      }
      let renderedRowIndex = 0;
      for (const group of state.summaryGroups) {
        const groupSection = doc.createElement("section");
        groupSection.className = "pr-group";
        groupSection.dataset.groupKey = group.key;
        const groupHeader = doc.createElement("header");
        groupHeader.className = "pr-group-header";
        const groupTitle = doc.createElement("h2");
        groupTitle.className = "pr-group-title";
        const groupToggle = doc.createElement("button");
        groupToggle.type = "button";
        groupToggle.className = "pr-group-toggle";
        groupToggle.setAttribute("aria-expanded", String(!group.collapsed));
        groupToggle.setAttribute(
          "aria-label",
          `${group.collapsed ? "Expand" : "Collapse"} group ${group.label}`
        );
        groupToggle.setAttribute("data-focus-id", `group-toggle:${group.key}`);
        groupToggle.addEventListener("click", () => handlers.onToggleGroup?.(group.key));
        const groupChevron = doc.createElement("span");
        groupChevron.className = "pr-group-chevron";
        groupChevron.setAttribute("aria-hidden", "true");
        groupChevron.textContent = group.collapsed ? "\u25B8" : "\u25BE";
        const groupLabel = doc.createElement("span");
        groupLabel.className = "pr-group-label";
        groupLabel.textContent = group.label;
        const groupCount = doc.createElement("span");
        groupCount.className = "pr-group-count";
        groupCount.textContent = String(group.summaries.length);
        groupCount.setAttribute("aria-label", formatCount(group.summaries.length));
        groupToggle.append(groupChevron, groupLabel, groupCount);
        groupTitle.append(groupToggle);
        groupHeader.append(groupTitle);
        groupSection.append(groupHeader);
        const groupRows = doc.createElement("div");
        groupRows.className = "pr-group-rows";
        groupRows.hidden = group.collapsed;
        for (const summary of group.summaries) {
          const record = state.records[summary.key] || DEFAULT_RECORD;
          const row = doc.createElement("div");
          row.className = "pr-row";
          row.dataset.prKey = summary.key;
          row.dataset.checksState = summary.checks || "unknown";
          if (summary.headSha) {
            row.dataset.headSha = summary.headSha;
          }
          const rowButton = doc.createElement("button");
          rowButton.type = "button";
          rowButton.className = "pr-row-select";
          rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
          rowButton.setAttribute("aria-label", `Edit personal tracking for ${summary.title}`);
          rowButton.addEventListener("click", () => {
            focusedBeforeDrawer = shadow.activeElement;
            handlers.onSelect(currentState?.selectedKey === summary.key ? null : summary.key);
          });
          rowButton.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              focusedBeforeDrawer = shadow.activeElement;
              handlers.onSelect(currentState?.selectedKey === summary.key ? null : summary.key);
            }
          });
          const rowIcon = doc.createElement("span");
          rowIcon.className = "pr-icon";
          rowIcon.setAttribute("aria-hidden", "true");
          const rowCopy = doc.createElement("span");
          rowCopy.className = "row-copy";
          const headerLine = doc.createElement("span");
          headerLine.className = "row-header";
          const repo = doc.createElement("span");
          repo.className = "repo";
          repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
          headerLine.append(repo);
          const ageBadge = makeAgeBadge(summary.createdAt, state.currentTime);
          if (ageBadge) {
            headerLine.append(ageBadge);
          }
          const title = doc.createElement("span");
          title.className = "title";
          title.textContent = summary.title;
          const details = doc.createElement("span");
          details.className = "row-details";
          details.id = `pr-row-details-${renderedRowIndex}`;
          renderedRowIndex += 1;
          rowButton.setAttribute("aria-describedby", details.id);
          const metadata = doc.createElement("span");
          metadata.className = "row-metadata";
          if (summary.updatedAt) {
            const updated = doc.createElement("span");
            updated.textContent = `Updated ${formatRelativeTime(summary.updatedAt)}`;
            metadata.append(updated);
          }
          appendKnownBadge(metadata, "Merge", summary.merge, "merge");
          if (Number.isInteger(summary.unresolvedThreads)) {
            const threads = doc.createElement("span");
            threads.className = "thread-count";
            threads.textContent = `${summary.unresolvedThreads} unresolved ${summary.unresolvedThreads === 1 ? "thread" : "threads"}`;
            metadata.append(threads);
          }
          if (summary.draft) {
            const draftBadge = makeBadge("Draft", "draft");
            draftBadge.textContent = "Draft";
            metadata.append(draftBadge);
          }
          if (metadata.childElementCount) {
            details.append(metadata);
          }
          const jiraLinks = renderJiraLinks(summary.jiraReferences);
          if (jiraLinks) {
            details.append(jiraLinks);
          }
          const statusLines = doc.createElement("span");
          statusLines.className = "row-status-lines";
          appendNativeStatus(statusLines, "review", summary.review, REVIEW_ROW_LABELS);
          appendNativeStatus(statusLines, "checks", summary.checks, CHECK_ROW_LABELS);
          if (statusLines.childElementCount) {
            details.append(statusLines);
          }
          if (record.status === "blocked" && record.blockedBy) {
            const blocker = doc.createElement("span");
            blocker.className = "blocker-preview";
            blocker.textContent = `Blocked by ${record.blockedBy}`;
            rowCopy.append(headerLine, title, details, blocker);
          } else {
            rowCopy.append(headerLine, title, details);
          }
          if (record.notes) {
            const notePreview = doc.createElement("span");
            notePreview.className = "note-preview";
            notePreview.textContent = compactNote(record.notes);
            rowCopy.append(notePreview);
          } else if (!record.tags.length && !(record.status === "blocked" && record.blockedBy)) {
            const personalHint = doc.createElement("span");
            personalHint.className = "personal-hint";
            personalHint.textContent = "Add notes, private labels, or blocker details";
            rowCopy.append(personalHint);
          }
          rowButton.append(rowIcon, rowCopy);
          const quickStatus = doc.createElement("label");
          quickStatus.className = "quick-status";
          quickStatus.dataset.status = record.status;
          const quickLabel = doc.createElement("span");
          quickLabel.className = "sr-only";
          quickLabel.textContent = `Personal status for ${summary.title}`;
          const statusSelect = makeStatusSelect(record.status);
          statusSelect.className = "status-select";
          statusSelect.addEventListener("change", () => handlers.onQuickStatus(summary.key, statusSelect.value));
          quickStatus.append(quickLabel, statusSelect);
          const rowControls = doc.createElement("div");
          rowControls.className = "row-controls";
          const actionPending = Boolean(state.prAction?.pending);
          const rowMergePending = actionPending && state.prAction.key === summary.key && state.prAction.type === "merge";
          if (summary.merge === "clean" && !summary.draft) {
            const rowMergeButton = makeActionButton(
              rowMergePending ? "Merging\u2026" : "Merge",
              () => void handlers.onMerge(summary.key),
              "action-btn merge-action row-merge-action"
            );
            rowMergeButton.disabled = actionPending;
            rowMergeButton.title = "Squash merge with an empty commit message";
            rowMergeButton.setAttribute(
              "aria-label",
              `Squash and merge ${summary.owner}/${summary.repo} #${summary.number} with an empty commit message`
            );
            rowControls.append(rowMergeButton);
          }
          const openLink = doc.createElement("a");
          openLink.className = "row-open-link";
          openLink.href = summary.url;
          openLink.target = "_blank";
          openLink.rel = "noreferrer";
          openLink.textContent = "Open \u2197";
          openLink.setAttribute("aria-label", `Open ${summary.title} on GitHub`);
          rowControls.append(openLink, quickStatus);
          row.append(rowButton, rowControls);
          if (record.tags.length) {
            const tags = doc.createElement("div");
            tags.className = "tags row-tags";
            for (const tag of record.tags) {
              const tagButton = makeTagButton(tag, {
                ariaLabel: `Filter by tag ${tag.name}`,
                onClick() {
                  handlers.onTagFilter(tag.name);
                }
              });
              tags.append(tagButton);
            }
            row.append(tags);
          }
          groupRows.append(row);
        }
        groupSection.append(groupRows);
        list.append(groupSection);
      }
    }
    function renderDrawer(state) {
      shell.classList.toggle("has-drawer", Boolean(state.selectedKey));
      drawer.hidden = !state.selectedKey;
      if (!state.selectedKey) {
        void flushPending(currentSelectedKey).catch(() => {
        });
        currentSelectedKey = null;
        closePromptKey = null;
        drawerView = null;
        drawer.textContent = "";
        updateSaveState();
        return;
      }
      if (closePromptKey && closePromptKey !== state.selectedKey) {
        closePromptKey = null;
      }
      const summary = state.allSummaries.find((item) => item.key === state.selectedKey) || state.filteredSummaries.find((item) => item.key === state.selectedKey);
      const record = getDrawerRecord(state.selectedKey, state.records[state.selectedKey] || DEFAULT_RECORD);
      currentSelectedKey = state.selectedKey;
      if (!drawerView || drawerView.key !== state.selectedKey) {
        drawerView = createDrawerView(state.selectedKey);
        drawer.replaceChildren(...drawerView.nodes);
      }
      const actionPending = Boolean(state.prAction?.pending);
      const selectedActionPending = actionPending && state.prAction.key === state.selectedKey;
      const canMerge = summary?.merge === "clean" && !summary?.draft;
      drawerView.identityTitle.textContent = summary?.title || state.selectedKey;
      drawerView.identityRepo.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
      drawerView.link.href = summary?.url || "#";
      syncDrawerJiraLinks(drawerView, summary?.jiraReferences);
      renderLifecycle(drawerView, summary?.lifecycle);
      drawerView.mergeButton.textContent = selectedActionPending && state.prAction.type === "merge" ? "Merging\u2026" : "Squash & merge";
      drawerView.mergeButton.disabled = actionPending;
      if (canMerge) {
        if (!drawerView.mergeButton.isConnected) {
          drawerView.prActionButtons.prepend(drawerView.mergeButton);
        }
      } else {
        drawerView.mergeButton.remove();
      }
      drawerView.closePrButton.textContent = selectedActionPending && state.prAction.type === "close" ? "Closing\u2026" : "Close PR";
      drawerView.closePrButton.disabled = actionPending;
      if (closePromptKey === state.selectedKey) {
        if (!drawerView.closePrompt.isConnected) {
          drawerView.prActions.insertBefore(drawerView.closePrompt, drawerView.actionError);
        }
        syncInputValue(drawerView.closeCommentInput, drawerView.closeComment);
      } else {
        drawerView.closePrompt.remove();
      }
      drawerView.cancelClose.disabled = actionPending;
      drawerView.confirmClose.textContent = selectedActionPending && state.prAction.type === "close" ? "Closing\u2026" : "Close pull request";
      drawerView.confirmClose.disabled = actionPending;
      const actionError = state.prAction?.key === state.selectedKey ? state.prAction.error : "";
      drawerView.actionError.hidden = !actionError;
      drawerView.actionError.textContent = actionError || "";
      syncSelectValue(drawerView.statusSelect, record.status);
      drawerView.blockerField.hidden = record.status !== "blocked";
      syncInputValue(drawerView.blockerInput, record.blockedBy);
      drawerView.existingTags.textContent = "";
      for (const tag of record.tags) {
        const pill = makeTagButton(tag, {
          ariaLabel: `Remove tag ${tag.name}`,
          onClick() {
            handlers.onRemoveTag(state.selectedKey, tag.name);
          }
        });
        pill.title = "Remove private tag";
        drawerView.existingTags.append(pill);
      }
      syncInputValue(drawerView.notesInput, record.notes);
      updateSaveState();
    }
    function createDrawerView(selectedKey) {
      const view = { key: selectedKey };
      const header = doc.createElement("div");
      header.className = "drawer-header";
      const headerText = doc.createElement("div");
      const drawerTitle = doc.createElement("h2");
      drawerTitle.textContent = "Notes & tracking";
      const drawerSubtitle = doc.createElement("div");
      drawerSubtitle.className = "drawer-subtitle";
      drawerSubtitle.textContent = "Private to this browser";
      headerText.append(drawerTitle, drawerSubtitle);
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "icon-btn";
      close.textContent = "\xD7";
      close.setAttribute("aria-label", "Close personal tracking panel");
      close.addEventListener("click", () => void dismissDrawer({ restoreFocus: true }));
      header.append(headerText, close);
      const identity = doc.createElement("div");
      identity.className = "drawer-identity";
      const identityTitle = doc.createElement("div");
      identityTitle.className = "title";
      const identityRepo = doc.createElement("div");
      identityRepo.className = "repo";
      const identityJira = doc.createElement("div");
      identityJira.className = "identity-jira";
      identity.append(identityTitle, identityRepo, identityJira);
      const lifecycle = doc.createElement("section");
      lifecycle.className = "field lifecycle";
      const lifecycleLabel = doc.createElement("div");
      lifecycleLabel.className = "field-label";
      lifecycleLabel.textContent = "Lifecycle";
      const lifecycleList = doc.createElement("div");
      lifecycleList.className = "lifecycle-list";
      lifecycle.append(lifecycleLabel, lifecycleList);
      const prActions = doc.createElement("section");
      prActions.className = "pr-actions";
      const prActionsLabel = doc.createElement("div");
      prActionsLabel.className = "field-label";
      prActionsLabel.textContent = "GitHub actions";
      const prActionButtons = doc.createElement("div");
      prActionButtons.className = "pr-action-buttons";
      const mergeButton = makeActionButton("Squash & merge", () => void handlers.onMerge(selectedKey), "action-btn merge-action");
      const closePrButton = makeActionButton("Close PR", () => {
        if (currentState?.selectedKey !== selectedKey) {
          return;
        }
        closePromptKey = selectedKey;
        view.closeComment = "";
        renderDrawer(currentState);
        view.closeCommentInput?.focus();
      }, "action-btn close-action");
      prActionButtons.append(mergeButton, closePrButton);
      prActions.append(prActionsLabel, prActionButtons);
      const closePrompt = doc.createElement("div");
      closePrompt.className = "close-prompt";
      const closePromptLabel = doc.createElement("label");
      closePromptLabel.className = "field-label";
      closePromptLabel.textContent = "Optional closing comment";
      const closeCommentInput = doc.createElement("textarea");
      closeCommentInput.className = "close-comment";
      closeCommentInput.rows = 3;
      closeCommentInput.placeholder = "Add context before closing\u2026";
      closeCommentInput.addEventListener("input", () => {
        if (currentState?.selectedKey === selectedKey) {
          view.closeComment = closeCommentInput.value;
        }
      });
      closePromptLabel.append(closeCommentInput);
      const closePromptButtons = doc.createElement("div");
      closePromptButtons.className = "close-prompt-buttons";
      const cancelClose = makeActionButton("Cancel", () => {
        if (currentState?.selectedKey !== selectedKey) {
          return;
        }
        closePromptKey = null;
        view.closeComment = "";
        renderDrawer(currentState);
      }, "action-btn");
      const confirmClose = makeActionButton(
        "Close pull request",
        () => {
          if (currentState?.selectedKey === selectedKey) {
            void handlers.onClosePullRequest(selectedKey, view.closeComment);
          }
        },
        "action-btn close-confirm"
      );
      closePromptButtons.append(cancelClose, confirmClose);
      closePrompt.append(closePromptLabel, closePromptButtons);
      prActions.append(closePrompt);
      const actionError = doc.createElement("div");
      actionError.className = "pr-action-error";
      actionError.setAttribute("role", "alert");
      prActions.append(actionError);
      const statusField = makeField("My status");
      const statusSelect = makeStatusSelect(DEFAULT_RECORD.status);
      statusSelect.setAttribute("data-focus-id", "status");
      statusSelect.addEventListener("change", () => {
        queueSave(selectedKey, { status: statusSelect.value });
        blockerField.hidden = statusSelect.value !== "blocked";
        if (statusSelect.value === "blocked") {
          view.blockerInput.focus();
        }
      });
      statusField.append(statusSelect);
      const blockerField = makeField("Blocked by");
      const blockerInput = doc.createElement("input");
      blockerInput.type = "text";
      blockerInput.placeholder = "Person, team, decision, or dependency";
      blockerInput.setAttribute("data-focus-id", "blockedBy");
      blockerInput.addEventListener("input", () => queueSave(selectedKey, { blockedBy: blockerInput.value }));
      blockerInput.addEventListener("blur", () => void flushPending(selectedKey).catch(() => {
      }));
      blockerField.append(blockerInput);
      const tagsField = doc.createElement("div");
      tagsField.className = "field";
      const tagsLabel = doc.createElement("div");
      tagsLabel.className = "field-label";
      tagsLabel.textContent = "Private labels";
      const tagForm = doc.createElement("form");
      tagForm.className = "tag-form";
      const tagInput = doc.createElement("input");
      tagInput.type = "text";
      tagInput.placeholder = "Add a label";
      tagInput.setAttribute("aria-label", "Private label name");
      tagInput.setAttribute("data-focus-id", "tag-name");
      const colorSelect = doc.createElement("select");
      colorSelect.setAttribute("aria-label", "Tag color");
      for (const color of TAG_COLORS) {
        const option = doc.createElement("option");
        option.value = color;
        option.textContent = color;
        colorSelect.append(option);
      }
      tagForm.addEventListener("submit", (event) => {
        event.preventDefault();
        handlers.onAddTag(selectedKey, tagInput.value, colorSelect.value);
        tagInput.value = "";
      });
      tagForm.append(
        tagInput,
        colorSelect,
        Object.assign(makeActionButton("Add", null, "action-btn"), { type: "submit" })
      );
      const existingTags = doc.createElement("div");
      existingTags.className = "tags";
      tagsField.append(tagsLabel, tagForm, existingTags);
      const notesField = makeField("My notes");
      const notesInput = doc.createElement("textarea");
      notesInput.rows = 7;
      notesInput.placeholder = "Context, next steps, reminders\u2026";
      notesInput.setAttribute("data-focus-id", "notes");
      notesInput.addEventListener("input", () => queueSave(selectedKey, { notes: notesInput.value }));
      notesInput.addEventListener("blur", () => void flushPending(selectedKey).catch(() => {
      }));
      notesField.append(notesInput);
      const footer = doc.createElement("div");
      footer.className = "drawer-footer";
      const link = doc.createElement("a");
      link.className = "link-btn";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open on GitHub \u2197";
      footer.append(saveState, link);
      Object.assign(view, {
        key: selectedKey,
        closeComment: "",
        nodes: [header, identity, lifecycle, prActions, statusField, blockerField, tagsField, notesField, footer],
        identityTitle,
        identityRepo,
        identityJira,
        lifecycleList,
        prActions,
        prActionButtons,
        mergeButton,
        closePrButton,
        closePrompt,
        closeCommentInput,
        cancelClose,
        confirmClose,
        actionError,
        statusSelect,
        blockerField,
        blockerInput,
        tagInput,
        colorSelect,
        notesInput,
        existingTags,
        link
      });
      return view;
    }
    function getDrawerRecord(key, record) {
      const draft = pendingSaves.get(key)?.draft;
      return draft ? { ...record, ...draft } : record;
    }
    function syncInputValue(input, value) {
      if (input.value !== value) {
        input.value = value;
      }
    }
    function syncSelectValue(select, value) {
      if (select.value !== value) {
        select.value = value;
      }
    }
    function hasOwnValues(object) {
      return Object.keys(object).length > 0;
    }
    function reconcileDraftAfterSave(entry, patch) {
      for (const [field, value] of Object.entries(patch)) {
        if (Object.is(entry.draft[field], value)) {
          delete entry.draft[field];
        }
      }
    }
    function pruneSaveEntry(key, entry) {
      if (entry.workerPromise || entry.inFlight || entry.debouncePending || hasOwnValues(entry.patch) || hasOwnValues(entry.draft) || entry.lastError) {
        return;
      }
      pendingSaves.delete(key);
    }
    function updateSaveState() {
      const selectedKey = currentState?.selectedKey;
      const entry = selectedKey ? pendingSaves.get(selectedKey) : null;
      if (entry?.lastError) {
        saveState.textContent = `Error: ${entry.lastError.message}`;
        return;
      }
      if (entry && (entry.inFlight || entry.debouncePending || hasOwnValues(entry.patch))) {
        saveState.textContent = "Saving\u2026";
        return;
      }
      saveState.textContent = "Saved";
    }
    function makeStatusSelect(selectedStatus) {
      const select = doc.createElement("select");
      for (const status of PERSONAL_STATUSES) {
        const option = doc.createElement("option");
        option.value = status;
        option.textContent = STATUS_LABELS[status];
        option.selected = selectedStatus === status;
        select.append(option);
      }
      return select;
    }
    function makeSortRow(labelText, fieldSelect, directionSelect) {
      const row = doc.createElement("label");
      row.className = "sort-row";
      const label = doc.createElement("span");
      label.className = "sort-row-label";
      label.textContent = labelText;
      row.append(label, fieldSelect, directionSelect);
      return row;
    }
    function makeFilterRow(labelText, select) {
      const row = doc.createElement("label");
      row.className = "structured-filter-row";
      const label = doc.createElement("span");
      label.className = "filter-row-label";
      label.textContent = labelText;
      row.append(label, select);
      return row;
    }
    function makeField(labelText) {
      const field = doc.createElement("label");
      field.className = "field";
      const label = doc.createElement("span");
      label.className = "field-label";
      label.textContent = labelText;
      field.append(label);
      return field;
    }
    function queueSave(key, patch) {
      if (!key) {
        return;
      }
      const entry = ensureSaveEntry(key);
      entry.patch = { ...entry.patch, ...patch };
      entry.draft = { ...entry.draft, ...patch };
      entry.lastError = null;
      entry.debouncePending = true;
      handlers.onLocalPatch?.(key, patch);
      entry.debounced();
      updateSaveState();
    }
    async function flushPending(key = null) {
      if (key === null) {
        await Promise.all([...pendingSaves.keys()].map((pendingKey) => flushPending(pendingKey)));
        return;
      }
      const entry = pendingSaves.get(key);
      if (!entry) {
        return;
      }
      entry.debouncePending = false;
      entry.debounced.flush();
      const worker = ensureSaveWorker(key);
      if (worker) {
        await worker;
      }
      if (entry.lastError) {
        throw entry.lastError;
      }
      pruneSaveEntry(key, entry);
      updateSaveState();
    }
    function ensureSaveEntry(key) {
      let entry = pendingSaves.get(key);
      if (entry) {
        return entry;
      }
      entry = {
        patch: {},
        draft: {},
        workerPromise: null,
        inFlight: false,
        debouncePending: false,
        lastError: null,
        debounced: null
      };
      entry.debounced = debounce(() => {
        entry.debouncePending = false;
        updateSaveState();
        void ensureSaveWorker(key).catch(() => {
        });
      }, SAVE_DEBOUNCE_MS);
      pendingSaves.set(key, entry);
      return entry;
    }
    function ensureSaveWorker(key) {
      const entry = pendingSaves.get(key);
      if (!entry) {
        return Promise.resolve();
      }
      if (entry.workerPromise) {
        return entry.workerPromise;
      }
      entry.workerPromise = (async () => {
        while (hasOwnValues(entry.patch)) {
          const patchToSave = { ...entry.patch };
          entry.patch = {};
          entry.inFlight = true;
          entry.lastError = null;
          updateSaveState();
          try {
            await handlers.onEdit(key, patchToSave, now());
            reconcileDraftAfterSave(entry, patchToSave);
          } catch (error) {
            entry.patch = { ...patchToSave, ...entry.patch };
            entry.lastError = error;
            throw error;
          } finally {
            entry.inFlight = false;
            updateSaveState();
          }
        }
      })().finally(() => {
        entry.workerPromise = null;
        pruneSaveEntry(key, entry);
        updateSaveState();
      });
      return entry.workerPromise;
    }
    function setSaveState() {
      updateSaveState();
    }
    function captureFocus() {
      const active = shadow.activeElement;
      if (!(active instanceof HTMLElement)) {
        return null;
      }
      const focusId = active.getAttribute("data-focus-id");
      if (!focusId) {
        return null;
      }
      return {
        focusId,
        selectionStart: typeof active.selectionStart === "number" ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === "number" ? active.selectionEnd : null
      };
    }
    function restoreFocus(snapshot) {
      if (!snapshot) {
        return;
      }
      const next = shadow.querySelector(`[data-focus-id="${snapshot.focusId}"]`);
      if (!(next instanceof HTMLElement)) {
        return;
      }
      next.focus();
      if (typeof snapshot.selectionStart === "number" && typeof next.setSelectionRange === "function") {
        next.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
      }
    }
    function makeBadge(label, value, kind = label.toLowerCase()) {
      const badge = doc.createElement("span");
      badge.className = "badge";
      badge.dataset.state = value;
      badge.dataset.kind = kind;
      badge.textContent = `${label}: ${String(value).replaceAll("_", " ")}`;
      return badge;
    }
    function makeAgeBadge(createdAt, currentTime) {
      const days = calendarDaysSince(createdAt, currentTime);
      if (!Number.isInteger(days)) {
        return null;
      }
      const badge = makeBadge("Age", `${days}d`, "age");
      badge.classList.add("age-badge");
      badge.setAttribute("aria-label", `${days} ${days === 1 ? "day" : "days"} old`);
      return badge;
    }
    function appendKnownBadge(target, label, value, kind = label.toLowerCase()) {
      if (value && value !== "unknown") {
        target.append(makeBadge(label, value, kind));
      }
    }
    function appendNativeStatus(target, kind, value, labels) {
      if (value && value !== "unknown") {
        const badge = makeBadge(kind, value, kind);
        badge.classList.add("native-status-line");
        badge.textContent = labels[value] || `${kind}: ${String(value).replaceAll("_", " ")}`;
        target.append(badge);
      }
    }
    function makeTagButton(tag, { onClick, ariaLabel }) {
      const pill = doc.createElement("button");
      pill.type = "button";
      pill.className = "tag-pill";
      pill.textContent = tag.name;
      pill.setAttribute("aria-label", ariaLabel);
      const tokens = TAG_COLOR_TOKENS[tag.color];
      pill.style.color = tokens.fg;
      pill.style.background = tokens.bg;
      pill.style.borderColor = tokens.border;
      pill.addEventListener("click", onClick);
      return pill;
    }
    function renderJiraLinks(references) {
      const validReferences = Array.isArray(references) ? references.map((reference) => {
        const key = typeof reference?.key === "string" ? reference.key : "";
        const url = normalizeHttpUrl(reference?.url);
        return key && url ? { key, url } : null;
      }).filter(Boolean) : [];
      if (!validReferences.length) {
        return null;
      }
      const links = doc.createElement("span");
      links.className = "jira-links";
      for (const reference of validReferences) {
        const link = doc.createElement("a");
        link.className = "jira-link";
        link.href = reference.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = reference.key;
        link.setAttribute("aria-label", `Open Jira issue ${reference.key}`);
        links.append(link);
      }
      return links;
    }
    function syncDrawerJiraLinks(view, references) {
      view.identityJira.textContent = "";
      const links = renderJiraLinks(references);
      if (links) {
        view.identityJira.append(links);
        view.identityJira.hidden = false;
        return;
      }
      view.identityJira.hidden = true;
    }
    function makeActionButton(label, onClick, className) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      if (onClick) {
        button.addEventListener("click", onClick);
      }
      return button;
    }
    function makeSelect(focusId, ariaLabel) {
      const select = doc.createElement("select");
      select.setAttribute("data-focus-id", focusId);
      select.setAttribute("aria-label", ariaLabel);
      return select;
    }
    function syncSelectOptions(select, options) {
      const signature = options.map((option) => `${option.value}:${option.label}`).join("|");
      if (select.dataset.optionsSignature === signature) {
        return;
      }
      select.dataset.optionsSignature = signature;
      select.replaceChildren(
        ...options.map((option) => {
          const element = doc.createElement("option");
          element.value = option.value;
          element.textContent = option.label;
          return element;
        })
      );
    }
    function directionOptionsForField(field) {
      if (field === "updated") {
        return [
          { value: "desc", label: "Newest first" },
          { value: "asc", label: "Oldest first" }
        ];
      }
      if (field === "number") {
        return [
          { value: "desc", label: "Highest first" },
          { value: "asc", label: "Lowest first" }
        ];
      }
      if (field === "repository" || field === "title") {
        return [
          { value: "asc", label: "A to Z" },
          { value: "desc", label: "Z to A" }
        ];
      }
      return [
        { value: "asc", label: "Workflow order" },
        { value: "desc", label: "Reverse order" }
      ];
    }
    function emitSortChange() {
      const next = {
        primary: {
          field: primaryFieldSelect.value,
          direction: primaryDirectionSelect.value
        },
        secondary: secondaryFieldSelect.value === "none" ? null : {
          field: secondaryFieldSelect.value,
          direction: secondaryDirectionSelect.value
        }
      };
      void handlers.onSortChange?.(next);
    }
    primaryFieldSelect.addEventListener("change", () => {
      syncSelectOptions(primaryDirectionSelect, directionOptionsForField(primaryFieldSelect.value));
      emitSortChange();
    });
    primaryDirectionSelect.addEventListener("change", emitSortChange);
    secondaryFieldSelect.addEventListener("change", () => {
      syncSelectOptions(
        secondaryDirectionSelect,
        secondaryFieldSelect.value === "none" ? directionOptionsForField(primaryFieldSelect.value) : directionOptionsForField(secondaryFieldSelect.value)
      );
      emitSortChange();
    });
    secondaryDirectionSelect.addEventListener("change", emitSortChange);
    hideDraftsCheckbox.addEventListener("change", () => {
      void handlers.onFilterChange({ hideDrafts: hideDraftsCheckbox.checked });
    });
    repositorySelect.addEventListener("change", () => {
      void handlers.onFilterChange({ repository: repositorySelect.value });
    });
    reviewSelect.addEventListener("change", () => {
      void handlers.onFilterChange({ review: reviewSelect.value });
    });
    checksSelect.addEventListener("change", () => {
      void handlers.onFilterChange({ checks: checksSelect.value });
    });
    function dismiss() {
      dismissDisclosures();
      closePromptKey = null;
      if (drawerView) {
        drawerView.closeComment = "";
      }
    }
    return { render, shadow, flushPending, setSaveState, dismiss };
  }
  function countStatuses(state) {
    const counts = Object.fromEntries(PERSONAL_STATUSES.map((status) => [status, 0]));
    for (const summary of state.allSummaries) {
      const status = (state.records[summary.key] || DEFAULT_RECORD).status;
      counts[status] += 1;
    }
    counts.active = state.allSummaries.length - counts.done;
    return counts;
  }
  function repositoryFilterOptions(summaries, selectedValue) {
    const repositories = /* @__PURE__ */ new Map();
    for (const summary of summaries) {
      const value = [summary.owner, summary.repo].filter(Boolean).join("/");
      if (value && !repositories.has(value.toLocaleLowerCase())) {
        repositories.set(value.toLocaleLowerCase(), { value, label: value });
      }
    }
    const options = [...repositories.values()].sort(
      (left, right) => left.label.localeCompare(right.label, void 0, { sensitivity: "base", numeric: true })
    );
    if (selectedValue !== "all" && !options.some((option) => option.value.toLocaleLowerCase() === selectedValue.toLocaleLowerCase())) {
      options.push({ value: selectedValue, label: `${selectedValue} (not in current list)` });
    }
    return [{ value: "all", label: "All repositories" }, ...options];
  }
  function countStructuredFilters(preferences) {
    return Number(preferences.hideDrafts) + Number(preferences.repository !== "all") + Number(preferences.review !== "all") + Number(preferences.checks !== "all");
  }
  function formatCount(count) {
    return `${count} pull request${count === 1 ? "" : "s"}`;
  }
  function formatRelativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
      return value;
    }
    const elapsedSeconds = Math.round((timestamp - Date.now()) / 1e3);
    const units = [
      ["year", 60 * 60 * 24 * 365],
      ["month", 60 * 60 * 24 * 30],
      ["day", 60 * 60 * 24],
      ["hour", 60 * 60],
      ["minute", 60]
    ];
    const formatter = new Intl.RelativeTimeFormat(void 0, { numeric: "auto" });
    for (const [unit, seconds] of units) {
      if (Math.abs(elapsedSeconds) >= seconds) {
        return formatter.format(Math.round(elapsedSeconds / seconds), unit);
      }
    }
    return "just now";
  }
  function compactNote(value) {
    const text2 = String(value).replace(/\s+/g, " ").trim();
    return text2.length > 110 ? `Note \xB7 ${text2.slice(0, 107)}\u2026` : `Note \xB7 ${text2}`;
  }
  function renderLifecycle(view, lifecycle) {
    view.lifecycleList.textContent = "";
    const rows = summarizeLifecyclePhases(lifecycle);
    if (!rows.length) {
      const empty = view.lifecycleList.ownerDocument.createElement("div");
      empty.className = "lifecycle-empty";
      empty.textContent = "No lifecycle timing captured yet.";
      view.lifecycleList.append(empty);
      return;
    }
    for (const row of rows) {
      const item = view.lifecycleList.ownerDocument.createElement("div");
      item.className = "lifecycle-row";
      const label = view.lifecycleList.ownerDocument.createElement("span");
      label.className = "lifecycle-row-label";
      label.textContent = row.label;
      const detail = view.lifecycleList.ownerDocument.createElement("span");
      detail.className = "lifecycle-row-detail";
      detail.textContent = row.detail;
      item.append(label, detail);
      if (row.note) {
        const note = view.lifecycleList.ownerDocument.createElement("span");
        note.className = "lifecycle-row-note";
        note.textContent = row.note;
        item.append(note);
      }
      view.lifecycleList.append(item);
    }
  }
  function summarizeSort(sortPreferences, groupOptions, sortOptions) {
    const groupLabels = new Map(groupOptions.map((option) => [option.value, option.label]));
    const sortLabels = new Map(sortOptions.map((option) => [option.value, option.label]));
    const describe = (level) => {
      const label = sortLabels.get(level.field) || level.field;
      return `${label} ${level.direction === "desc" ? "\u2193" : "\u2191"}`;
    };
    const primaryLabel = groupLabels.get(sortPreferences.primary.field) || sortPreferences.primary.field;
    const groupedBy = `${primaryLabel} ${sortPreferences.primary.direction === "desc" ? "\u2193" : "\u2191"}`;
    return sortPreferences.secondary ? `Group: ${groupedBy} \xB7 ${describe(sortPreferences.secondary)}` : `Group: ${groupedBy}`;
  }

  // src/app.js
  function createTrackerApp({ doc, win, fetchImpl, parser, storage, login, version = "unknown" }) {
    const state = {
      login,
      allSummaries: [],
      filteredSummaries: [],
      records: {},
      search: "",
      statusFilter: "all",
      tagFilter: "",
      filterPreferences: DEFAULT_FILTER_PREFERENCES,
      sortPreferences: null,
      collapsedGroups: /* @__PURE__ */ new Set(),
      selectedKey: null,
      prAction: { key: null, type: null, pending: false, error: "" },
      showCompleted: false,
      refreshing: false,
      warning: "",
      saveState: "Saved",
      mounted: false
    };
    let host = null;
    let ui = null;
    let hiddenElements = [];
    let hiddenLayoutElements = [];
    let layoutStyleSnapshots = [];
    let mountedMain = null;
    let unsubscribe = null;
    let trackerRouteActive = false;
    let refreshPromise = null;
    let queuedRefreshForce = false;
    async function init() {
      if (unsubscribe) {
        return;
      }
      const envelope = await storage.load();
      state.records = envelope.records;
      state.allSummaries = envelope.openListCache.items || [];
      state.filterPreferences = normalizeFilterPreferences(envelope.filterPreferences);
      state.sortPreferences = normalizeSortPreferencesForSummaries(envelope.sortPreferences, state.allSummaries);
      state.collapsedGroups = new Set(envelope.collapsedGroups || []);
      state.filteredSummaries = computeFiltered();
      unsubscribe = storage.subscribe((nextEnvelope) => {
        state.records = nextEnvelope.records;
        state.filterPreferences = normalizeFilterPreferences(nextEnvelope.filterPreferences);
        state.sortPreferences = normalizeSortPreferencesForSummaries(nextEnvelope.sortPreferences, state.allSummaries);
        state.collapsedGroups = new Set(nextEnvelope.collapsedGroups || []);
        state.filteredSummaries = computeFiltered();
        render();
      });
      await handleRoute();
    }
    function computeFiltered() {
      const filtered = filterSummaries({
        summaries: state.allSummaries,
        records: state.records,
        search: state.search,
        statusFilter: state.statusFilter,
        tagFilter: state.tagFilter,
        showCompleted: state.showCompleted,
        filterPreferences: state.filterPreferences
      });
      return sortSummaries({
        summaries: filtered,
        records: state.records,
        sortPreferences: state.sortPreferences
      });
    }
    function mount() {
      const main = doc.querySelector("main");
      if (!main) {
        return false;
      }
      if (host?.isConnected && mountedMain === main) {
        return false;
      }
      restoreHiddenElements();
      mountedMain = main;
      hiddenElements = [...main.children].filter((node) => node !== host).map((node) => ({ node, hidden: node.hidden }));
      for (const entry of hiddenElements) {
        entry.node.hidden = true;
        entry.node.setAttribute("data-pr-tracker-hidden", "true");
      }
      adaptNativeLayout(main);
      if (!host) {
        host = doc.createElement("section");
        host.id = "tm-pr-tracker-root";
        host.dataset.trackerVersion = version;
        ui = createUi(host, createHandlers());
      }
      main.append(host);
      state.mounted = true;
      render();
      return true;
    }
    function restoreHiddenElements() {
      for (const entry of hiddenElements) {
        const node = entry.node;
        if (node instanceof HTMLElement && node.getAttribute("data-pr-tracker-hidden") === "true") {
          node.hidden = entry.hidden;
          node.removeAttribute("data-pr-tracker-hidden");
        }
      }
      hiddenElements = [];
      restoreNativeLayout();
      mountedMain = null;
    }
    function adaptNativeLayout(main) {
      const parent = main.parentElement;
      if (!parent || parent === doc.body || parent === doc.documentElement) {
        return;
      }
      const siblings = [...parent.children].filter((node) => node !== main && node instanceof HTMLElement);
      const mainRect = main.getBoundingClientRect();
      const isGlobalChrome = (node) => node.matches('header, footer, [role="banner"], [role="contentinfo"]') || Boolean(node.querySelector('header, [role="banner"], nav[aria-label="Global"]'));
      const semanticSiblings = siblings.filter(
        (node) => !isGlobalChrome(node) && node.matches('aside, [role="complementary"]')
      );
      const geometricSiblings = siblings.filter((node) => {
        if (isGlobalChrome(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return mainRect.width > 0 && rect.width >= 200 && rect.width <= 640 && rect.height >= 48 && rect.left >= mainRect.right - 8 && rect.top >= mainRect.top - 8;
      });
      const layoutSiblings = semanticSiblings.length ? semanticSiblings : geometricSiblings;
      for (const node of layoutSiblings) {
        hiddenLayoutElements.push({ node, hidden: node.hidden });
        node.hidden = true;
        node.setAttribute("data-pr-tracker-layout-hidden", "true");
      }
      if (!layoutSiblings.length) {
        return;
      }
      for (const element of [parent, main]) {
        layoutStyleSnapshots.push({ element, style: element.getAttribute("style") });
      }
      parent.style.gridTemplateColumns = "minmax(0, 1fr)";
      main.style.gridColumn = "1 / -1";
      main.style.width = "100%";
      main.style.maxWidth = "none";
    }
    function restoreNativeLayout() {
      for (const entry of hiddenLayoutElements) {
        if (entry.node.getAttribute("data-pr-tracker-layout-hidden") === "true") {
          entry.node.hidden = entry.hidden;
          entry.node.removeAttribute("data-pr-tracker-layout-hidden");
        }
      }
      hiddenLayoutElements = [];
      for (const snapshot of layoutStyleSnapshots) {
        if (snapshot.style === null) {
          snapshot.element.removeAttribute("style");
        } else {
          snapshot.element.setAttribute("style", snapshot.style);
        }
      }
      layoutStyleSnapshots = [];
    }
    function unmount() {
      void ui?.flushPending().catch(() => {
      });
      ui?.dismiss?.();
      if (host) {
        host.remove();
      }
      restoreHiddenElements();
      state.mounted = false;
    }
    async function handleRoute() {
      const onTrackerRoute = isTrackerRoute(win.location);
      if (!onTrackerRoute) {
        trackerRouteActive = false;
        unmount();
        return;
      }
      const enteringRoute = !trackerRouteActive;
      trackerRouteActive = true;
      mount();
      if (enteringRoute) {
        await refresh(false);
      }
    }
    async function refresh(force) {
      if (refreshPromise) {
        queuedRefreshForce = queuedRefreshForce || force;
        return refreshPromise;
      }
      refreshPromise = (async () => {
        state.refreshing = true;
        state.warning = "";
        render();
        const snapshot = await storage.load();
        const cachedItems = snapshot.openListCache.items || [];
        const cachedSummaries = new Map(cachedItems.map((item) => [item.key, item]));
        const detailCache = { ...snapshot.detailCache || {} };
        const pendingCacheWrites = /* @__PURE__ */ new Map();
        try {
          const summaries = await fetchOpenPrs({ fetchImpl, parser, startUrl: trackerSearchUrl(login) });
          const enriched = await mapLimit(summaries, 4, async (summary) => {
            try {
              const cached = detailCache[summary.key];
              const shouldUseCache = !force && cached && cached.parserVersion === DETAIL_PARSER_VERSION && isCacheHeadMatch(cached, summary) && isCacheChecksCurrent(cached, summary) && now() - cached.updatedAt < DETAIL_CACHE_TTL_MS;
              const fetched = shouldUseCache ? { detail: cached.detail, cacheEntry: null } : await fetchDetail(
                summary,
                cached?.detail?.lifecycle || cachedSummaries.get(summary.key)?.lifecycle || null
              );
              if (fetched.cacheEntry) {
                pendingCacheWrites.set(summary.key, fetched.cacheEntry);
              }
              return {
                ...summary,
                ...mergeSummaryDetail(summary, fetched.detail)
              };
            } catch {
              return summary;
            }
          });
          const latest = await storage.load();
          latest.openListCache = { updatedAt: now(), items: enriched };
          latest.detailCache = mergeDetailCache({
            latestDetailCache: latest.detailCache || {},
            snapshotDetailCache: detailCache,
            pendingCacheWrites
          });
          await storage.save(latest);
          state.allSummaries = enriched;
          state.records = latest.records;
          state.filterPreferences = normalizeFilterPreferences(latest.filterPreferences);
          state.sortPreferences = normalizeSortPreferencesForSummaries(latest.sortPreferences, enriched);
          if (state.selectedKey && !state.allSummaries.some((item) => item.key === state.selectedKey)) {
            state.selectedKey = null;
          }
        } catch (error) {
          state.warning = `Refresh failed. Showing cached data. ${error.message}`;
          state.allSummaries = cachedItems;
        } finally {
          state.refreshing = false;
          state.filteredSummaries = computeFiltered();
          render();
        }
      })();
      try {
        await refreshPromise;
      } finally {
        refreshPromise = null;
        if (queuedRefreshForce) {
          const nextForce = queuedRefreshForce;
          queuedRefreshForce = false;
          if (nextForce) {
            await refresh(true);
          }
        }
      }
    }
    async function fetchDetail(summary, previousLifecycle = null) {
      const observedAt = now();
      const html = await fetchHtml(fetchImpl, summary.url);
      const prDocument = parser(html, summary.url);
      let detail = parsePrDetailDocument(prDocument, summary.url);
      let verifiedHeadAwareChecks = false;
      const hasCurrentHead = Boolean(summary.headSha);
      if (hasCurrentHead) {
        detail = { ...detail, checks: "unknown" };
        if (summary.checks === "passing") {
          detail = mergeDeferredChecks(detail, { checks: "passing" });
          verifiedHeadAwareChecks = true;
        } else {
          const currentIconUrl = findDeferredStatusEndpoint(prDocument, summary.url, summary.headSha);
          const currentHeadUrls = [...new Set([currentIconUrl, summary.checksUrl].filter(Boolean))];
          for (const deferredUrl of currentHeadUrls) {
            const deferredDetail = await fetchDeferredDetail(deferredUrl, { preferHtml: true });
            if (deferredDetail?.checks && deferredDetail.checks !== "unknown") {
              detail = mergeDeferredChecks(detail, deferredDetail);
              verifiedHeadAwareChecks = true;
              break;
            }
          }
        }
      } else if (detail.review === "unknown" || detail.checks === "unknown" || detail.merge === "unknown") {
        const deferredUrl = findDeferredStatusEndpoint(prDocument, summary.url);
        const deferredDetail = await fetchDeferredDetail(deferredUrl);
        detail = mergeNativeDetails(detail, deferredDetail);
      }
      let unresolvedThreads = parseUnresolvedThreadCountDocument(prDocument);
      if (!Number.isInteger(unresolvedThreads)) {
        const filesUrl = `${summary.url}/files`;
        try {
          const filesHtml = await fetchHtml(fetchImpl, filesUrl);
          unresolvedThreads = parseUnresolvedThreadCountDocument(parser(filesHtml, filesUrl));
        } catch {
        }
      }
      const mergedDetail = mergeNativeDetails(detail, { unresolvedThreads });
      const lifecycle = buildLifecycleSnapshot({
        summary: { ...summary, ...mergedDetail },
        detail: mergedDetail,
        prDocument,
        observedAt,
        previousLifecycle
      });
      return {
        detail: { ...mergedDetail, lifecycle },
        cacheEntry: buildDetailCacheEntry(summary, { ...mergedDetail, lifecycle }, verifiedHeadAwareChecks)
      };
    }
    async function fetchDeferredDetail(deferredUrl, { preferHtml = false } = {}) {
      if (!deferredUrl || !isSameOriginGitHubUrl(deferredUrl)) {
        return null;
      }
      try {
        const response = await fetchImpl(deferredUrl, {
          credentials: "include",
          headers: {
            Accept: preferHtml ? "text/html,application/xhtml+xml" : "application/json,text/html"
          }
        });
        if (!response.ok) {
          return null;
        }
        const contentType = response.headers?.get?.("content-type") || "";
        if (contentType.includes("application/json")) {
          return parsePrDetailPayload(await response.json());
        }
        const body = await response.text();
        let deferredDetail = parsePrDetailDocument(parser(body, deferredUrl), deferredUrl);
        if (/\/partials\/commit_status_icon(?:\?|$)/.test(deferredUrl) && !body.trim()) {
          deferredDetail = mergeNativeDetails(deferredDetail, { checks: "none" });
        }
        return deferredDetail;
      } catch {
        return null;
      }
    }
    async function removeOpenSummary(key) {
      const latest = await storage.load();
      latest.openListCache = {
        updatedAt: now(),
        items: (latest.openListCache.items || []).filter((summary) => summary.key !== key)
      };
      latest.detailCache = { ...latest.detailCache || {} };
      delete latest.detailCache[key];
      await storage.save(latest);
      state.allSummaries = state.allSummaries.filter((summary) => summary.key !== key);
      if (state.selectedKey === key) {
        state.selectedKey = null;
      }
      state.prAction = { key: null, type: null, pending: false, error: "" };
      state.filteredSummaries = computeFiltered();
      render();
    }
    async function exportData() {
      try {
        await ui?.flushPending();
      } catch (error) {
        state.warning = `Export failed. ${error.message}`;
        render();
        return;
      }
      const envelope = await storage.load();
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.download = `github-pr-tracker-${login}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    async function importFromText(rawText) {
      try {
        await ui?.flushPending();
      } catch (error) {
        state.warning = `Import failed. ${error.message}`;
        render();
        return;
      }
      try {
        const payload = JSON.parse(rawText);
        await storage.importEnvelope(payload);
        state.warning = "";
      } catch (error) {
        state.warning = `Import failed. ${error.message}`;
      }
      render();
    }
    async function importData() {
      try {
        await ui?.flushPending();
      } catch (error) {
        state.warning = `Import failed. ${error.message}`;
        render();
        return;
      }
      const input = doc.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) {
          return;
        }
        await importFromText(await file.text());
      });
      input.click();
    }
    function createHandlers() {
      return {
        onSearch(value) {
          state.search = value;
          state.filteredSummaries = computeFiltered();
          render();
        },
        onStatusFilter(status) {
          state.statusFilter = status;
          if (status === "done") {
            state.showCompleted = true;
          }
          state.filteredSummaries = computeFiltered();
          render();
        },
        onTagFilter(tagName) {
          state.tagFilter = tagName;
          state.filteredSummaries = computeFiltered();
          render();
        },
        onToggleCompleted() {
          state.showCompleted = !state.showCompleted;
          state.filteredSummaries = computeFiltered();
          render();
        },
        async onFilterChange(filterPreferences) {
          const previous = state.filterPreferences;
          state.filterPreferences = normalizeFilterPreferences({
            ...state.filterPreferences,
            ...filterPreferences
          });
          state.filteredSummaries = computeFiltered();
          render();
          try {
            await storage.updateFilterPreferences(state.filterPreferences);
          } catch (error) {
            state.filterPreferences = previous;
            state.warning = `Could not save filters. ${error.message}`;
            render();
          }
        },
        async onClearFilters() {
          const previous = state.filterPreferences;
          state.filterPreferences = normalizeFilterPreferences(DEFAULT_FILTER_PREFERENCES);
          state.filteredSummaries = computeFiltered();
          render();
          try {
            await storage.updateFilterPreferences(state.filterPreferences);
          } catch (error) {
            state.filterPreferences = previous;
            state.warning = `Could not clear filters. ${error.message}`;
            render();
          }
        },
        async onSortChange(sortPreferences) {
          const previous = state.sortPreferences;
          state.sortPreferences = normalizeSortPreferencesForSummaries(sortPreferences, state.allSummaries);
          state.filteredSummaries = computeFiltered();
          render();
          try {
            await storage.updateSortPreferences(state.sortPreferences);
          } catch (error) {
            state.sortPreferences = previous;
            state.warning = `Could not save sorting. ${error.message}`;
            render();
          }
        },
        async onToggleGroup(groupKey) {
          const collapseKey = buildGroupCollapseStateKey(state.sortPreferences?.primary?.field, groupKey);
          if (!collapseKey) {
            return;
          }
          const previous = state.collapsedGroups;
          const next = new Set(previous);
          if (next.has(collapseKey)) {
            next.delete(collapseKey);
          } else {
            next.add(collapseKey);
          }
          state.collapsedGroups = next;
          render();
          try {
            await storage.updateCollapsedGroups([...next]);
          } catch (error) {
            state.collapsedGroups = previous;
            state.warning = `Could not save collapsed groups. ${error.message}`;
            render();
          }
        },
        onSelect(key) {
          if (state.selectedKey && state.selectedKey !== key) {
            void ui?.flushPending(state.selectedKey)?.catch(() => {
            });
          }
          state.selectedKey = key;
          if (state.prAction.key !== key && !state.prAction.pending) {
            state.prAction = { key: null, type: null, pending: false, error: "" };
          }
          render();
        },
        async onMerge(key) {
          const summary = state.allSummaries.find((item) => item.key === key);
          if (!summary || summary.merge !== "clean" || summary.draft || state.prAction.pending) {
            return;
          }
          const confirmed = win.confirm(
            `Squash and merge ${summary.owner}/${summary.repo}#${summary.number}?

GitHub's default commit title will be kept and the commit message body will be empty.`
          );
          if (!confirmed) {
            return;
          }
          state.warning = "";
          state.prAction = { key, type: "merge", pending: true, error: "" };
          render();
          try {
            await ui?.flushPending(key);
            await squashMergePullRequest({ fetchImpl, parser, summary });
            await removeOpenSummary(key);
          } catch (error) {
            state.prAction = { key, type: "merge", pending: false, error: error.message };
            if (state.selectedKey !== key) {
              state.warning = `Merge failed for ${summary.owner}/${summary.repo}#${summary.number}. ${error.message}`;
            }
            render();
          }
        },
        async onClosePullRequest(key, comment) {
          const summary = state.allSummaries.find((item) => item.key === key);
          if (!summary || state.prAction.pending) {
            return;
          }
          state.prAction = { key, type: "close", pending: true, error: "" };
          render();
          try {
            await ui?.flushPending(key);
            await closePullRequest({ fetchImpl, parser, summary, comment });
            await removeOpenSummary(key);
          } catch (error) {
            state.prAction = { key, type: "close", pending: false, error: error.message };
            render();
          }
        },
        async onRefresh() {
          await refresh(true);
        },
        async onEdit(key, patch, timestamp) {
          await storage.upsertRecord(key, patch, timestamp);
        },
        async onQuickStatus(key, status) {
          const previous = state.records[key] || DEFAULT_RECORD;
          const timestamp = now();
          state.records[key] = { ...previous, status, modifiedAt: timestamp };
          if (status === "blocked") {
            state.selectedKey = key;
          }
          state.filteredSummaries = computeFiltered();
          render();
          try {
            await storage.upsertRecord(key, { status }, timestamp);
            setSaveState("Saved");
          } catch (error) {
            state.records[key] = previous;
            state.warning = `Could not save status. ${error.message}`;
            render();
          }
        },
        onLocalPatch(key, patch) {
          state.records[key] = { ...state.records[key] || DEFAULT_RECORD, ...patch };
        },
        async onAddTag(key, name, color) {
          const current = state.records[key] || DEFAULT_RECORD;
          const tags = normalizeTags([...current.tags, { name, color }]);
          await storage.upsertRecord(key, { tags }, now());
        },
        async onRemoveTag(key, tagName) {
          const current = state.records[key] || DEFAULT_RECORD;
          const tags = current.tags.filter((tag) => tag.name.toLocaleLowerCase() !== tagName.toLocaleLowerCase());
          await storage.upsertRecord(key, { tags }, now());
        },
        onExport: exportData,
        onImport: importData
      };
    }
    function setSaveState(value) {
      state.saveState = value;
      ui?.setSaveState(value);
    }
    function render() {
      if (!state.mounted || !ui) {
        return;
      }
      state.filteredSummaries = computeFiltered();
      const sortPreferences = normalizeSortPreferencesForSummaries(state.sortPreferences, state.allSummaries);
      const currentTime = now();
      const primaryGroupField = sortPreferences.primary.field;
      ui.render({
        ...state,
        currentTime,
        sortPreferences,
        summaryGroups: groupSummaries({
          summaries: state.filteredSummaries,
          records: state.records,
          sortPreferences,
          currentTime
        }).map((group) => ({
          ...group,
          collapsed: state.collapsedGroups.has(buildGroupCollapseStateKey(primaryGroupField, group.key))
        })),
        groupOptions: getAvailableGroupOptions(state.allSummaries),
        sortOptions: getAvailableSortOptions(state.allSummaries),
        styles
      });
    }
    return {
      init,
      mount,
      unmount,
      handleRoute,
      refresh,
      importFromText,
      exportData,
      flushPending: () => ui?.flushPending(),
      getState: () => state
    };
  }
  function buildGroupCollapseStateKey(primaryField, groupKey) {
    if (!primaryField || !groupKey) {
      return "";
    }
    return `${primaryField}::${groupKey}`;
  }
  function mergeSummaryDetail(summary, detail) {
    const merged = mergeNativeDetails(detail, summary);
    const result = {
      review: merged.review,
      // A green authored-list rollup is scoped to summary.headSha and is newer
      // than a cached detail. Keep it authoritative even on cache-hit paths.
      checks: summary.headSha && summary.checks === "passing" ? "passing" : merged.checks,
      merge: merged.merge,
      draft: typeof merged.draft === "boolean" ? merged.draft : summary.draft
    };
    if (merged.createdAt) {
      result.createdAt = merged.createdAt;
    }
    const jiraReferences = mergeJiraReferences(summary.title, merged.jiraReferences, merged.jiraBaseUrl);
    if (jiraReferences.length) {
      result.jiraReferences = jiraReferences;
    }
    if (Number.isInteger(merged.unresolvedThreads)) {
      result.unresolvedThreads = merged.unresolvedThreads;
    }
    if (detail?.lifecycle && typeof detail.lifecycle === "object") {
      result.lifecycle = detail.lifecycle;
    }
    return result;
  }
  function mergeDeferredChecks(detail, deferredDetail) {
    const merged = mergeNativeDetails(detail, deferredDetail);
    if (deferredDetail?.checks && deferredDetail.checks !== "unknown") {
      merged.checks = deferredDetail.checks;
    }
    return merged;
  }
  function isCacheHeadMatch(cached, summary) {
    if (summary.headSha) {
      return cached?.headSha === summary.headSha && (!summary.checksUrl || !cached?.checksUrl || cached.checksUrl === summary.checksUrl);
    }
    return true;
  }
  function isCacheChecksCurrent(cached, summary) {
    if (!summary.headSha) {
      return true;
    }
    return summary.checks === "passing" && cached?.detail?.checks === "passing";
  }
  function buildDetailCacheEntry(summary, detail, verifiedHeadAwareChecks) {
    if (summary.headSha) {
      if (!verifiedHeadAwareChecks) {
        return null;
      }
      return {
        updatedAt: now(),
        parserVersion: DETAIL_PARSER_VERSION,
        detail,
        headSha: summary.headSha,
        checksUrl: summary.checksUrl || ""
      };
    }
    return {
      updatedAt: now(),
      parserVersion: DETAIL_PARSER_VERSION,
      detail,
      headSha: "",
      checksUrl: ""
    };
  }
  function mergeDetailCache({ latestDetailCache, snapshotDetailCache, pendingCacheWrites }) {
    const merged = { ...latestDetailCache || {} };
    for (const [key, entry] of pendingCacheWrites.entries()) {
      const latestEntry = merged[key];
      const snapshotHadKey = Object.hasOwn(snapshotDetailCache, key);
      if (!Object.hasOwn(latestDetailCache, key) && snapshotHadKey) {
        continue;
      }
      if (latestEntry && Number.isFinite(latestEntry.updatedAt) && latestEntry.updatedAt > entry.updatedAt) {
        continue;
      }
      merged[key] = entry;
    }
    return merged;
  }
  function mergeJiraReferences(title, detailReferences, jiraBaseUrl) {
    const references = [];
    const seenKeys = /* @__PURE__ */ new Set();
    for (const reference of Array.isArray(detailReferences) ? detailReferences : []) {
      if (!reference?.key || !reference?.url || seenKeys.has(reference.key)) {
        continue;
      }
      seenKeys.add(reference.key);
      references.push(reference);
    }
    if (!jiraBaseUrl) {
      return references;
    }
    for (const key of extractJiraIssueKeys(title)) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      references.push({ key, url: `${jiraBaseUrl}${encodeURIComponent(key)}` });
    }
    return references;
  }

  // src/storage.js
  function createStorage(gm, login) {
    const storageKey = `${APP_ID}:${login}`;
    const listeners = /* @__PURE__ */ new Set();
    async function load() {
      const raw = await Promise.resolve(gm.getValue(storageKey, null));
      return normalizeEnvelope(raw, login);
    }
    async function save(envelope) {
      await Promise.resolve(gm.setValue(storageKey, envelope));
      return envelope;
    }
    function subscribe(onChange) {
      listeners.add(onChange);
      const listenerId = gm.addValueChangeListener ? gm.addValueChangeListener(storageKey, (_name, _oldValue, newValue, remote) => {
        if (!remote) {
          return;
        }
        onChange(normalizeEnvelope(newValue, login));
      }) : null;
      return () => {
        listeners.delete(onChange);
        if (listenerId !== null && gm.removeValueChangeListener) {
          gm.removeValueChangeListener(listenerId);
        }
      };
    }
    async function upsertRecord(key, patch, timestamp) {
      const envelope = await load();
      const current = envelope.records[key] || DEFAULT_RECORD;
      envelope.records[key] = normalizeRecord({ ...current, ...patch, modifiedAt: timestamp });
      await save(envelope);
      for (const listener of listeners) {
        listener(envelope);
      }
      return envelope;
    }
    async function updateSortPreferences(sortPreferences) {
      const envelope = await load();
      envelope.sortPreferences = normalizeSortPreferences({
        ...envelope.sortPreferences,
        ...sortPreferences
      });
      await save(envelope);
      for (const listener of listeners) {
        listener(envelope);
      }
      return envelope;
    }
    async function updateFilterPreferences(filterPreferences) {
      const envelope = await load();
      envelope.filterPreferences = normalizeFilterPreferences({
        ...envelope.filterPreferences,
        ...filterPreferences
      });
      await save(envelope);
      for (const listener of listeners) {
        listener(envelope);
      }
      return envelope;
    }
    async function updateCollapsedGroups(collapsedGroups) {
      const envelope = await load();
      const nextEnvelope = {
        ...envelope,
        collapsedGroups: normalizeCollapsedGroups(collapsedGroups)
      };
      await save(nextEnvelope);
      for (const listener of listeners) {
        listener(nextEnvelope);
      }
      return nextEnvelope;
    }
    async function importEnvelope(rawEnvelope) {
      validateImportEnvelope(rawEnvelope);
      if (rawEnvelope.accountLogin !== login) {
        throw new Error(`Import account ${rawEnvelope.accountLogin} does not match signed-in account ${login}.`);
      }
      const current = await load();
      const merged = normalizeEnvelope(current, login);
      merged.records = mergeImportedRecords(merged.records, rawEnvelope.records);
      await save(merged);
      for (const listener of listeners) {
        listener(merged);
      }
      return merged;
    }
    return {
      storageKey,
      load,
      save,
      subscribe,
      upsertRecord,
      updateSortPreferences,
      updateFilterPreferences,
      updateCollapsedGroups,
      importEnvelope
    };
  }

  // src/entry.js
  function createDocumentParser() {
    return (html) => new DOMParser().parseFromString(html, "text/html");
  }
  function getGmApi() {
    return {
      getValue: globalThis.GM_getValue?.bind(globalThis),
      setValue: globalThis.GM_setValue?.bind(globalThis),
      addValueChangeListener: globalThis.GM_addValueChangeListener?.bind(globalThis),
      removeValueChangeListener: globalThis.GM_removeValueChangeListener?.bind(globalThis)
    };
  }
  async function bootstrap() {
    const login = detectCurrentLogin(document);
    if (!login) {
      return;
    }
    ensureTrackerNav(document);
    const app = createTrackerApp({
      doc: document,
      win: window,
      fetchImpl: window.fetch.bind(window),
      parser: createDocumentParser(),
      storage: createStorage(getGmApi(), login),
      login,
      version: globalThis.GM_info?.script?.version || "unknown"
    });
    await app.init();
    const rerun = () => {
      ensureTrackerNav(document);
      app.handleRoute();
    };
    const observer = new MutationObserver(() => rerun());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", rerun);
    window.addEventListener("hashchange", rerun);
    window.addEventListener("beforeunload", () => {
      void app.flushPending?.().catch(() => {
      });
    });
    document.addEventListener("pjax:end", rerun);
  }
  bootstrap().catch((error) => {
    console.error("GitHub PR Tracker failed to start", error);
  });
})();
