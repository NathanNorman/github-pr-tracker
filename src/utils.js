export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function debounce(fn, wait) {
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

export async function mapLimit(items, limit, mapper) {
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

export function text(value) {
  return typeof value === "string" ? value : "";
}

const JIRA_ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export function extractJiraIssueKeys(value) {
  const textValue = text(value);
  const matches = textValue.match(JIRA_ISSUE_KEY_PATTERN) || [];
  return [...new Set(matches.map((match) => match.toUpperCase()))];
}

export function calendarDaysSince(value, currentTime = Date.now()) {
  const createdAt = new Date(value);
  const current = new Date(currentTime);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(current.getTime())) {
    return null;
  }
  const createdDay = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate());
  const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  return Math.max(0, Math.round((currentDay.getTime() - createdDay.getTime()) / 86400000));
}

export function normalizeHttpUrl(value, baseUrl = undefined) {
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

export function now() {
  return Date.now();
}
