import { parsePrUrl } from "./models.js";

export function isTrackerRoute(location) {
  const url = typeof location === "string" ? new URL(location, "https://github.com") : new URL(location.href);
  return url.pathname === "/pulls" && url.searchParams.get("pr_tracker") === "1";
}

export function trackerUrl() {
  return "/pulls?pr_tracker=1";
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

export function parsePullListDocument(doc, origin = "https://github.com") {
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
  const nextHref =
    doc.querySelector('a[rel="next"]')?.getAttribute("href") ||
    [...doc.querySelectorAll("a")].find((anchor) => /^next$/i.test(anchor.textContent.trim()))?.getAttribute("href") ||
    null;
  const nextUrl = nextHref ? new URL(nextHref, origin).href : null;
  return { items, nextHref: nextUrl && isSameOriginGitHubUrl(nextUrl) ? nextUrl : null };
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

export function trackerSearchUrl() {
  return "https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A%40me";
}

export function isSameOriginGitHubUrl(value) {
  try {
    const url = new URL(value, "https://github.com");
    return url.origin === "https://github.com";
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
