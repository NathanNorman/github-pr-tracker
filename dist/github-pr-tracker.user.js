// ==UserScript==
// @name         GitHub Personal PR Tracker
// @namespace    https://github.com/
// @version      1.0.1
// @description  Personal pull request tracker for your own open GitHub PRs.
// @homepageURL  https://github.com/NathanNorman/github-pr-tracker
// @supportURL   https://github.com/NathanNorman/github-pr-tracker/issues
// @downloadURL  https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/NathanNorman/github-pr-tracker/main/dist/github-pr-tracker.user.js
// @match        https://github.com/pulls*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(() => {
  // src/constants.js
  var APP_ID = "tm-github-pr-tracker";
  var SCHEMA_VERSION = 1;
  var DETAIL_CACHE_TTL_MS = 10 * 60 * 1e3;
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
    const draft = typeof payload.isDraft === "boolean" ? payload.isDraft : typeof payload.draft === "boolean" ? payload.draft : void 0;
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
      if (!text.includes("reviewDecision") && !text.includes("statusCheckRollup") && !text.includes("mergeStateStatus")) {
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
    const reviewText = doc.querySelector('[data-test-selector="required-review-banner"], [aria-label*="review"], [data-review-state]')?.textContent || "";
    if (/changes requested/i.test(reviewText)) {
      review = "changes_requested";
    } else if (/approved/i.test(reviewText)) {
      review = "approved";
    } else if (/review required|required review/i.test(reviewText)) {
      review = "required";
    } else if (/no reviews/i.test(reviewText)) {
      review = "none";
    }
    const checksText = doc.querySelector('[data-mergeability-message], [aria-label*="checks"], [data-checks-state]')?.textContent || "";
    if (/failing|failed/.test(checksText.toLowerCase())) {
      checks = "failing";
    } else if (/pending|expected|running/.test(checksText.toLowerCase())) {
      checks = "pending";
    } else if (/successful|passed|all checks have passed/.test(checksText.toLowerCase())) {
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
  function findDeferredStatusEndpoint(doc, baseUrl = "https://github.com") {
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
        if (!value || !/\/pull\/\d+\/(?:checks|status|merge|review|details)/.test(value)) {
          continue;
        }
        const resolved = new URL(value, baseUrl).href;
        if (new URL(resolved).origin === "https://github.com") {
          return resolved;
        }
      }
    }
    for (const script of doc.querySelectorAll("script")) {
      const text = script.textContent || "";
      const match = text.match(/https:\/\/github\.com\/[^"'\\s]+\/pull\/\d+\/(?:checks|status|merge|review|details)[^"'\\s]*/);
      if (match) {
        return match[0];
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
    const url = new URL(input, "https://github.com");
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
      url: `https://github.com/${owner}/${repo}/pull/${number}`
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
  function getVisibleStatusOptions(showCompleted) {
    return showCompleted ? [...ACTIVE_STATUSES, "done"] : ACTIVE_STATUSES;
  }

  // src/github.js
  function isTrackerRoute(location) {
    const url = typeof location === "string" ? new URL(location, "https://github.com") : new URL(location.href);
    const isPullsRoute = url.pathname === "/pulls" || url.pathname === "/pulls/inbox";
    const hasTrackerMarker = url.hash === "#pr-tracker" || url.searchParams.get("pr_tracker") === "1";
    return isPullsRoute && hasTrackerMarker;
  }
  function trackerUrl() {
    return "/pulls/inbox#pr-tracker";
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
  function parsePullListDocument(doc, origin = "https://github.com") {
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
  function trackerSearchUrl() {
    return "https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A%40me";
  }
  function isSameOriginGitHubUrl(value) {
    try {
      const url = new URL(value, "https://github.com");
      return url.origin === "https://github.com";
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
  color: var(--fgColor-default, inherit);
  font: var(--base-text-body, normal 400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
}
* {
  box-sizing: border-box;
}
.tracker-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
  gap: 16px;
  align-items: start;
}
.panel,
.drawer,
.modal {
  background: var(--bgColor-default, transparent);
  color: var(--fgColor-default, inherit);
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  border-radius: 12px;
  box-shadow: var(--shadow-resting-small, none);
}
.panel {
  overflow: hidden;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
}
.toolbar input[type="search"],
.drawer textarea,
.drawer input[type="text"],
.drawer select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  border-radius: 8px;
  background: var(--bgColor-inset, var(--bgColor-default, transparent));
  color: inherit;
}
.toolbar .spacer {
  flex: 1 1 160px;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.filter-btn,
.action-btn,
.link-btn {
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  background: var(--button-default-bgColor-rest, var(--bgColor-muted, transparent));
  color: var(--button-default-fgColor-rest, inherit);
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
  text-decoration: none;
}
.filter-btn[aria-pressed="true"] {
  border-color: var(--borderColor-accent-emphasis, currentColor);
  outline: 2px solid transparent;
}
.list {
  display: grid;
}
.pr-row,
.pr-row-select {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
  cursor: pointer;
}
.pr-row {
  border-top: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
}
.pr-row:first-child,
.pr-row-select:first-child {
  border-top: 0;
}
.pr-row-select {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: inherit;
}
.pr-row-select[aria-selected="true"] {
  background: var(--bgColor-accent-muted, color-mix(in srgb, currentColor 8%, transparent));
}
.row-main {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.title {
  font-weight: 600;
}
.repo {
  color: var(--fgColor-muted, inherit);
}
.badges,
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.badge,
.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
  font-size: 12px;
}
.drawer {
  position: sticky;
  top: 16px;
  padding: 16px;
  display: grid;
  gap: 12px;
}
.drawer label {
  display: grid;
  gap: 6px;
  font-weight: 600;
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: start;
}
.save-state {
  color: var(--fgColor-muted, inherit);
  min-height: 1.25em;
}
.warning {
  margin: 0 16px 16px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--borderColor-attention-muted, color-mix(in srgb, currentColor 22%, transparent));
  background: var(--bgColor-attention-muted, color-mix(in srgb, currentColor 8%, transparent));
}
.empty {
  padding: 24px 16px;
  color: var(--fgColor-muted, inherit);
}
.tag-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}
.tag-colors {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag-color {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 2px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  cursor: pointer;
}
.tag-color[aria-pressed="true"] {
  outline: 2px solid var(--borderColor-accent-emphasis, currentColor);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
:focus-visible {
  outline: 2px solid var(--focus-outlineColor, var(--borderColor-accent-emphasis, currentColor));
  outline-offset: 2px;
}
@media (max-width: 960px) {
  .tracker-shell {
    grid-template-columns: 1fr;
  }
  .drawer {
    position: fixed;
    inset: auto 12px 12px 12px;
    max-height: min(80vh, 720px);
    overflow: auto;
    z-index: 1000;
    background: var(--overlay-bgColor, var(--bgColor-default, transparent));
  }
}
`;

  // src/ui.js
  function createUi(container, handlers) {
    const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    const root = document.createElement("div");
    root.className = "tracker-root";
    shadow.replaceChildren(style, root);
    const shell = document.createElement("div");
    shell.className = "tracker-shell";
    const panel = document.createElement("section");
    panel.className = "panel";
    const drawer = document.createElement("aside");
    drawer.className = "drawer";
    shell.append(panel, drawer);
    root.append(shell);
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search titles, repos, tags, notes";
    search.setAttribute("aria-label", "Search pull requests");
    search.setAttribute("data-focus-id", "search");
    search.addEventListener("input", (event) => handlers.onSearch(event.target.value));
    const filters = document.createElement("div");
    filters.className = "filters";
    const spacer = document.createElement("div");
    spacer.className = "spacer";
    const showCompleted = makeActionButton(() => handlers.onToggleCompleted());
    const refreshButton = makeActionButton(() => handlers.onRefresh());
    const exportButton = makeActionButton(() => handlers.onExport());
    const importButton = makeActionButton(() => handlers.onImport());
    toolbar.append(search, filters, spacer, showCompleted, refreshButton, exportButton, importButton);
    const warning = document.createElement("div");
    warning.className = "warning";
    const list = document.createElement("div");
    list.className = "list";
    panel.append(toolbar, warning, list);
    const saveState = document.createElement("div");
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
      showCompleted.textContent = state.showCompleted ? "Hide completed" : "Show completed";
      refreshButton.textContent = state.refreshing ? "Refreshing..." : "Refresh";
      refreshButton.disabled = state.refreshing;
      exportButton.textContent = "Export data";
      importButton.textContent = "Import data";
      const options = ["all", ...state.visibleStatuses];
      const existing = new Map([...filters.querySelectorAll("button")].map((button) => [button.dataset.status, button]));
      for (const status of options) {
        let button = existing.get(status);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "filter-btn";
          button.dataset.status = status;
          button.addEventListener("click", () => handlers.onStatusFilter(status));
          filters.append(button);
        }
        button.textContent = status === "all" ? "All" : status.replaceAll("_", " ");
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
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No pull requests match the current filters.";
        list.append(empty);
        return;
      }
      for (const summary of state.filteredSummaries) {
        const record = state.records[summary.key] || DEFAULT_RECORD;
        const row = document.createElement("div");
        row.className = "pr-row";
        row.dataset.prKey = summary.key;
        const rowButton = document.createElement("button");
        rowButton.type = "button";
        rowButton.className = "pr-row-select";
        rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
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
        const main = document.createElement("div");
        main.className = "row-main";
        const left = document.createElement("div");
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = summary.title;
        const repo = document.createElement("div");
        repo.className = "repo";
        repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
        left.append(title, repo);
        const status = document.createElement("div");
        status.className = "badge";
        status.textContent = `My status: ${record.status.replaceAll("_", " ")}`;
        main.append(left, status);
        const badges = document.createElement("div");
        badges.className = "badges";
        badges.append(
          makeBadge("Review", summary.review || "unknown"),
          makeBadge("Checks", summary.checks || "unknown"),
          makeBadge("Merge", summary.merge || "unknown"),
          makeBadge("Draft", summary.draft ? "yes" : "no")
        );
        rowButton.append(main, badges);
        row.append(rowButton);
        if (record.tags.length) {
          const tags = document.createElement("div");
          tags.className = "tags";
          for (const tag of record.tags) {
            const tagButton = makeTagButton(tag, {
              ariaLabel: `Filter by tag ${tag.name}`,
              onClick(event) {
                event.stopPropagation();
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
      const header = document.createElement("div");
      header.className = "drawer-header";
      const titleWrap = document.createElement("div");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = summary?.title || state.selectedKey;
      const subtitle = document.createElement("div");
      subtitle.className = "repo";
      subtitle.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
      titleWrap.append(title, subtitle);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "action-btn";
      close.textContent = "Close";
      close.addEventListener("click", async () => {
        await flushPending(state.selectedKey);
        handlers.onSelect(null);
        if (focusedBeforeDrawer instanceof HTMLElement) {
          focusedBeforeDrawer.focus();
        }
      });
      header.append(titleWrap, close);
      const statusField = document.createElement("label");
      statusField.textContent = "My status";
      const statusSelect = document.createElement("select");
      statusSelect.setAttribute("data-focus-id", "status");
      for (const status of ["unsorted", "next_up", "waiting", "blocked", "done"]) {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = status.replaceAll("_", " ");
        option.selected = record.status === status;
        statusSelect.append(option);
      }
      const blockerField = document.createElement("label");
      blockerField.textContent = "Blocked by";
      const blockerInput = document.createElement("input");
      blockerInput.type = "text";
      blockerInput.value = record.blockedBy;
      blockerInput.hidden = record.status !== "blocked";
      blockerInput.setAttribute("data-focus-id", "blockedBy");
      blockerInput.addEventListener("input", () => queueSave(state.selectedKey, { blockedBy: blockerInput.value }));
      blockerInput.addEventListener("blur", () => {
        void flushPending(state.selectedKey);
      });
      blockerField.append(blockerInput);
      statusSelect.addEventListener("change", () => {
        queueSave(state.selectedKey, { status: statusSelect.value });
        blockerInput.hidden = statusSelect.value !== "blocked";
        if (statusSelect.value === "blocked") {
          blockerInput.focus();
        }
      });
      statusField.append(statusSelect);
      const notesField = document.createElement("label");
      notesField.textContent = "My notes";
      const notesInput = document.createElement("textarea");
      notesInput.rows = 8;
      notesInput.value = record.notes;
      notesInput.setAttribute("data-focus-id", "notes");
      notesInput.addEventListener("input", () => queueSave(state.selectedKey, { notes: notesInput.value }));
      notesInput.addEventListener("blur", () => {
        void flushPending(state.selectedKey);
      });
      notesField.append(notesInput);
      const tagsField = document.createElement("div");
      const tagsLabel = document.createElement("div");
      tagsLabel.textContent = "Private tags";
      const tagForm = document.createElement("form");
      tagForm.className = "tag-form";
      const tagInput = document.createElement("input");
      tagInput.type = "text";
      tagInput.placeholder = "Add tag";
      tagInput.setAttribute("aria-label", "Tag name");
      tagInput.setAttribute("data-focus-id", "tag-name");
      const colorSelect = document.createElement("select");
      colorSelect.setAttribute("aria-label", "Tag color");
      for (const color of TAG_COLORS) {
        const option = document.createElement("option");
        option.value = color;
        option.textContent = color;
        colorSelect.append(option);
      }
      const addTag = document.createElement("button");
      addTag.type = "submit";
      addTag.className = "action-btn";
      addTag.textContent = "Add";
      tagForm.addEventListener("submit", (event) => {
        event.preventDefault();
        handlers.onAddTag(state.selectedKey, tagInput.value, colorSelect.value);
        tagInput.value = "";
      });
      tagForm.append(tagInput, colorSelect, addTag);
      const existingTags = document.createElement("div");
      existingTags.className = "tags";
      for (const tag of record.tags) {
        const pill = makeTagButton(tag, {
          ariaLabel: `Remove tag ${tag.name}`,
          onClick() {
            handlers.onRemoveTag(state.selectedKey, tag.name);
          }
        });
        existingTags.append(pill);
      }
      const link = document.createElement("a");
      link.className = "link-btn";
      link.href = summary?.url || "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open pull request";
      saveState.textContent = state.saveState;
      tagsField.append(tagsLabel, tagForm, existingTags);
      drawer.append(header, saveState, statusField, blockerField, notesField, tagsField, link);
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
      setSaveState("Saving...");
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
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `${label}: ${value.replace?.("_", " ") || value}`;
      return badge;
    }
    function makeTagButton(tag, { onClick, ariaLabel }) {
      const pill = document.createElement("button");
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
    return { render, shadow, flushPending, setSaveState };
    function makeActionButton(onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-btn";
      button.addEventListener("click", onClick);
      return button;
    }
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
      mountedMain = null;
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
          const summaries = await fetchOpenPrs({ fetchImpl, parser });
          const enriched = await mapLimit(summaries, 4, async (summary) => {
            try {
              const cached = detailCache[summary.key];
              const shouldUseCache = !force && cached && now() - cached.updatedAt < DETAIL_CACHE_TTL_MS;
              const detail = shouldUseCache ? cached.detail : await fetchDetail(summary);
              detailCache[summary.key] = { updatedAt: now(), detail };
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
          deferredDetail = parsePrDetailDocument(parser(await response.text()));
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
        visibleStatuses: getVisibleStatusOptions(state.showCompleted),
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
