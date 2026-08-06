import { CHECK_STATES, MERGE_STATES, REVIEW_STATES } from "./constants.js";
import { safeJsonParse } from "./utils.js";

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
  const draft = typeof payload.isDraft === "boolean"
    ? payload.isDraft
    : typeof payload.draft === "boolean"
      ? payload.draft
      : payload.state === "DRAFT"
        ? true
        : payload.state === "OPEN"
          ? false
          : undefined;
  if (!reviewState && !checksState && !mergeState && typeof draft !== "boolean") {
    return null;
  }
  return {
    review: normalizeReviewState(reviewState || "unknown"),
    checks: normalizeCheckState(checksState || "unknown"),
    merge: normalizeMergeState(mergeState || "unknown"),
    draft: typeof draft === "boolean" ? draft : undefined
  };
}

function findEmbeddedPayload(doc) {
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
  const currentReviewRoot =
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

  const draft = /draft/i.test(doc.querySelector('[aria-label="Pull request state"]')?.textContent || "")
    ? true
    : undefined;

  return { review, checks, merge, draft };
}

export function parsePrDetailDocument(doc) {
  const embedded = findEmbeddedPayload(doc);
  const dom = detailFromDom(doc);
  return mergeNativeDetails(embedded, dom);
}

export function findDeferredStatusEndpoint(doc, baseUrl = "https://github.com") {
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
      if (
        !value ||
        !/\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)/.test(value)
      ) {
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
    const match = text.match(
      /https:\/\/github\.com\/[^"'\\s]+\/pull\/\d+\/(?:checks|status|merge|review|details|partials\/commit_status_icon)[^"'\\s]*/
    );
    if (match) {
      return match[0];
    }
  }

  return null;
}

export function mergeNativeDetails(primary, fallback) {
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
  const seen = new Set();
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
