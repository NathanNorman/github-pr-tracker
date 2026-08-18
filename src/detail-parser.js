import { CHECK_STATES, GITHUB_ORIGIN, MERGE_STATES, REVIEW_STATES } from "./constants.js";
import { extractJiraIssueKeys, normalizeHttpUrl, safeJsonParse, text } from "./utils.js";

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

export function parsePrDetailPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const reviewState = payload.reviewDecision || payload.review_state || payload.currentReviewState;
  const checksState = payload.statusCheckRollup?.state || payload.checks_state || payload.checkState;
  const mergeState = payload.mergeStateStatus || payload.merge_state || payload.mergeState;
  const createdAt = normalizeTimestamp(payload.createdAt || payload.created_at);
  const draft = typeof payload.isDraft === "boolean"
    ? payload.isDraft
    : typeof payload.draft === "boolean"
      ? payload.draft
      : payload.state === "DRAFT"
        ? true
        : payload.state === "OPEN"
          ? false
          : undefined;
  if (!reviewState && !checksState && !mergeState && typeof draft !== "boolean" && !createdAt) {
    return null;
  }
  const detail = {
    review: normalizeReviewState(reviewState || "unknown"),
    checks: normalizeCheckState(checksState || "unknown"),
    merge: normalizeMergeState(mergeState || "unknown"),
    draft: typeof draft === "boolean" ? draft : undefined
  };
  if (createdAt) {
    detail.createdAt = createdAt;
  }
  return detail;
}

function findEmbeddedPayload(doc, baseUrl) {
  const expectedNumber = pullRequestNumber(baseUrl);
  for (const script of doc.querySelectorAll("script")) {
    const text = script.textContent || "";
    const isCurrentEmbeddedData = script.matches('script[type="application/json"][data-target*="embeddedData"]');
    if (
      !isCurrentEmbeddedData &&
      !text.includes("reviewDecision") &&
      !text.includes("statusCheckRollup") &&
      !text.includes("mergeStateStatus")
    ) {
      continue;
    }
    const matches = text.match(/\{[\s\S]*\}/g) || [];
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

function classifyCheckSignal(text) {
  const normalized = String(text || "");
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
    return [heading.className, heading.textContent, meta?.className, meta?.textContent]
      .filter(Boolean)
      .join(" ");
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
      // Only the heading identifies which branch-action-item is actually the
      // checks rollup. Merge-blocked / review-required items can mention the
      // word "checks" in their meta copy (e.g. "Merging can be performed
      // automatically once required checks pass and 1 approving review is
      // given"), which must not be mistaken for the checks section itself.
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
    // As above, scope to the heading only so merge-blocked/review copy that
    // mentions "checks" in its meta text isn't mistaken for the checks item.
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
  const mergeabilityReviewRoot = [...mergeabilityRoot?.querySelectorAll(".branch-action-item") || []]
    .find((item) => /\breview(?:ers?)?\b/i.test(item.querySelector(".status-heading")?.textContent || ""));
  const currentReviewRoot =
    mergeabilityReviewRoot ||
    doc.querySelector('[data-url*="pull_requests%2Fsidebar%2Fshow%2Freviewers"]') ||
    doc.querySelector('form[id^="pull-request-reviewers-form-"]') ||
    doc.querySelector('[data-test-selector="required-review-banner"], [data-review-state]');
  const reviewText = currentReviewRoot
    ? [
        currentReviewRoot.textContent,
        ...[...currentReviewRoot.querySelectorAll("tool-tip, [aria-label]")].map(
          (node) => `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`
        )
      ].join(" ")
    : "";
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

  const draft = /draft/i.test(doc.querySelector('[aria-label="Pull request state"]')?.textContent || "")
    ? true
    : undefined;
  const createdAt = createdAtFromDom(doc);
  const jiraReferences = extractJiraReferences(doc);
  const jiraBaseUrl = jiraBaseUrlFromReferences(jiraReferences);
  return {
    review,
    checks,
    merge,
    draft,
    ...(createdAt ? { createdAt } : {}),
    ...(jiraReferences.length ? { jiraReferences } : {}),
    ...(jiraBaseUrl ? { jiraBaseUrl } : {})
  };
}

export function parsePrDetailDocument(doc, baseUrl = doc?.URL) {
  const embedded = findEmbeddedPayload(doc, baseUrl);
  const dom = detailFromDom(doc);
  return mergeNativeDetails(dom, embedded);
}

export function parseUnresolvedThreadCountDocument(doc) {
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

  const conversationButtons = [...doc.querySelectorAll("button, input[type='submit']")]
    .map((node) => (node.textContent || node.getAttribute("value") || "").trim())
    .filter((label) => /^(?:un)?resolve (?:conversation|thread)$/i.test(label));
  if (conversationButtons.length) {
    return conversationButtons.filter((label) => /^resolve /i.test(label)).length;
  }

  if (
    doc.querySelector(
      ".js-diff-progressive-container, #files, [data-diff-anchor], [data-path][data-tagsearch-path], .js-file"
    )
  ) {
    return 0;
  }

  return undefined;
}

export function findDeferredStatusEndpoint(doc, baseUrl = GITHUB_ORIGIN, expectedHeadSha = "") {
  const base = new URL(baseUrl, GITHUB_ORIGIN);
  const baseOrigin = base.origin;
  const baseMatch = base.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  const expectedOwner = baseMatch?.[1] || "";
  const expectedRepo = baseMatch?.[2] || "";
  const expectedNumber = baseMatch?.[3] || "";
  const currentHeadSha = String(expectedHeadSha || "").trim() ||
    doc.querySelector('input[name="head_sha"]')?.getAttribute("value")?.trim() ||
    "";
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
    const text = script.textContent || "";
    const matches = text.match(
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

  const preferredCurrentOid = currentHeadSha
    ? candidates.find((candidate) => candidate.type === "commit_status_icon" && candidate.oid === currentHeadSha)
    : null;
  if (currentHeadSha) {
    return preferredCurrentOid?.url || null;
  }

  const dedupedCandidates = [];
  const seenUrls = new Set();
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

export function mergeNativeDetails(primary, fallback) {
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
  const unresolvedThreads = Number.isInteger(left.unresolvedThreads)
    ? left.unresolvedThreads
    : Number.isInteger(right.unresolvedThreads)
      ? right.unresolvedThreads
      : undefined;
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
  const seenKeys = new Set();
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
  if (!browseKey || (labelKey && labelKey !== browseKey)) {
    return null;
  }
  return { key: browseKey, url };
}

function extractIssueKeysFromBrowseUrl(url) {
  const match = String(url).match(/\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/gi) || [];
  return match
    .map((entry) => entry.match(/([A-Z][A-Z0-9]+-\d+)/i)?.[1]?.toUpperCase() || "")
    .filter(Boolean);
}

function normalizeReferenceUrl(value, baseUrl = GITHUB_ORIGIN) {
  return normalizeHttpUrl(value, baseUrl);
}

function normalizeJiraReferences(references) {
  const normalized = [];
  const seenKeys = new Set();
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
  if (
    thread.matches('.is-resolved, [data-resolved="true" i], [data-is-resolved="true" i]') ||
    thread.querySelector('.is-resolved, [data-resolved="true" i], [data-is-resolved="true" i]')
  ) {
    return true;
  }
  const controlsText = [...thread.querySelectorAll("button, input[type='submit']")]
    .map((node) => node.textContent || node.getAttribute("value") || "")
    .join(" ");
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
