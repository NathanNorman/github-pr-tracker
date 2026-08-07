import { DETAIL_CACHE_TTL_MS, DETAIL_PARSER_VERSION, DEFAULT_RECORD } from "./constants.js";
import { findDeferredStatusEndpoint, mergeNativeDetails, parsePrDetailDocument, parsePrDetailPayload } from "./detail-parser.js";
import { fetchHtml, fetchOpenPrs, isTrackerRoute, isSameOriginGitHubUrl, trackerSearchUrl } from "./github.js";
import {
  filterSummaries,
  getAvailableSortOptions,
  normalizeSortPreferencesForSummaries,
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
    sortPreferences: null,
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
    state.sortPreferences = normalizeSortPreferencesForSummaries(envelope.sortPreferences, state.allSummaries);
    state.filteredSummaries = computeFiltered();
    unsubscribe = storage.subscribe((nextEnvelope) => {
      state.records = nextEnvelope.records;
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
      showCompleted: state.showCompleted
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

      try {
        const summaries = await fetchOpenPrs({ fetchImpl, parser, startUrl: trackerSearchUrl(login) });
        const enriched = await mapLimit(summaries, 4, async (summary) => {
          try {
            const cached = detailCache[summary.key];
            const shouldUseCache =
              !force &&
              cached &&
              cached.parserVersion === DETAIL_PARSER_VERSION &&
              now() - cached.updatedAt < DETAIL_CACHE_TTL_MS;
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
    const prDocument = parser(html);
    let detail = parsePrDetailDocument(prDocument);
    const needsDeferred =
      detail.review === "unknown" ||
      detail.checks === "unknown" ||
      detail.merge === "unknown";
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
    ui.render({
      ...state,
      sortPreferences: normalizeSortPreferencesForSummaries(state.sortPreferences, state.allSummaries),
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
  return {
    review: merged.review,
    checks: merged.checks,
    merge: merged.merge,
    draft: typeof merged.draft === "boolean" ? merged.draft : summary.draft
  };
}
