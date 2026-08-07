import { GITHUB_ORIGIN } from "./constants.js";
import { parsePrUrl } from "./models.js";

export function isTrackerRoute(location) {
  const url = typeof location === "string" ? new URL(location, GITHUB_ORIGIN) : new URL(location.href);
  const isPullsRoute = url.pathname === "/pulls" || url.pathname === "/pulls/inbox";
  const hasTrackerMarker = url.hash === "#pr-tracker" || url.searchParams.get("pr_tracker") === "1";
  return isPullsRoute && hasTrackerMarker;
}

export function trackerUrl() {
  return "/pulls#pr-tracker";
}

export function detectCurrentLogin(doc = document) {
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

export function ensureTrackerNav(doc = document) {
  if (doc.getElementById("pr-tracker-nav-link")) {
    return;
  }

  const candidates = [...doc.querySelectorAll("nav, [role='navigation'], .UnderlineNav-body, .AppHeader-context-full")];
  const targetLink = candidates
    .flatMap((container) => [...container.querySelectorAll('a[href^="/pulls"], a[href*="/pulls?"]')].map((link) => ({ container, link })))
    .find(({ link }) => !link.closest("#pr-tracker-nav-link"));

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

export function parsePullListDocument(doc, origin = GITHUB_ORIGIN) {
  const grouped = new Map();
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
    const row =
      anchor.closest('[data-issue-and-pr-hovercards-enabled], .js-issue-row, [role="row"], li[id^="issue_"], .Box-row') ||
      anchor.closest("li, article, section");
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
  const nextHref =
    doc.querySelector('a[rel="next"]')?.getAttribute("href") ||
    [...doc.querySelectorAll("a")].find((anchor) => /^next$/i.test(anchor.textContent.trim()))?.getAttribute("href") ||
    null;
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
  const semanticDraft = [...row.querySelectorAll('[aria-label], [title]')].some((node) => {
    const label = [node.getAttribute("aria-label"), node.getAttribute("title")].filter(Boolean).join(" ");
    return node !== titleAnchor && /^\s*(?:open )?draft(?: pull request)?\s*$/i.test(label);
  });
  if (semanticDraft) {
    return true;
  }
  return [...row.querySelectorAll("span, strong, small")].some((node) =>
    node !== titleAnchor &&
    !node.closest("a") &&
    node.children.length === 0 &&
    /^\s*draft\s*$/i.test(node.textContent || "")
  );
}

export async function fetchHtml(fetchImpl, url) {
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

export async function fetchOpenPrs({ fetchImpl, parser, startUrl = trackerSearchUrl() }) {
  const seenUrls = new Set();
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

export function trackerSearchUrl(login = "@me") {
  const url = new URL("/pulls", GITHUB_ORIGIN);
  url.searchParams.set("q", `is:open is:pr archived:false author:${login || "@me"}`);
  return url.href;
}

export function isSameOriginGitHubUrl(value) {
  try {
    const url = new URL(value, GITHUB_ORIGIN);
    return url.origin === GITHUB_ORIGIN;
  } catch {
    return false;
  }
}

function selectTitleAnchor(anchors, parsed) {
  const scored = anchors
    .map((anchor) => ({
      anchor,
      score: scoreAnchor(anchor, parsed)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
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
  // Prefer GitHub's status wrapper over a nested count icon. A successful
  // rollup can say "37 / 81 checks OK" when the other checks were skipped;
  // the wrapper's green state is authoritative in that case.
  const checkRoot = checkRoots
    .filter((node) =>
      node.matches("[data-checks-state]") ||
      (node.matches(".commit-build-statuses") && node.querySelector('summary, [aria-label*="check" i], img[alt*="check" i]'))
    )
    .at(-1) || checkRoots.at(-1);
  const checkNodes = checkRoot
    ? [
        checkRoot,
        ...checkRoot.querySelectorAll(
          'summary, [aria-label*="check" i], img[alt*="check" i], [data-checks-state]'
        )
      ]
    : [];
  const checkText = checkNodes
    .map((node) => [
      node.getAttribute("aria-label"),
      node.getAttribute("alt"),
      node.getAttribute("data-checks-state"),
      node.getAttribute("class"),
      node.textContent
    ].filter(Boolean).join(" "))
    .join(" ");
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
    ...(currentHead.headSha ? { headSha: currentHead.headSha } : {}),
    ...(currentHead.checksUrl ? { checksUrl: currentHead.checksUrl } : {})
  };
}

function parseCurrentHeadStatus(row, parsed) {
  const checksUrl = resolveCurrentHeadStatusUrl(
    row.querySelector(".commit-build-statuses[data-deferred-details-content-url], [data-deferred-details-content-url]")
      ?.getAttribute("data-deferred-details-content-url"),
    parsed
  );
  const urlHeadSha = headShaFromChecksUrl(checksUrl);
  const attributeHeadSha = row
    .querySelector(".commit-build-statuses[data-head-sha], [data-head-sha]")
    ?.getAttribute("data-head-sha")
    ?.trim();
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
