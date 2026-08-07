// ==UserScript==
// @name         GitHub Personal PR Tracker
// @namespace    https://github.com/
// @version      1.2.2
// @description  Personal pull request tracker for your own open Toast GitHub PRs.
// @homepageURL  https://github.com/NathanNorman/github-pr-tracker
// @supportURL   https://github.com/NathanNorman/github-pr-tracker/issues
// @downloadURL  https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @match        https://github.toasttab.com/pulls*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(() => {
  // src/constants.js
  var APP_ID = "tm-github-pr-tracker";
  var GITHUB_ORIGIN = "https://github.toasttab.com";
  var SCHEMA_VERSION = 1;
  var DETAIL_CACHE_TTL_MS = 10 * 60 * 1e3;
  var DETAIL_PARSER_VERSION = 2;
  var OPEN_LIST_CACHE_TTL_MS = 5 * 60 * 1e3;
  var SAVE_DEBOUNCE_MS = 400;
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
  function safeJsonParse(text, fallback = null) {
    try {
      return JSON.parse(text);
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
    const draft = typeof payload.isDraft === "boolean" ? payload.isDraft : typeof payload.draft === "boolean" ? payload.draft : payload.state === "DRAFT" ? true : payload.state === "OPEN" ? false : void 0;
    if (!reviewState && !checksState && !mergeState && typeof draft !== "boolean") {
      return null;
    }
    return {
      review: normalizeReviewState(reviewState || "unknown"),
      checks: normalizeCheckState(checksState || "unknown"),
      merge: normalizeMergeState(mergeState || "unknown"),
      draft: typeof draft === "boolean" ? draft : void 0
    };
  }
  function findEmbeddedPayload(doc) {
    for (const script of doc.querySelectorAll("script")) {
      const text = script.textContent || "";
      const isCurrentEmbeddedData = script.matches('script[type="application/json"][data-target*="embeddedData"]');
      if (!isCurrentEmbeddedData && !text.includes("reviewDecision") && !text.includes("statusCheckRollup") && !text.includes("mergeStateStatus")) {
        continue;
      }
      const matches = text.match(/\{[\s\S]*\}/g) || [];
      for (const candidate of matches) {
        const parsed = safeJsonParse(candidate);
        const detail = extractNestedPayloadDetail(parsed);
        if (detail) {
          return detail;
        }
      }
    }
    return null;
  }
  function detailFromDom(doc) {
    let review = "unknown";
    let checks = "unknown";
    let merge = "unknown";
    const currentReviewRoot = doc.querySelector('[data-url*="pull_requests%2Fsidebar%2Fshow%2Freviewers"]') || doc.querySelector('form[id^="pull-request-reviewers-form-"]') || doc.querySelector('[data-test-selector="required-review-banner"], [data-review-state]');
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
    } else if (/review required|required review|review requested/i.test(reviewText)) {
      review = "required";
    } else if (/no reviews/i.test(reviewText)) {
      review = "none";
    }
    const checkNodes = [
      ...doc.querySelectorAll(
        '.commit-build-statuses summary, [data-deferred-details-content-url*="/status-details"], [data-mergeability-message], [aria-label*="checks" i], [data-checks-state]'
      )
    ];
    const checksText = checkNodes.map((node) => {
      const labelled = [node, ...node.querySelectorAll("[aria-label]")];
      return [
        node.className,
        node.getAttribute("data-checks-state"),
        node.textContent,
        ...labelled.map((item) => item.getAttribute("aria-label"))
      ].filter(Boolean).join(" ");
    }).join(" ");
    if (/color-fg-danger|octicon-x|failing|failed|checks? not successful/i.test(checksText)) {
      checks = "failing";
    } else if (/hx_dot-fill-pending-icon|pending|expected|running|in progress/i.test(checksText)) {
      checks = "pending";
    } else if (/color-fg-success|successful|passed|all checks have passed|\d+\s*\/\s*\d+ checks OK/i.test(checksText)) {
      checks = "passing";
    } else if (/no checks/i.test(checksText)) {
      checks = "none";
    }
    const mergeText = doc.querySelector('[data-mergeability-message], [data-test-selector="mergebox"], [aria-label*="merge"]')?.textContent || "";
    if (/\bconflicts?\b/i.test(mergeText) && !/\bno conflicts?\b/i.test(mergeText)) {
      merge = "conflicting";
    } else if (/cannot be merged|blocked|merge is blocked/i.test(mergeText)) {
      merge = "blocked";
    } else if (/has no conflicts|can be merged|merge pull request/i.test(mergeText)) {
      merge = "clean";
    }
    const draft = /draft/i.test(doc.querySelector('[aria-label="Pull request state"]')?.textContent || "") ? true : void 0;
    return { review, checks, merge, draft };
  }
  function parsePrDetailDocument(doc) {
    const embedded = findEmbeddedPayload(doc);
    const dom = detailFromDom(doc);
    return mergeNativeDetails(embedded, dom);
  }
  function findDeferredStatusEndpoint(doc, baseUrl = GITHUB_ORIGIN) {
    const baseOrigin = new URL(baseUrl, GITHUB_ORIGIN).origin;
    const candidateAttributes = [
      "data-status-details-url",
      "data-checks-status-url",
      "data-checks-url",
      "data-details-url",
      "data-url",
      "href"
    ];
    for (const attribute of candidateAttributes) {
      for (const node of doc.querySelectorAll(`[${attribute}]`)) {
        const value = node.getAttribute(attribute);
        if (!value || !/\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)/.test(value)) {
          continue;
        }
        const resolved = new URL(value, baseUrl).href;
        if (new URL(resolved).origin === baseOrigin) {
          return resolved;
        }
      }
    }
    for (const script of doc.querySelectorAll("script")) {
      const text = script.textContent || "";
      const matches = text.match(
        /https?:\/\/[^"'\\s]+\/[^"'\\s]+\/[^"'\\s]+\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)[^"'\\s]*/g
      ) || [];
      for (const match of matches) {
        if (new URL(match).origin === baseOrigin) {
          return match;
        }
      }
    }
    return null;
  }
  function mergeNativeDetails(primary, fallback) {
    const left = primary || {};
    const right = fallback || {};
    return {
      review: left.review && left.review !== "unknown" ? left.review : right.review || "unknown",
      checks: left.checks && left.checks !== "unknown" ? left.checks : right.checks || "unknown",
      merge: left.merge && left.merge !== "unknown" ? left.merge : right.merge || "unknown",
      draft: typeof left.draft === "boolean" ? left.draft : right.draft
    };
  }
  function extractNestedPayloadDetail(root) {
    const stack = [root];
    const seen = /* @__PURE__ */ new Set();
    let merged = null;
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      seen.add(value);
      const detail = parsePrDetailPayload(value);
      if (detail) {
        merged = mergeNativeDetails(merged, detail);
        if (merged.review !== "unknown" && merged.checks !== "unknown" && merged.merge !== "unknown" && typeof merged.draft === "boolean") {
          return merged;
        }
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
          stack.push(child);
        }
      }
    }
    return merged;
  }

  // src/models.js
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
      detailCache: normalizeDetailCache(rawEnvelope?.detailCache)
    };
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
        detail: value.detail && typeof value.detail === "object" ? value.detail : {}
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
  function filterSummaries({ summaries, records, search, statusFilter, tagFilter, showCompleted }) {
    const normalizedSearch = (search || "").trim().toLocaleLowerCase();
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
      const draft = Boolean(row?.textContent?.match(/\bDraft\b/i));
      items.push({
        key: parsed.key,
        url: parsed.url,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        title,
        updatedAt,
        draft
      });
    }
    const nextHref = doc.querySelector('a[rel="next"]')?.getAttribute("href") || [...doc.querySelectorAll("a")].find((anchor) => /^next$/i.test(anchor.textContent.trim()))?.getAttribute("href") || null;
    const nextUrl = nextHref ? new URL(nextHref, origin).href : null;
    return { items, nextHref: nextUrl && isSameOriginGitHubUrl(nextUrl) ? nextUrl : null };
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
    const text = anchor.textContent?.trim() || "";
    if (!text) {
      return 0;
    }
    let score = text.length;
    if (text === `${parsed.owner}/${parsed.repo}` || text === `#${parsed.number}`) {
      score -= 100;
    }
    if (/^\d+$/.test(text) || /^#\d+$/.test(text)) {
      score -= 100;
    }
    if (anchor.matches('[data-hovercard-type="pull_request"], [id*="issue_"], [data-test-selector]')) {
      score += 20;
    }
    return score;
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
}
.pr-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 156px;
  grid-template-areas:
    "select status"
    "tags status";
  align-items: center;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.pr-row:first-child {
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
.row-details,
.blocker-preview {
  display: block;
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
  margin-bottom: 2px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.row-details {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  margin-top: 7px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
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
.quick-status {
  position: relative;
  grid-area: status;
  margin: 0 14px 0 4px;
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
}
@media (max-width: 620px) {
  .pr-row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "select"
      "tags"
      "status";
  }
  .quick-status {
    margin: 0 16px 14px 52px;
  }
}
`;

  // src/ui.js
  var STATUS_LABELS = {
    unsorted: "Unsorted",
    next_up: "Next up",
    waiting: "Waiting",
    blocked: "Blocked",
    done: "Done"
  };
  function createUi(container, handlers) {
    const doc = container.ownerDocument;
    const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    const root = doc.createElement("div");
    root.className = "tracker-root";
    shadow.replaceChildren(style, root);
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
    privacy.textContent = "Stored in this browser";
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
    const refreshButton = makeActionButton("Refresh", () => handlers.onRefresh(), "action-btn");
    panelHeader.append(resultCount, refreshButton);
    const warning = doc.createElement("div");
    warning.className = "warning";
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
          emptyText.textContent = "Try another status or clear your search.";
        }
        empty.append(emptyTitle, emptyText);
        list.append(empty);
        return;
      }
      for (const summary of state.filteredSummaries) {
        const record = state.records[summary.key] || DEFAULT_RECORD;
        const row = doc.createElement("div");
        row.className = "pr-row";
        row.dataset.prKey = summary.key;
        const rowButton = doc.createElement("button");
        rowButton.type = "button";
        rowButton.className = "pr-row-select";
        rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
        rowButton.setAttribute("aria-label", `Edit personal tracking for ${summary.title}`);
        rowButton.addEventListener("click", () => {
          focusedBeforeDrawer = shadow.activeElement;
          handlers.onSelect(summary.key);
        });
        rowButton.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            focusedBeforeDrawer = shadow.activeElement;
            handlers.onSelect(summary.key);
          }
        });
        const rowIcon = doc.createElement("span");
        rowIcon.className = "pr-icon";
        rowIcon.setAttribute("aria-hidden", "true");
        const rowCopy = doc.createElement("span");
        rowCopy.className = "row-copy";
        const repo = doc.createElement("span");
        repo.className = "repo";
        repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
        const title = doc.createElement("span");
        title.className = "title";
        title.textContent = summary.title;
        const details = doc.createElement("span");
        details.className = "row-details";
        if (summary.updatedAt) {
          const updated = doc.createElement("span");
          updated.textContent = `Updated ${formatRelativeTime(summary.updatedAt)}`;
          details.append(updated);
        }
        appendKnownBadge(details, "Review", summary.review);
        appendKnownBadge(details, "Checks", summary.checks);
        appendKnownBadge(details, "Merge", summary.merge);
        if (summary.draft) {
          details.append(makeBadge("Draft", "draft"));
        }
        if (record.status === "blocked" && record.blockedBy) {
          const blocker = doc.createElement("span");
          blocker.className = "blocker-preview";
          blocker.textContent = `Blocked by ${record.blockedBy}`;
          rowCopy.append(repo, title, details, blocker);
        } else {
          rowCopy.append(repo, title, details);
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
        row.append(rowButton, quickStatus);
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
        list.append(row);
      }
    }
    function renderDrawer(state) {
      shell.classList.toggle("has-drawer", Boolean(state.selectedKey));
      drawer.hidden = !state.selectedKey;
      if (!state.selectedKey) {
        void flushPending(currentSelectedKey);
        currentSelectedKey = null;
        drawer.textContent = "";
        return;
      }
      const summary = state.allSummaries.find((item) => item.key === state.selectedKey) || state.filteredSummaries.find((item) => item.key === state.selectedKey);
      const record = state.records[state.selectedKey] || DEFAULT_RECORD;
      currentSelectedKey = state.selectedKey;
      drawer.textContent = "";
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
      close.addEventListener("click", async () => {
        await flushPending(state.selectedKey);
        handlers.onSelect(null);
        if (focusedBeforeDrawer instanceof HTMLElement) {
          focusedBeforeDrawer.focus();
        }
      });
      header.append(headerText, close);
      const identity = doc.createElement("div");
      identity.className = "drawer-identity";
      const identityTitle = doc.createElement("div");
      identityTitle.className = "title";
      identityTitle.textContent = summary?.title || state.selectedKey;
      const identityRepo = doc.createElement("div");
      identityRepo.className = "repo";
      identityRepo.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
      identity.append(identityTitle, identityRepo);
      const statusField = makeField("My status");
      const statusSelect = makeStatusSelect(record.status);
      statusSelect.setAttribute("data-focus-id", "status");
      const blockerField = makeField("Blocked by");
      const blockerInput = doc.createElement("input");
      blockerInput.type = "text";
      blockerInput.placeholder = "Person, team, decision, or dependency";
      blockerInput.value = record.blockedBy;
      blockerField.hidden = record.status !== "blocked";
      blockerInput.setAttribute("data-focus-id", "blockedBy");
      blockerInput.addEventListener("input", () => queueSave(state.selectedKey, { blockedBy: blockerInput.value }));
      blockerInput.addEventListener("blur", () => void flushPending(state.selectedKey));
      blockerField.append(blockerInput);
      statusSelect.addEventListener("change", () => {
        queueSave(state.selectedKey, { status: statusSelect.value });
        blockerField.hidden = statusSelect.value !== "blocked";
        if (statusSelect.value === "blocked") {
          blockerInput.focus();
        }
      });
      statusField.append(statusSelect);
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
      const addTag = makeActionButton("Add", null, "action-btn");
      addTag.type = "submit";
      tagForm.addEventListener("submit", (event) => {
        event.preventDefault();
        handlers.onAddTag(state.selectedKey, tagInput.value, colorSelect.value);
        tagInput.value = "";
      });
      tagForm.append(tagInput, colorSelect, addTag);
      const existingTags = doc.createElement("div");
      existingTags.className = "tags";
      for (const tag of record.tags) {
        const pill = makeTagButton(tag, {
          ariaLabel: `Remove tag ${tag.name}`,
          onClick() {
            handlers.onRemoveTag(state.selectedKey, tag.name);
          }
        });
        pill.title = "Remove private tag";
        existingTags.append(pill);
      }
      tagsField.append(tagsLabel, tagForm, existingTags);
      const notesField = makeField("My notes");
      const notesInput = doc.createElement("textarea");
      notesInput.rows = 7;
      notesInput.placeholder = "Context, next steps, reminders\u2026";
      notesInput.value = record.notes;
      notesInput.setAttribute("data-focus-id", "notes");
      notesInput.addEventListener("input", () => queueSave(state.selectedKey, { notes: notesInput.value }));
      notesInput.addEventListener("blur", () => void flushPending(state.selectedKey));
      notesField.append(notesInput);
      const footer = doc.createElement("div");
      footer.className = "drawer-footer";
      const link = doc.createElement("a");
      link.className = "link-btn";
      link.href = summary?.url || "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open on GitHub \u2197";
      saveState.textContent = state.saveState;
      footer.append(saveState, link);
      drawer.append(header, identity, statusField, blockerField, tagsField, notesField, footer);
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
      let entry = pendingSaves.get(key);
      if (!entry) {
        entry = {
          patch: {},
          running: Promise.resolve(),
          scheduled: false,
          debounced: debounce(() => {
            void startSave(key);
          }, SAVE_DEBOUNCE_MS)
        };
        pendingSaves.set(key, entry);
      }
      entry.patch = { ...entry.patch, ...patch };
      handlers.onLocalPatch?.(key, patch);
      setSaveState("Saving\u2026");
      entry.debounced();
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
      entry.debounced.flush();
      await entry.running;
      if (!entry.scheduled && !Object.keys(entry.patch).length) {
        pendingSaves.delete(key);
      }
    }
    function startSave(key) {
      const entry = pendingSaves.get(key);
      if (!entry) {
        return Promise.resolve();
      }
      if (entry.scheduled || !Object.keys(entry.patch).length) {
        return entry.running;
      }
      entry.scheduled = true;
      const patchToSave = { ...entry.patch };
      entry.patch = {};
      entry.running = entry.running.catch(() => {
      }).then(async () => {
        try {
          await handlers.onEdit(key, patchToSave, now());
        } finally {
          entry.scheduled = false;
          if (Object.keys(entry.patch).length) {
            return startSave(key);
          }
          pendingSaves.delete(key);
        }
      });
      return entry.running;
    }
    function setSaveState(value) {
      saveState.textContent = value;
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
    function makeBadge(label, value) {
      const badge = doc.createElement("span");
      badge.className = "badge";
      badge.dataset.state = value;
      badge.textContent = `${label}: ${String(value).replaceAll("_", " ")}`;
      return badge;
    }
    function appendKnownBadge(target, label, value) {
      if (value && value !== "unknown") {
        target.append(makeBadge(label, value));
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
    return { render, shadow, flushPending, setSaveState };
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
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > 110 ? `Note \xB7 ${text.slice(0, 107)}\u2026` : `Note \xB7 ${text}`;
  }

  // src/app.js
  function createTrackerApp({ doc, win, fetchImpl, parser, storage, login }) {
    const state = {
      login,
      allSummaries: [],
      filteredSummaries: [],
      records: {},
      search: "",
      statusFilter: "all",
      tagFilter: "",
      selectedKey: null,
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
      state.filteredSummaries = computeFiltered();
      unsubscribe = storage.subscribe((nextEnvelope) => {
        state.records = nextEnvelope.records;
        state.filteredSummaries = computeFiltered();
        render();
      });
      await handleRoute();
    }
    function computeFiltered() {
      return filterSummaries({
        summaries: state.allSummaries,
        records: state.records,
        search: state.search,
        statusFilter: state.statusFilter,
        tagFilter: state.tagFilter,
        showCompleted: state.showCompleted
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
      void ui?.flushPending();
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
        const detailCache = { ...snapshot.detailCache || {} };
        try {
          const summaries = await fetchOpenPrs({ fetchImpl, parser, startUrl: trackerSearchUrl(login) });
          const enriched = await mapLimit(summaries, 4, async (summary) => {
            try {
              const cached = detailCache[summary.key];
              const shouldUseCache = !force && cached && cached.parserVersion === DETAIL_PARSER_VERSION && now() - cached.updatedAt < DETAIL_CACHE_TTL_MS;
              const detail = shouldUseCache ? cached.detail : await fetchDetail(summary);
              detailCache[summary.key] = { updatedAt: now(), parserVersion: DETAIL_PARSER_VERSION, detail };
              return {
                ...summary,
                ...mergeSummaryDetail(summary, detail)
              };
            } catch {
              return summary;
            }
          });
          const latest = await storage.load();
          latest.openListCache = { updatedAt: now(), items: enriched };
          latest.detailCache = detailCache;
          await storage.save(latest);
          state.allSummaries = enriched;
          state.records = latest.records;
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
    async function fetchDetail(summary) {
      const html = await fetchHtml(fetchImpl, summary.url);
      const prDocument = parser(html);
      let detail = parsePrDetailDocument(prDocument);
      const needsDeferred = detail.review === "unknown" || detail.checks === "unknown" || detail.merge === "unknown";
      if (!needsDeferred) {
        return detail;
      }
      const deferredUrl = findDeferredStatusEndpoint(prDocument, summary.url);
      if (!deferredUrl || !isSameOriginGitHubUrl(deferredUrl)) {
        return detail;
      }
      try {
        const response = await fetchImpl(deferredUrl, {
          credentials: "include",
          headers: {
            Accept: "application/json,text/html"
          }
        });
        if (!response.ok) {
          return detail;
        }
        const contentType = response.headers?.get?.("content-type") || "";
        let deferredDetail = null;
        if (contentType.includes("application/json")) {
          deferredDetail = parsePrDetailPayload(await response.json());
        } else {
          const body = await response.text();
          deferredDetail = parsePrDetailDocument(parser(body));
          if (/\/partials\/commit_status_icon(?:\?|$)/.test(deferredUrl) && !body.trim()) {
            deferredDetail = mergeNativeDetails(deferredDetail, { checks: "none" });
          }
        }
        return mergeNativeDetails(detail, deferredDetail);
      } catch {
        return detail;
      }
    }
    async function exportData() {
      await ui?.flushPending();
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
      await ui?.flushPending();
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
      await ui?.flushPending();
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
        onSelect(key) {
          if (state.selectedKey && state.selectedKey !== key) {
            void ui?.flushPending(state.selectedKey);
          }
          state.selectedKey = key;
          render();
        },
        async onRefresh() {
          await refresh(true);
        },
        async onEdit(key, patch, timestamp) {
          try {
            await storage.upsertRecord(key, patch, timestamp);
            setSaveState("Saved");
          } catch (error) {
            setSaveState(`Error: ${error.message}`);
          }
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
      ui.render({
        ...state,
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
  function mergeSummaryDetail(summary, detail) {
    return {
      review: detail.review,
      checks: detail.checks,
      merge: detail.merge,
      draft: typeof detail.draft === "boolean" ? detail.draft : summary.draft
    };
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
      login
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
    window.addEventListener("beforeunload", () => app.flushPending?.());
    document.addEventListener("pjax:end", rerun);
  }
  bootstrap().catch((error) => {
    console.error("GitHub PR Tracker failed to start", error);
  });
})();
