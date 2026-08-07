import { DETAIL_CACHE_TTL_MS, DETAIL_PARSER_VERSION, DEFAULT_RECORD } from "./constants.js";
import {
  findDeferredStatusEndpoint,
  mergeNativeDetails,
  parsePrDetailDocument,
  parsePrDetailPayload,
  parseUnresolvedThreadCountDocument
} from "./detail-parser.js";
import { fetchHtml, fetchOpenPrs, isTrackerRoute, isSameOriginGitHubUrl, trackerSearchUrl } from "./github.js";
import { closePullRequest, squashMergePullRequest } from "./github-actions.js";
import {
  DEFAULT_FILTER_PREFERENCES,
  filterSummaries,
  getAvailableGroupOptions,
  getAvailableSortOptions,
  groupSummaries,
  normalizeSortPreferencesForSummaries,
  normalizeFilterPreferences,
  normalizeTags,
  sortSummaries
} from "./models.js";
import { styles } from "./styles.js";
import { createUi } from "./ui.js";
import { mapLimit, now } from "./utils.js";

export function createTrackerApp({ doc, win, fetchImpl, parser, storage, login }) {
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
    state.filteredSummaries = computeFiltered();
    unsubscribe = storage.subscribe((nextEnvelope) => {
      state.records = nextEnvelope.records;
      state.filterPreferences = normalizeFilterPreferences(nextEnvelope.filterPreferences);
      state.sortPreferences = normalizeSortPreferencesForSummaries(nextEnvelope.sortPreferences, state.allSummaries);
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
    hiddenElements = [...main.children]
      .filter((node) => node !== host)
      .map((node) => ({ node, hidden: node.hidden }));
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
    const isGlobalChrome = (node) =>
      node.matches('header, footer, [role="banner"], [role="contentinfo"]') ||
      Boolean(node.querySelector('header, [role="banner"], nav[aria-label="Global"]'));
    const semanticSiblings = siblings.filter((node) =>
      !isGlobalChrome(node) && node.matches('aside, [role="complementary"]')
    );
    const geometricSiblings = siblings.filter((node) => {
      if (isGlobalChrome(node)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return (
        mainRect.width > 0 &&
        rect.width >= 200 &&
        rect.width <= 640 &&
        rect.height >= 48 &&
        rect.left >= mainRect.right - 8 &&
        rect.top >= mainRect.top - 8
      );
    });
    const layoutSiblings = semanticSiblings.length
      ? semanticSiblings
      : geometricSiblings;

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
      const detailCache = { ...(snapshot.detailCache || {}) };
      const pendingCacheWrites = new Map();

      try {
        const summaries = await fetchOpenPrs({ fetchImpl, parser, startUrl: trackerSearchUrl(login) });
        const enriched = await mapLimit(summaries, 4, async (summary) => {
          try {
            const cached = detailCache[summary.key];
            const shouldUseCache =
              !force &&
              cached &&
              cached.parserVersion === DETAIL_PARSER_VERSION &&
              isCacheHeadMatch(cached, summary) &&
              now() - cached.updatedAt < DETAIL_CACHE_TTL_MS;
            const fetched = shouldUseCache ? { detail: cached.detail, cacheEntry: null } : await fetchDetail(summary);
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

  async function fetchDetail(summary) {
    const html = await fetchHtml(fetchImpl, summary.url);
    const prDocument = parser(html, summary.url);
    let detail = parsePrDetailDocument(prDocument, summary.url);
    let verifiedHeadAwareChecks = false;
    const shouldFetchCurrentHeadChecks = Boolean(summary.checksUrl);
    const needsDeferred =
      shouldFetchCurrentHeadChecks ||
      detail.review === "unknown" ||
      detail.checks === "unknown" ||
      detail.merge === "unknown";
    if (needsDeferred) {
      const deferredUrl = shouldFetchCurrentHeadChecks
        ? summary.checksUrl
        : findDeferredStatusEndpoint(prDocument, summary.url);
      if (deferredUrl && isSameOriginGitHubUrl(deferredUrl)) {
        try {
          const response = await fetchImpl(deferredUrl, {
            credentials: "include",
            headers: {
              Accept: "application/json,text/html"
            }
          });
          if (response.ok) {
            const contentType = response.headers?.get?.("content-type") || "";
            let deferredDetail = null;
            if (contentType.includes("application/json")) {
              deferredDetail = parsePrDetailPayload(await response.json());
            } else {
              const body = await response.text();
              deferredDetail = parsePrDetailDocument(parser(body, deferredUrl), deferredUrl);
              if (/\/partials\/commit_status_icon(?:\?|$)/.test(deferredUrl) && !body.trim()) {
                deferredDetail = mergeNativeDetails(deferredDetail, { checks: "none" });
              }
            }
            detail = shouldFetchCurrentHeadChecks
              ? mergeDeferredChecks(detail, deferredDetail)
              : mergeNativeDetails(detail, deferredDetail);
            if (shouldFetchCurrentHeadChecks && deferredDetail?.checks && deferredDetail.checks !== "unknown") {
              verifiedHeadAwareChecks = true;
            }
          }
        } catch {
          // Keep the best detail already parsed from the pull request page.
        }
      }
    }

    let unresolvedThreads = parseUnresolvedThreadCountDocument(prDocument);
    if (!Number.isInteger(unresolvedThreads)) {
      const filesUrl = `${summary.url}/files`;
      try {
        const filesHtml = await fetchHtml(fetchImpl, filesUrl);
        unresolvedThreads = parseUnresolvedThreadCountDocument(parser(filesHtml, filesUrl));
      } catch {
        // Thread counts are best-effort and must not hide the rest of a PR.
      }
    }
    const mergedDetail = mergeNativeDetails(detail, { unresolvedThreads });
    return {
      detail: mergedDetail,
      cacheEntry: buildDetailCacheEntry(summary, mergedDetail, verifiedHeadAwareChecks)
    };
  }

  async function removeOpenSummary(key) {
    const latest = await storage.load();
    latest.openListCache = {
      updatedAt: now(),
      items: (latest.openListCache.items || []).filter((summary) => summary.key !== key)
    };
    latest.detailCache = { ...(latest.detailCache || {}) };
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
      onSelect(key) {
        if (state.selectedKey && state.selectedKey !== key) {
          void ui?.flushPending(state.selectedKey);
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
          `Squash and merge ${summary.owner}/${summary.repo}#${summary.number}?\n\nGitHub's default commit title will be kept and the commit message body will be empty.`
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
        state.records[key] = { ...(state.records[key] || DEFAULT_RECORD), ...patch };
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
    ui.render({
      ...state,
      sortPreferences,
      summaryGroups: groupSummaries({
        summaries: state.filteredSummaries,
        records: state.records,
        sortPreferences,
        currentTime: now()
      }),
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

function mergeSummaryDetail(summary, detail) {
  const merged = mergeNativeDetails(detail, summary);
  const result = {
    review: merged.review,
    checks: merged.checks,
    merge: merged.merge,
    draft: typeof merged.draft === "boolean" ? merged.draft : summary.draft
  };
  if (Number.isInteger(merged.unresolvedThreads)) {
    result.unresolvedThreads = merged.unresolvedThreads;
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
    return cached?.headSha === summary.headSha &&
      (!summary.checksUrl || !cached?.checksUrl || cached.checksUrl === summary.checksUrl);
  }
  return true;
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
  const merged = { ...(latestDetailCache || {}) };
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
