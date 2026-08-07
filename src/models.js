import {
  ACTIVE_STATUSES,
  CHECK_STATES,
  DEFAULT_RECORD,
  GITHUB_ORIGIN,
  PERSONAL_STATUSES,
  REVIEW_STATES,
  SCHEMA_VERSION,
  TAG_COLORS
} from "./constants.js";

export const SORT_FIELDS = Object.freeze({
  updated: "updated",
  repository: "repository",
  status: "status",
  title: "title",
  number: "number",
  review: "review",
  checks: "checks"
});

export const SORT_DIRECTIONS = Object.freeze({
  asc: "asc",
  desc: "desc"
});

export const DEFAULT_SORT_PREFERENCES = Object.freeze({
  primary: {
    field: SORT_FIELDS.updated,
    direction: SORT_DIRECTIONS.desc
  },
  secondary: {
    field: SORT_FIELDS.repository,
    direction: SORT_DIRECTIONS.asc
  }
});

export const DEFAULT_FILTER_PREFERENCES = Object.freeze({
  hideDrafts: false,
  repository: "all",
  review: "all",
  checks: "all"
});

const SORT_FIELD_SET = new Set(Object.values(SORT_FIELDS));
const SORT_DIRECTION_SET = new Set(Object.values(SORT_DIRECTIONS));
const PERSONAL_STATUS_ORDER = new Map(PERSONAL_STATUSES.map((status, index) => [status, index]));
const REVIEW_ORDER = new Map(REVIEW_STATES.map((status, index) => [status, index]));
const CHECK_ORDER = new Map(CHECK_STATES.map((status, index) => [status, index]));
const PERSONAL_STATUS_LABELS = new Map([
  ["unsorted", "Unsorted"],
  ["next_up", "Next up"],
  ["waiting", "Waiting"],
  ["blocked", "Blocked"],
  ["done", "Done"]
]);
const REVIEW_LABELS = new Map([
  ["approved", "Approved"],
  ["changes_requested", "Changes requested"],
  ["required", "Review required"],
  ["none", "No review required"],
  ["unknown", "Review unknown"]
]);
const CHECK_LABELS = new Map([
  ["passing", "Checks passing"],
  ["failing", "Checks failing"],
  ["pending", "Checks pending"],
  ["none", "No checks"],
  ["unknown", "Checks unknown"]
]);

export function createPrKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

export function parsePrUrl(input) {
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

export function normalizeTag(rawTag) {
  const name = typeof rawTag?.name === "string" ? rawTag.name.trim() : "";
  if (!name) {
    return null;
  }
  const color = TAG_COLORS.includes(rawTag?.color) ? rawTag.color : "gray";
  return { name, color };
}

export function normalizeTags(rawTags) {
  const deduped = new Map();
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

export function normalizeRecord(rawRecord = {}) {
  const status = PERSONAL_STATUSES.includes(rawRecord.status) ? rawRecord.status : DEFAULT_RECORD.status;
  return {
    status,
    blockedBy: typeof rawRecord.blockedBy === "string" ? rawRecord.blockedBy : "",
    notes: typeof rawRecord.notes === "string" ? rawRecord.notes : "",
    tags: normalizeTags(rawRecord.tags),
    modifiedAt: Number.isFinite(rawRecord.modifiedAt) ? rawRecord.modifiedAt : 0
  };
}

export function normalizeEnvelope(rawEnvelope, login) {
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
    filterPreferences: normalizeFilterPreferences(rawEnvelope?.filterPreferences)
  };
}

export function normalizeOpenListCache(rawCache) {
  const items = Array.isArray(rawCache?.items) ? rawCache.items : [];
  return {
    updatedAt: Number.isFinite(rawCache?.updatedAt) ? rawCache.updatedAt : 0,
    items: items.filter((item) => item && typeof item.key === "string" && typeof item.url === "string")
  };
}

export function normalizeDetailCache(rawCache) {
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

export function mergeImportedRecords(currentRecords, incomingRecords) {
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

export function normalizeSortPreferences(rawPreferences) {
  const primary = normalizeSortLevel(rawPreferences?.primary, DEFAULT_SORT_PREFERENCES.primary);
  const hasSecondaryPreference = Boolean(rawPreferences) && Object.hasOwn(rawPreferences, "secondary");
  const secondary = normalizeSecondarySortLevel(
    hasSecondaryPreference ? rawPreferences.secondary : undefined,
    primary.field,
    { useDefaultWhenMissing: !hasSecondaryPreference }
  );
  return {
    primary,
    secondary
  };
}

export function normalizeFilterPreferences(rawPreferences) {
  const repository = typeof rawPreferences?.repository === "string"
    ? rawPreferences.repository.trim()
    : "";
  return {
    hideDrafts: rawPreferences?.hideDrafts === true,
    repository: repository && repository.toLocaleLowerCase() !== "all"
      ? repository
      : DEFAULT_FILTER_PREFERENCES.repository,
    review: REVIEW_STATES.includes(rawPreferences?.review) ? rawPreferences.review : DEFAULT_FILTER_PREFERENCES.review,
    checks: CHECK_STATES.includes(rawPreferences?.checks) ? rawPreferences.checks : DEFAULT_FILTER_PREFERENCES.checks
  };
}

export function getAvailableSortOptions(summaries) {
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

export function getAvailableGroupOptions(summaries) {
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

export function normalizeSortPreferencesForSummaries(rawPreferences, summaries) {
  const availableFields = new Set(getAvailableSortOptions(summaries).map((option) => option.value));
  const normalized = normalizeSortPreferences(rawPreferences);
  const primaryMatchesRequested = availableFields.has(normalized.primary.field);
  const primary = primaryMatchesRequested
    ? normalized.primary
    : DEFAULT_SORT_PREFERENCES.primary;
  const secondaryMatchesRequested = normalized.secondary
    ? availableFields.has(normalized.secondary.field) && normalized.secondary.field !== primary.field
    : false;
  const secondary = secondaryMatchesRequested
    ? normalized.secondary
    : !primaryMatchesRequested
      ? defaultSecondaryForPrimary(primary.field, availableFields)
      : null;
  return {
    primary,
    secondary
  };
}

export function sortSummaries({ summaries, records, sortPreferences }) {
  const normalizedPreferences = normalizeSortPreferencesForSummaries(sortPreferences, summaries);
  return [...summaries]
    .sort((left, right) => {
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

export function groupSummaries({ summaries, records, sortPreferences, currentTime = Date.now() }) {
  const normalizedPreferences = normalizeSortPreferencesForSummaries(sortPreferences, summaries);
  const groups = [];
  const groupsByKey = new Map();

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

export function validateImportEnvelope(rawEnvelope) {
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

export function filterSummaries({
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
    if (
      normalizedFilters.repository !== "all" &&
      repositoryName(summary).toLocaleLowerCase() !== normalizedFilters.repository.toLocaleLowerCase()
    ) {
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
    ]
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

export function getVisibleStatusOptions(showCompleted) {
  return showCompleted ? [...ACTIVE_STATUSES, "done"] : ACTIVE_STATUSES;
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
  const result = leftText.localeCompare(rightText, undefined, { sensitivity: "base", numeric: true });
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
  const oneDay = 24 * 60 * 60 * 1000;
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
    label: `PRs #${lower.toLocaleString()}–#${upper.toLocaleString()}`
  };
}

function humanize(value) {
  const label = String(value || "Unknown").replaceAll("_", " ");
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}
