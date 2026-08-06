import {
  ACTIVE_STATUSES,
  DEFAULT_RECORD,
  PERSONAL_STATUSES,
  SCHEMA_VERSION,
  TAG_COLORS
} from "./constants.js";

export function createPrKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

export function parsePrUrl(input) {
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
    detailCache: normalizeDetailCache(rawEnvelope?.detailCache)
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
      detail: value.detail && typeof value.detail === "object" ? value.detail : {}
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

export function filterSummaries({ summaries, records, search, statusFilter, tagFilter, showCompleted }) {
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
    ]
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

export function getVisibleStatusOptions(showCompleted) {
  return showCompleted ? [...ACTIVE_STATUSES, "done"] : ACTIVE_STATUSES;
}
