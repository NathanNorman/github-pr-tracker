import {
  CHECK_STATES,
  DEFAULT_RECORD,
  PERSONAL_STATUSES,
  REVIEW_STATES,
  SAVE_DEBOUNCE_MS,
  TAG_COLOR_TOKENS,
  TAG_COLORS
} from "./constants.js";
import { summarizeLifecyclePhases } from "./pr-lifecycle.js";
import { calendarDaysSince, debounce, normalizeHttpUrl, now } from "./utils.js";

const STATUS_LABELS = {
  unsorted: "Unsorted",
  next_up: "Next up",
  waiting: "Waiting",
  blocked: "Blocked",
  done: "Done"
};

const REVIEW_FILTER_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  required: "Review required",
  none: "No review required",
  unknown: "Review unavailable"
};

const CHECK_FILTER_LABELS = {
  passing: "Passing",
  failing: "Failing",
  pending: "Pending",
  none: "No checks",
  unknown: "Checks unavailable"
};

const REVIEW_ROW_LABELS = {
  approved: "Review approved",
  changes_requested: "Changes requested",
  required: "Review needed",
  none: "No review needed"
};

const CHECK_ROW_LABELS = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
  none: "No checks"
};

export function createUi(container, handlers) {
  const doc = container.ownerDocument;
  const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  const root = doc.createElement("div");
  root.className = "tracker-root";
  shadow.replaceChildren(style, root);

  // Events leaving a shadow root are retargeted to the host element. GitHub's
  // global keyboard shortcuts can therefore mistake typing in our editors for
  // typing on the page and move focus to its search box. Keep editable-control
  // keyboard events inside the tracker while preserving normal behavior in the
  // focused control itself.
  const containEditorKeyboardEvent = (event) => {
    const origin = event.composedPath?.()[0] || event.target;
    if (
      origin instanceof HTMLElement &&
      (origin.matches("input, textarea, select") || origin.closest("[contenteditable='true']"))
    ) {
      event.stopPropagation();
    }
  };
  shadow.addEventListener("keydown", containEditorKeyboardEvent);
  shadow.addEventListener("keypress", containEditorKeyboardEvent);
  shadow.addEventListener("keyup", containEditorKeyboardEvent);

  const pageHeader = doc.createElement("header");
  pageHeader.className = "page-header";
  const heading = doc.createElement("div");
  heading.className = "page-heading";
  const pageTitle = doc.createElement("h1");
  pageTitle.textContent = "My pull requests";
  const pageSubtitle = doc.createElement("div");
  pageSubtitle.className = "page-subtitle";
  const subtitleText = doc.createElement("span");
  subtitleText.textContent = "A private workspace for pull requests you opened";
  const privacy = doc.createElement("span");
  privacy.className = "privacy-note";
  privacy.textContent = container.dataset.trackerVersion && container.dataset.trackerVersion !== "unknown"
    ? `Stored in this browser · v${container.dataset.trackerVersion}`
    : "Stored in this browser";
  pageSubtitle.append(subtitleText, privacy);
  heading.append(pageTitle, pageSubtitle);

  const search = doc.createElement("input");
  search.type = "search";
  search.placeholder = "Search PRs, notes, or private labels";
  search.setAttribute("aria-label", "Search pull requests");
  search.setAttribute("data-focus-id", "search");
  search.addEventListener("input", (event) => handlers.onSearch(event.target.value));
  pageHeader.append(heading, search);

  const shell = doc.createElement("div");
  shell.className = "tracker-shell";
  const sidebar = doc.createElement("nav");
  sidebar.className = "status-sidebar";
  sidebar.setAttribute("aria-label", "Personal status filters");
  const sidebarLabel = doc.createElement("div");
  sidebarLabel.className = "eyebrow";
  sidebarLabel.textContent = "My workflow";
  const filters = doc.createElement("div");
  filters.className = "filters";

  const sidebarTools = doc.createElement("div");
  sidebarTools.className = "sidebar-tools";
  const viewLabel = doc.createElement("div");
  viewLabel.className = "eyebrow";
  viewLabel.textContent = "View";
  const showCompleted = makeActionButton("", () => handlers.onToggleCompleted(), "sidebar-action");
  const exportButton = makeActionButton("Export backup", () => handlers.onExport(), "sidebar-action");
  const importButton = makeActionButton("Import backup", () => handlers.onImport(), "sidebar-action");
  const backupMenu = doc.createElement("details");
  backupMenu.className = "backup-menu";
  const backupSummary = doc.createElement("summary");
  backupSummary.textContent = "Backup & restore";
  const backupActions = doc.createElement("div");
  backupActions.className = "backup-actions";
  backupActions.append(exportButton, importButton);
  backupMenu.append(backupSummary, backupActions);
  sidebarTools.append(viewLabel, showCompleted, backupMenu);
  sidebar.append(sidebarLabel, filters, sidebarTools);

  const panel = doc.createElement("section");
  panel.className = "panel";
  const panelHeader = doc.createElement("div");
  panelHeader.className = "panel-header";
  const resultCount = doc.createElement("strong");
  resultCount.className = "result-count";
  const panelActions = doc.createElement("div");
  panelActions.className = "panel-actions";
  const filterMenu = doc.createElement("details");
  filterMenu.className = "structured-filter-menu";
  const filterSummary = doc.createElement("summary");
  filterSummary.className = "filter-summary";
  filterSummary.textContent = "Filter";
  const filterPopover = doc.createElement("div");
  filterPopover.className = "filter-popover";
  const hideDraftsLabel = doc.createElement("label");
  hideDraftsLabel.className = "filter-checkbox";
  const hideDraftsCheckbox = doc.createElement("input");
  hideDraftsCheckbox.type = "checkbox";
  hideDraftsCheckbox.setAttribute("data-focus-id", "filter-hide-drafts");
  const hideDraftsText = doc.createElement("span");
  hideDraftsText.textContent = "Hide draft PRs";
  hideDraftsLabel.append(hideDraftsCheckbox, hideDraftsText);
  const repositorySelect = makeSelect("filter-repository", "Repository filter");
  const reviewSelect = makeSelect("filter-review", "Review state filter");
  const checksSelect = makeSelect("filter-checks", "Checks state filter");
  const repositoryRow = makeFilterRow("Repository", repositorySelect);
  const reviewRow = makeFilterRow("Review state", reviewSelect);
  const checksRow = makeFilterRow("Checks state", checksSelect);
  const clearFiltersButton = makeActionButton("Clear filters", () => handlers.onClearFilters(), "clear-filters");
  filterPopover.append(hideDraftsLabel, repositoryRow, reviewRow, checksRow, clearFiltersButton);
  filterMenu.append(filterSummary, filterPopover);
  const sortMenu = doc.createElement("details");
  sortMenu.className = "sort-menu";
  const sortSummary = doc.createElement("summary");
  sortSummary.className = "sort-summary";
  sortSummary.textContent = "Sort";
  const sortRows = doc.createElement("div");
  sortRows.className = "sort-rows";
  const primaryFieldSelect = makeSelect("sort-primary-field", "Group field");
  const primaryDirectionSelect = makeSelect("sort-primary-direction", "Group direction");
  const secondaryFieldSelect = makeSelect("sort-secondary-field", "Secondary sort field");
  const secondaryDirectionSelect = makeSelect("sort-secondary-direction", "Secondary sort direction");
  const sortByRow = makeSortRow("Group by", primaryFieldSelect, primaryDirectionSelect);
  const thenByRow = makeSortRow("Then sort", secondaryFieldSelect, secondaryDirectionSelect);
  sortRows.append(sortByRow, thenByRow);
  sortMenu.append(sortSummary, sortRows);
  const refreshButton = makeActionButton("Refresh", () => handlers.onRefresh(), "action-btn");
  panelActions.append(filterMenu, sortMenu, refreshButton);
  panelHeader.append(resultCount, panelActions);

  const warning = doc.createElement("div");
  warning.className = "warning";
  warning.setAttribute("role", "alert");
  const list = doc.createElement("div");
  list.className = "list";
  panel.append(panelHeader, warning, list);

  const drawer = doc.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("aria-label", "Personal pull request details");
  shell.append(sidebar, panel, drawer);
  root.append(pageHeader, shell);

  const saveState = doc.createElement("div");
  saveState.className = "save-state";
  saveState.setAttribute("aria-live", "polite");

  const pendingSaves = new Map();
  let focusedBeforeDrawer = null;
  let currentState = null;
  let currentSelectedKey = null;
  let closePromptKey = null;
  let drawerView = null;
  const disclosureMenus = [backupMenu, filterMenu, sortMenu];

  function dismissDisclosures(path = []) {
    for (const menu of disclosureMenus) {
      if (menu.open && !path.includes(menu)) {
        menu.open = false;
      }
    }
  }

  async function dismissDrawer({ restoreFocus = false } = {}) {
    const key = currentState?.selectedKey;
    if (!key) {
      return;
    }
    try {
      await flushPending(key);
    } catch {
      return;
    }
    handlers.onSelect(null);
    if (restoreFocus && focusedBeforeDrawer instanceof HTMLElement) {
      focusedBeforeDrawer.focus();
    }
  }

  function eventPath(event) {
    return typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  }

  function onDocumentPointerDown(event) {
    const path = eventPath(event);
    dismissDisclosures(path);
    const clickedPrRow = path.some((node) => node instanceof HTMLElement && node.classList.contains("pr-row"));
    if (currentState?.selectedKey && !path.includes(drawer) && !clickedPrRow) {
      void dismissDrawer();
    }
  }

  function onDocumentKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    const openMenus = disclosureMenus.filter((menu) => menu.open);
    if (openMenus.length) {
      for (const menu of openMenus) {
        menu.open = false;
      }
      openMenus.at(-1)?.querySelector("summary")?.focus();
      event.preventDefault();
      return;
    }
    if (currentState?.selectedKey) {
      event.preventDefault();
      void dismissDrawer({ restoreFocus: true });
    }
  }

  doc.addEventListener("pointerdown", onDocumentPointerDown, true);
  doc.addEventListener("keydown", onDocumentKeyDown, true);

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

    const availableCount = state.allSummaries.filter((summary) => {
      const record = state.records[summary.key] || DEFAULT_RECORD;
      return state.showCompleted || record.status !== "done";
    }).length;
    const visibleCount = state.filteredSummaries.length;
    resultCount.textContent = visibleCount === availableCount
      ? formatCount(visibleCount)
      : `${visibleCount} of ${formatCount(availableCount)}`;

    showCompleted.textContent = state.showCompleted ? "Hide done from All" : "Include done in All";
    showCompleted.setAttribute("aria-pressed", String(state.showCompleted));
    refreshButton.textContent = state.refreshing ? "Refreshing…" : "Refresh";
    refreshButton.disabled = state.refreshing;
    renderFilterControls(state);
    renderSortControls(state);

    const counts = countStatuses(state);
    const options = ["all", ...PERSONAL_STATUSES];
    const existing = new Map([...filters.querySelectorAll("button")].map((button) => [button.dataset.status, button]));
    for (const status of options) {
      let button = existing.get(status);
      if (!button) {
        button = doc.createElement("button");
        button.type = "button";
        button.className = "filter-btn";
        button.dataset.status = status;
        button.addEventListener("click", () => handlers.onStatusFilter(status));
        const label = doc.createElement("span");
        label.className = "filter-label";
        const count = doc.createElement("span");
        count.className = "filter-count";
        button.append(label, count);
        filters.append(button);
      }
      button.querySelector(".filter-label").textContent = status === "all"
        ? state.showCompleted ? "All" : "All active"
        : STATUS_LABELS[status];
      button.querySelector(".filter-count").textContent = String(
        status === "all" ? state.showCompleted ? state.allSummaries.length : counts.active : counts[status]
      );
      button.setAttribute("aria-pressed", String(state.statusFilter === status));
      existing.delete(status);
    }
    for (const stale of existing.values()) {
      stale.remove();
    }
  }

  function renderFilterControls(state) {
    const preferences = state.filterPreferences;
    const repositoryOptions = repositoryFilterOptions(state.allSummaries, preferences.repository);
    syncSelectOptions(repositorySelect, repositoryOptions);
    syncSelectOptions(reviewSelect, [
      { value: "all", label: "All review states" },
      ...REVIEW_STATES.map((value) => ({ value, label: REVIEW_FILTER_LABELS[value] }))
    ]);
    syncSelectOptions(checksSelect, [
      { value: "all", label: "All checks states" },
      ...CHECK_STATES.map((value) => ({ value, label: CHECK_FILTER_LABELS[value] }))
    ]);

    hideDraftsCheckbox.checked = preferences.hideDrafts;
    repositorySelect.value = repositoryOptions.find(
      (option) => option.value.toLocaleLowerCase() === preferences.repository.toLocaleLowerCase()
    )?.value || preferences.repository;
    reviewSelect.value = preferences.review;
    checksSelect.value = preferences.checks;
    const activeCount = countStructuredFilters(preferences);
    filterSummary.textContent = activeCount ? `Filter · ${activeCount}` : "Filter";
    clearFiltersButton.disabled = activeCount === 0;
  }

  function renderSortControls(state) {
    syncSelectOptions(primaryFieldSelect, state.groupOptions);
    syncSelectOptions(secondaryFieldSelect, [{ value: "none", label: "None" }, ...state.sortOptions]);
    syncSelectOptions(primaryDirectionSelect, directionOptionsForField(state.sortPreferences.primary.field));
    syncSelectOptions(
      secondaryDirectionSelect,
      state.sortPreferences.secondary ? directionOptionsForField(state.sortPreferences.secondary.field) : directionOptionsForField(state.sortPreferences.primary.field)
    );

    primaryFieldSelect.value = state.sortPreferences.primary.field;
    primaryDirectionSelect.value = state.sortPreferences.primary.direction;
    secondaryFieldSelect.value = state.sortPreferences.secondary?.field || "none";
    for (const option of secondaryFieldSelect.options) {
      option.disabled = option.value === state.sortPreferences.primary.field;
    }
    secondaryDirectionSelect.disabled = !state.sortPreferences.secondary;
    secondaryDirectionSelect.value = state.sortPreferences.secondary?.direction || "asc";

    sortSummary.textContent = summarizeSort(state.sortPreferences, state.groupOptions, state.sortOptions);
  }

  function updateWarning(message) {
    warning.hidden = !message;
    warning.textContent = message || "";
  }

  function renderList(state) {
    list.textContent = "";
    if (!state.filteredSummaries.length) {
      const empty = doc.createElement("div");
      empty.className = "empty";
      const emptyTitle = doc.createElement("strong");
      const emptyText = doc.createElement("span");
      if (state.refreshing && !state.allSummaries.length) {
        emptyTitle.textContent = "Loading your pull requests…";
        emptyText.textContent = "Fetching open pull requests authored by you.";
      } else if (!state.allSummaries.length) {
        emptyTitle.textContent = "No open pull requests found";
        emptyText.textContent = "Refresh to check GitHub again.";
      } else {
        emptyTitle.textContent = "Nothing matches this view";
        emptyText.textContent = "Try another status, clear filters, or clear your search.";
      }
      empty.append(emptyTitle, emptyText);
      list.append(empty);
      return;
    }

    let renderedRowIndex = 0;
    for (const group of state.summaryGroups) {
      const groupSection = doc.createElement("section");
      groupSection.className = "pr-group";
      groupSection.dataset.groupKey = group.key;

      const groupHeader = doc.createElement("header");
      groupHeader.className = "pr-group-header";
      const groupTitle = doc.createElement("h2");
      groupTitle.className = "pr-group-title";
      groupTitle.textContent = group.label;
      const groupCount = doc.createElement("span");
      groupCount.className = "pr-group-count";
      groupCount.textContent = String(group.summaries.length);
      groupCount.setAttribute("aria-label", formatCount(group.summaries.length));
      groupHeader.append(groupTitle, groupCount);
      groupSection.append(groupHeader);

      for (const summary of group.summaries) {
      const record = state.records[summary.key] || DEFAULT_RECORD;
      const row = doc.createElement("div");
      row.className = "pr-row";
      row.dataset.prKey = summary.key;
      row.dataset.checksState = summary.checks || "unknown";
      if (summary.headSha) {
        row.dataset.headSha = summary.headSha;
      }

      const rowButton = doc.createElement("button");
      rowButton.type = "button";
      rowButton.className = "pr-row-select";
      rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
      rowButton.setAttribute("aria-label", `Edit personal tracking for ${summary.title}`);
      rowButton.addEventListener("click", () => {
        focusedBeforeDrawer = shadow.activeElement;
        handlers.onSelect(currentState?.selectedKey === summary.key ? null : summary.key);
      });
      rowButton.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focusedBeforeDrawer = shadow.activeElement;
          handlers.onSelect(currentState?.selectedKey === summary.key ? null : summary.key);
        }
      });

      const rowIcon = doc.createElement("span");
      rowIcon.className = "pr-icon";
      rowIcon.setAttribute("aria-hidden", "true");
      const rowCopy = doc.createElement("span");
      rowCopy.className = "row-copy";
      const headerLine = doc.createElement("span");
      headerLine.className = "row-header";
      const repo = doc.createElement("span");
      repo.className = "repo";
      repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
      headerLine.append(repo);
      const ageBadge = makeAgeBadge(summary.createdAt, state.currentTime);
      if (ageBadge) {
        headerLine.append(ageBadge);
      }
      const title = doc.createElement("span");
      title.className = "title";
      title.textContent = summary.title;
      const details = doc.createElement("span");
      details.className = "row-details";
      details.id = `pr-row-details-${renderedRowIndex}`;
      renderedRowIndex += 1;
      rowButton.setAttribute("aria-describedby", details.id);

      const metadata = doc.createElement("span");
      metadata.className = "row-metadata";
      if (summary.updatedAt) {
        const updated = doc.createElement("span");
        updated.textContent = `Updated ${formatRelativeTime(summary.updatedAt)}`;
        metadata.append(updated);
      }
      appendKnownBadge(metadata, "Merge", summary.merge, "merge");
      if (Number.isInteger(summary.unresolvedThreads)) {
        const threads = doc.createElement("span");
        threads.className = "thread-count";
        threads.textContent = `${summary.unresolvedThreads} unresolved ${summary.unresolvedThreads === 1 ? "thread" : "threads"}`;
        metadata.append(threads);
      }
      if (summary.draft) {
        const draftBadge = makeBadge("Draft", "draft");
        draftBadge.textContent = "Draft";
        metadata.append(draftBadge);
      }
      if (metadata.childElementCount) {
        details.append(metadata);
      }

      const jiraLinks = renderJiraLinks(summary.jiraReferences);
      if (jiraLinks) {
        details.append(jiraLinks);
      }

      const statusLines = doc.createElement("span");
      statusLines.className = "row-status-lines";
      appendNativeStatus(statusLines, "review", summary.review, REVIEW_ROW_LABELS);
      appendNativeStatus(statusLines, "checks", summary.checks, CHECK_ROW_LABELS);
      if (statusLines.childElementCount) {
        details.append(statusLines);
      }
      if (record.status === "blocked" && record.blockedBy) {
        const blocker = doc.createElement("span");
        blocker.className = "blocker-preview";
        blocker.textContent = `Blocked by ${record.blockedBy}`;
        rowCopy.append(headerLine, title, details, blocker);
      } else {
        rowCopy.append(headerLine, title, details);
      }

      if (record.notes) {
        const notePreview = doc.createElement("span");
        notePreview.className = "note-preview";
        notePreview.textContent = compactNote(record.notes);
        rowCopy.append(notePreview);
      } else if (!record.tags.length && !(record.status === "blocked" && record.blockedBy)) {
        const personalHint = doc.createElement("span");
        personalHint.className = "personal-hint";
        personalHint.textContent = "Add notes, private labels, or blocker details";
        rowCopy.append(personalHint);
      }
      rowButton.append(rowIcon, rowCopy);

      const quickStatus = doc.createElement("label");
      quickStatus.className = "quick-status";
      quickStatus.dataset.status = record.status;
      const quickLabel = doc.createElement("span");
      quickLabel.className = "sr-only";
      quickLabel.textContent = `Personal status for ${summary.title}`;
      const statusSelect = makeStatusSelect(record.status);
      statusSelect.className = "status-select";
      statusSelect.addEventListener("change", () => handlers.onQuickStatus(summary.key, statusSelect.value));
      quickStatus.append(quickLabel, statusSelect);

      const rowControls = doc.createElement("div");
      rowControls.className = "row-controls";
      const actionPending = Boolean(state.prAction?.pending);
      const rowMergePending =
        actionPending && state.prAction.key === summary.key && state.prAction.type === "merge";
      if (summary.merge === "clean" && !summary.draft) {
        const rowMergeButton = makeActionButton(
          rowMergePending ? "Merging…" : "Merge",
          () => void handlers.onMerge(summary.key),
          "action-btn merge-action row-merge-action"
        );
        rowMergeButton.disabled = actionPending;
        rowMergeButton.title = "Squash merge with an empty commit message";
        rowMergeButton.setAttribute(
          "aria-label",
          `Squash and merge ${summary.owner}/${summary.repo} #${summary.number} with an empty commit message`
        );
        rowControls.append(rowMergeButton);
      }
      const openLink = doc.createElement("a");
      openLink.className = "row-open-link";
      openLink.href = summary.url;
      openLink.target = "_blank";
      openLink.rel = "noreferrer";
      openLink.textContent = "Open ↗";
      openLink.setAttribute("aria-label", `Open ${summary.title} on GitHub`);
      rowControls.append(openLink, quickStatus);

      row.append(rowButton, rowControls);

      if (record.tags.length) {
        const tags = doc.createElement("div");
        tags.className = "tags row-tags";
        for (const tag of record.tags) {
          const tagButton = makeTagButton(tag, {
            ariaLabel: `Filter by tag ${tag.name}`,
            onClick() {
              handlers.onTagFilter(tag.name);
            }
          });
          tags.append(tagButton);
        }
        row.append(tags);
      }

        groupSection.append(row);
      }
      list.append(groupSection);
    }
  }

  function renderDrawer(state) {
    shell.classList.toggle("has-drawer", Boolean(state.selectedKey));
    drawer.hidden = !state.selectedKey;
    if (!state.selectedKey) {
      void flushPending(currentSelectedKey).catch(() => {});
      currentSelectedKey = null;
      closePromptKey = null;
      drawerView = null;
      drawer.textContent = "";
      updateSaveState();
      return;
    }

    if (closePromptKey && closePromptKey !== state.selectedKey) {
      closePromptKey = null;
    }

    const summary =
      state.allSummaries.find((item) => item.key === state.selectedKey) ||
      state.filteredSummaries.find((item) => item.key === state.selectedKey);
    const record = getDrawerRecord(state.selectedKey, state.records[state.selectedKey] || DEFAULT_RECORD);
    currentSelectedKey = state.selectedKey;
    if (!drawerView || drawerView.key !== state.selectedKey) {
      drawerView = createDrawerView(state.selectedKey);
      drawer.replaceChildren(...drawerView.nodes);
    }

    const actionPending = Boolean(state.prAction?.pending);
    const selectedActionPending = actionPending && state.prAction.key === state.selectedKey;
    const canMerge = summary?.merge === "clean" && !summary?.draft;

    drawerView.identityTitle.textContent = summary?.title || state.selectedKey;
    drawerView.identityRepo.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
    drawerView.link.href = summary?.url || "#";
    syncDrawerJiraLinks(drawerView, summary?.jiraReferences);
    renderLifecycle(drawerView, summary?.lifecycle);

    drawerView.mergeButton.textContent = selectedActionPending && state.prAction.type === "merge" ? "Merging…" : "Squash & merge";
    drawerView.mergeButton.disabled = actionPending;
    if (canMerge) {
      if (!drawerView.mergeButton.isConnected) {
        drawerView.prActionButtons.prepend(drawerView.mergeButton);
      }
    } else {
      drawerView.mergeButton.remove();
    }
    drawerView.closePrButton.textContent = selectedActionPending && state.prAction.type === "close" ? "Closing…" : "Close PR";
    drawerView.closePrButton.disabled = actionPending;

    if (closePromptKey === state.selectedKey) {
      if (!drawerView.closePrompt.isConnected) {
        drawerView.prActions.insertBefore(drawerView.closePrompt, drawerView.actionError);
      }
      syncInputValue(drawerView.closeCommentInput, drawerView.closeComment);
    } else {
      drawerView.closePrompt.remove();
    }
    drawerView.cancelClose.disabled = actionPending;
    drawerView.confirmClose.textContent =
      selectedActionPending && state.prAction.type === "close" ? "Closing…" : "Close pull request";
    drawerView.confirmClose.disabled = actionPending;

    const actionError = state.prAction?.key === state.selectedKey ? state.prAction.error : "";
    drawerView.actionError.hidden = !actionError;
    drawerView.actionError.textContent = actionError || "";
    syncSelectValue(drawerView.statusSelect, record.status);
    drawerView.blockerField.hidden = record.status !== "blocked";
    syncInputValue(drawerView.blockerInput, record.blockedBy);
    drawerView.existingTags.textContent = "";
    for (const tag of record.tags) {
      const pill = makeTagButton(tag, {
        ariaLabel: `Remove tag ${tag.name}`,
        onClick() {
          handlers.onRemoveTag(state.selectedKey, tag.name);
        }
      });
      pill.title = "Remove private tag";
      drawerView.existingTags.append(pill);
    }
    syncInputValue(drawerView.notesInput, record.notes);
    updateSaveState();
  }

  function createDrawerView(selectedKey) {
    const view = { key: selectedKey };
    const header = doc.createElement("div");
    header.className = "drawer-header";
    const headerText = doc.createElement("div");
    const drawerTitle = doc.createElement("h2");
    drawerTitle.textContent = "Notes & tracking";
    const drawerSubtitle = doc.createElement("div");
    drawerSubtitle.className = "drawer-subtitle";
    drawerSubtitle.textContent = "Private to this browser";
    headerText.append(drawerTitle, drawerSubtitle);

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "icon-btn";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close personal tracking panel");
    close.addEventListener("click", () => void dismissDrawer({ restoreFocus: true }));
    header.append(headerText, close);

    const identity = doc.createElement("div");
    identity.className = "drawer-identity";
    const identityTitle = doc.createElement("div");
    identityTitle.className = "title";
    const identityRepo = doc.createElement("div");
    identityRepo.className = "repo";
    const identityJira = doc.createElement("div");
    identityJira.className = "identity-jira";
    identity.append(identityTitle, identityRepo, identityJira);

    const lifecycle = doc.createElement("section");
    lifecycle.className = "field lifecycle";
    const lifecycleLabel = doc.createElement("div");
    lifecycleLabel.className = "field-label";
    lifecycleLabel.textContent = "Lifecycle";
    const lifecycleList = doc.createElement("div");
    lifecycleList.className = "lifecycle-list";
    lifecycle.append(lifecycleLabel, lifecycleList);

    const prActions = doc.createElement("section");
    prActions.className = "pr-actions";
    const prActionsLabel = doc.createElement("div");
    prActionsLabel.className = "field-label";
    prActionsLabel.textContent = "GitHub actions";
    const prActionButtons = doc.createElement("div");
    prActionButtons.className = "pr-action-buttons";
    const mergeButton = makeActionButton("Squash & merge", () => void handlers.onMerge(selectedKey), "action-btn merge-action");
    const closePrButton = makeActionButton("Close PR", () => {
      if (currentState?.selectedKey !== selectedKey) {
        return;
      }
      closePromptKey = selectedKey;
      view.closeComment = "";
      renderDrawer(currentState);
      view.closeCommentInput?.focus();
    }, "action-btn close-action");
    prActionButtons.append(mergeButton, closePrButton);
    prActions.append(prActionsLabel, prActionButtons);

    const closePrompt = doc.createElement("div");
    closePrompt.className = "close-prompt";
    const closePromptLabel = doc.createElement("label");
    closePromptLabel.className = "field-label";
    closePromptLabel.textContent = "Optional closing comment";
    const closeCommentInput = doc.createElement("textarea");
    closeCommentInput.className = "close-comment";
    closeCommentInput.rows = 3;
    closeCommentInput.placeholder = "Add context before closing…";
    closeCommentInput.addEventListener("input", () => {
      if (currentState?.selectedKey === selectedKey) {
        view.closeComment = closeCommentInput.value;
      }
    });
    closePromptLabel.append(closeCommentInput);
    const closePromptButtons = doc.createElement("div");
    closePromptButtons.className = "close-prompt-buttons";
    const cancelClose = makeActionButton("Cancel", () => {
      if (currentState?.selectedKey !== selectedKey) {
        return;
      }
      closePromptKey = null;
      view.closeComment = "";
      renderDrawer(currentState);
    }, "action-btn");
    const confirmClose = makeActionButton(
      "Close pull request",
      () => {
        if (currentState?.selectedKey === selectedKey) {
          void handlers.onClosePullRequest(selectedKey, view.closeComment);
        }
      },
      "action-btn close-confirm"
    );
    closePromptButtons.append(cancelClose, confirmClose);
    closePrompt.append(closePromptLabel, closePromptButtons);
    prActions.append(closePrompt);

    const actionError = doc.createElement("div");
    actionError.className = "pr-action-error";
    actionError.setAttribute("role", "alert");
    prActions.append(actionError);

    const statusField = makeField("My status");
    const statusSelect = makeStatusSelect(DEFAULT_RECORD.status);
    statusSelect.setAttribute("data-focus-id", "status");
    statusSelect.addEventListener("change", () => {
      queueSave(selectedKey, { status: statusSelect.value });
      blockerField.hidden = statusSelect.value !== "blocked";
      if (statusSelect.value === "blocked") {
        view.blockerInput.focus();
      }
    });
    statusField.append(statusSelect);

    const blockerField = makeField("Blocked by");
    const blockerInput = doc.createElement("input");
    blockerInput.type = "text";
    blockerInput.placeholder = "Person, team, decision, or dependency";
    blockerInput.setAttribute("data-focus-id", "blockedBy");
    blockerInput.addEventListener("input", () => queueSave(selectedKey, { blockedBy: blockerInput.value }));
    blockerInput.addEventListener("blur", () => void flushPending(selectedKey).catch(() => {}));
    blockerField.append(blockerInput);

    const tagsField = doc.createElement("div");
    tagsField.className = "field";
    const tagsLabel = doc.createElement("div");
    tagsLabel.className = "field-label";
    tagsLabel.textContent = "Private labels";
    const tagForm = doc.createElement("form");
    tagForm.className = "tag-form";
    const tagInput = doc.createElement("input");
    tagInput.type = "text";
    tagInput.placeholder = "Add a label";
    tagInput.setAttribute("aria-label", "Private label name");
    tagInput.setAttribute("data-focus-id", "tag-name");
    const colorSelect = doc.createElement("select");
    colorSelect.setAttribute("aria-label", "Tag color");
    for (const color of TAG_COLORS) {
      const option = doc.createElement("option");
      option.value = color;
      option.textContent = color;
      colorSelect.append(option);
    }
    tagForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.onAddTag(selectedKey, tagInput.value, colorSelect.value);
      tagInput.value = "";
    });
    tagForm.append(
      tagInput,
      colorSelect,
      Object.assign(makeActionButton("Add", null, "action-btn"), { type: "submit" })
    );
    const existingTags = doc.createElement("div");
    existingTags.className = "tags";
    tagsField.append(tagsLabel, tagForm, existingTags);

    const notesField = makeField("My notes");
    const notesInput = doc.createElement("textarea");
    notesInput.rows = 7;
    notesInput.placeholder = "Context, next steps, reminders…";
    notesInput.setAttribute("data-focus-id", "notes");
    notesInput.addEventListener("input", () => queueSave(selectedKey, { notes: notesInput.value }));
    notesInput.addEventListener("blur", () => void flushPending(selectedKey).catch(() => {}));
    notesField.append(notesInput);

    const footer = doc.createElement("div");
    footer.className = "drawer-footer";
    const link = doc.createElement("a");
    link.className = "link-btn";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open on GitHub ↗";
    footer.append(saveState, link);

    Object.assign(view, {
      key: selectedKey,
      closeComment: "",
      nodes: [header, identity, lifecycle, prActions, statusField, blockerField, tagsField, notesField, footer],
      identityTitle,
      identityRepo,
      identityJira,
      lifecycleList,
      prActions,
      prActionButtons,
      mergeButton,
      closePrButton,
      closePrompt,
      closeCommentInput,
      cancelClose,
      confirmClose,
      actionError,
      statusSelect,
      blockerField,
      blockerInput,
      tagInput,
      colorSelect,
      notesInput,
      existingTags,
      link
    });
    return view;
  }

  function getDrawerRecord(key, record) {
    const draft = pendingSaves.get(key)?.draft;
    return draft ? { ...record, ...draft } : record;
  }

  function syncInputValue(input, value) {
    if (input.value !== value) {
      input.value = value;
    }
  }

  function syncSelectValue(select, value) {
    if (select.value !== value) {
      select.value = value;
    }
  }

  function hasOwnValues(object) {
    return Object.keys(object).length > 0;
  }

  function reconcileDraftAfterSave(entry, patch) {
    for (const [field, value] of Object.entries(patch)) {
      if (Object.is(entry.draft[field], value)) {
        delete entry.draft[field];
      }
    }
  }

  function pruneSaveEntry(key, entry) {
    if (
      entry.workerPromise ||
      entry.inFlight ||
      entry.debouncePending ||
      hasOwnValues(entry.patch) ||
      hasOwnValues(entry.draft) ||
      entry.lastError
    ) {
      return;
    }
    pendingSaves.delete(key);
  }

  function updateSaveState() {
    const selectedKey = currentState?.selectedKey;
    const entry = selectedKey ? pendingSaves.get(selectedKey) : null;
    if (entry?.lastError) {
      saveState.textContent = `Error: ${entry.lastError.message}`;
      return;
    }
    if (entry && (entry.inFlight || entry.debouncePending || hasOwnValues(entry.patch))) {
      saveState.textContent = "Saving…";
      return;
    }
    saveState.textContent = "Saved";
  }

  function makeStatusSelect(selectedStatus) {
    const select = doc.createElement("select");
    for (const status of PERSONAL_STATUSES) {
      const option = doc.createElement("option");
      option.value = status;
      option.textContent = STATUS_LABELS[status];
      option.selected = selectedStatus === status;
      select.append(option);
    }
    return select;
  }

  function makeSortRow(labelText, fieldSelect, directionSelect) {
    const row = doc.createElement("label");
    row.className = "sort-row";
    const label = doc.createElement("span");
    label.className = "sort-row-label";
    label.textContent = labelText;
    row.append(label, fieldSelect, directionSelect);
    return row;
  }

  function makeFilterRow(labelText, select) {
    const row = doc.createElement("label");
    row.className = "structured-filter-row";
    const label = doc.createElement("span");
    label.className = "filter-row-label";
    label.textContent = labelText;
    row.append(label, select);
    return row;
  }

  function makeField(labelText) {
    const field = doc.createElement("label");
    field.className = "field";
    const label = doc.createElement("span");
    label.className = "field-label";
    label.textContent = labelText;
    field.append(label);
    return field;
  }

  function queueSave(key, patch) {
    if (!key) {
      return;
    }
    const entry = ensureSaveEntry(key);
    entry.patch = { ...entry.patch, ...patch };
    entry.draft = { ...entry.draft, ...patch };
    entry.lastError = null;
    entry.debouncePending = true;
    handlers.onLocalPatch?.(key, patch);
    entry.debounced();
    updateSaveState();
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
    entry.debouncePending = false;
    entry.debounced.flush();
    const worker = ensureSaveWorker(key);
    if (worker) {
      await worker;
    }
    if (entry.lastError) {
      throw entry.lastError;
    }
    pruneSaveEntry(key, entry);
    updateSaveState();
  }

  function ensureSaveEntry(key) {
    let entry = pendingSaves.get(key);
    if (entry) {
      return entry;
    }
    entry = {
      patch: {},
      draft: {},
      workerPromise: null,
      inFlight: false,
      debouncePending: false,
      lastError: null,
      debounced: null
    };
    entry.debounced = debounce(() => {
      entry.debouncePending = false;
      updateSaveState();
      void ensureSaveWorker(key).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    pendingSaves.set(key, entry);
    return entry;
  }

  function ensureSaveWorker(key) {
    const entry = pendingSaves.get(key);
    if (!entry) {
      return Promise.resolve();
    }
    if (entry.workerPromise) {
      return entry.workerPromise;
    }
    entry.workerPromise = (async () => {
      while (hasOwnValues(entry.patch)) {
        const patchToSave = { ...entry.patch };
        entry.patch = {};
        entry.inFlight = true;
        entry.lastError = null;
        updateSaveState();
        try {
          await handlers.onEdit(key, patchToSave, now());
          reconcileDraftAfterSave(entry, patchToSave);
        } catch (error) {
          entry.patch = { ...patchToSave, ...entry.patch };
          entry.lastError = error;
          throw error;
        } finally {
          entry.inFlight = false;
          updateSaveState();
        }
      }
    })().finally(() => {
      entry.workerPromise = null;
      pruneSaveEntry(key, entry);
      updateSaveState();
    });
    return entry.workerPromise;
  }

  function setSaveState() {
    updateSaveState();
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

  function makeBadge(label, value, kind = label.toLowerCase()) {
    const badge = doc.createElement("span");
    badge.className = "badge";
    badge.dataset.state = value;
    badge.dataset.kind = kind;
    badge.textContent = `${label}: ${String(value).replaceAll("_", " ")}`;
    return badge;
  }

  function makeAgeBadge(createdAt, currentTime) {
    const days = calendarDaysSince(createdAt, currentTime);
    if (!Number.isInteger(days)) {
      return null;
    }
    const badge = makeBadge("Age", `${days}d`, "age");
    badge.classList.add("age-badge");
    badge.setAttribute("aria-label", `${days} ${days === 1 ? "day" : "days"} old`);
    return badge;
  }

  function appendKnownBadge(target, label, value, kind = label.toLowerCase()) {
    if (value && value !== "unknown") {
      target.append(makeBadge(label, value, kind));
    }
  }

  function appendNativeStatus(target, kind, value, labels) {
    if (value && value !== "unknown") {
      const badge = makeBadge(kind, value, kind);
      badge.classList.add("native-status-line");
      badge.textContent = labels[value] || `${kind}: ${String(value).replaceAll("_", " ")}`;
      target.append(badge);
    }
  }

  function makeTagButton(tag, { onClick, ariaLabel }) {
    const pill = doc.createElement("button");
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

  function renderJiraLinks(references) {
    const validReferences = Array.isArray(references)
      ? references
        .map((reference) => {
          const key = typeof reference?.key === "string" ? reference.key : "";
          const url = normalizeHttpUrl(reference?.url);
          return key && url ? { key, url } : null;
        })
        .filter(Boolean)
      : [];
    if (!validReferences.length) {
      return null;
    }
    const links = doc.createElement("span");
    links.className = "jira-links";
    for (const reference of validReferences) {
      const link = doc.createElement("a");
      link.className = "jira-link";
      link.href = reference.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = reference.key;
      link.setAttribute("aria-label", `Open Jira issue ${reference.key}`);
      links.append(link);
    }
    return links;
  }

  function syncDrawerJiraLinks(view, references) {
    view.identityJira.textContent = "";
    const links = renderJiraLinks(references);
    if (links) {
      view.identityJira.append(links);
      view.identityJira.hidden = false;
      return;
    }
    view.identityJira.hidden = true;
  }

  function makeActionButton(label, onClick, className) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    if (onClick) {
      button.addEventListener("click", onClick);
    }
    return button;
  }

  function makeSelect(focusId, ariaLabel) {
    const select = doc.createElement("select");
    select.setAttribute("data-focus-id", focusId);
    select.setAttribute("aria-label", ariaLabel);
    return select;
  }

  function syncSelectOptions(select, options) {
    const signature = options.map((option) => `${option.value}:${option.label}`).join("|");
    if (select.dataset.optionsSignature === signature) {
      return;
    }
    select.dataset.optionsSignature = signature;
    select.replaceChildren(
      ...options.map((option) => {
        const element = doc.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        return element;
      })
    );
  }

  function directionOptionsForField(field) {
    if (field === "updated") {
      return [
        { value: "desc", label: "Newest first" },
        { value: "asc", label: "Oldest first" }
      ];
    }
    if (field === "number") {
      return [
        { value: "desc", label: "Highest first" },
        { value: "asc", label: "Lowest first" }
      ];
    }
    if (field === "repository" || field === "title") {
      return [
        { value: "asc", label: "A to Z" },
        { value: "desc", label: "Z to A" }
      ];
    }
    return [
      { value: "asc", label: "Workflow order" },
      { value: "desc", label: "Reverse order" }
    ];
  }

  function emitSortChange() {
    const next = {
      primary: {
        field: primaryFieldSelect.value,
        direction: primaryDirectionSelect.value
      },
      secondary: secondaryFieldSelect.value === "none"
        ? null
        : {
            field: secondaryFieldSelect.value,
            direction: secondaryDirectionSelect.value
          }
    };
    void handlers.onSortChange?.(next);
  }

  primaryFieldSelect.addEventListener("change", () => {
    syncSelectOptions(primaryDirectionSelect, directionOptionsForField(primaryFieldSelect.value));
    emitSortChange();
  });
  primaryDirectionSelect.addEventListener("change", emitSortChange);
  secondaryFieldSelect.addEventListener("change", () => {
    syncSelectOptions(
      secondaryDirectionSelect,
      secondaryFieldSelect.value === "none"
        ? directionOptionsForField(primaryFieldSelect.value)
        : directionOptionsForField(secondaryFieldSelect.value)
    );
    emitSortChange();
  });
  secondaryDirectionSelect.addEventListener("change", emitSortChange);
  hideDraftsCheckbox.addEventListener("change", () => {
    void handlers.onFilterChange({ hideDrafts: hideDraftsCheckbox.checked });
  });
  repositorySelect.addEventListener("change", () => {
    void handlers.onFilterChange({ repository: repositorySelect.value });
  });
  reviewSelect.addEventListener("change", () => {
    void handlers.onFilterChange({ review: reviewSelect.value });
  });
  checksSelect.addEventListener("change", () => {
    void handlers.onFilterChange({ checks: checksSelect.value });
  });

  function dismiss() {
    dismissDisclosures();
    closePromptKey = null;
    if (drawerView) {
      drawerView.closeComment = "";
    }
  }

  return { render, shadow, flushPending, setSaveState, dismiss };
}

function countStatuses(state) {
  const counts = Object.fromEntries(PERSONAL_STATUSES.map((status) => [status, 0]));
  for (const summary of state.allSummaries) {
    const status = (state.records[summary.key] || DEFAULT_RECORD).status;
    counts[status] += 1;
  }
  counts.active = state.allSummaries.length - counts.done;
  return counts;
}

function repositoryFilterOptions(summaries, selectedValue) {
  const repositories = new Map();
  for (const summary of summaries) {
    const value = [summary.owner, summary.repo].filter(Boolean).join("/");
    if (value && !repositories.has(value.toLocaleLowerCase())) {
      repositories.set(value.toLocaleLowerCase(), { value, label: value });
    }
  }
  const options = [...repositories.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true })
  );
  if (
    selectedValue !== "all" &&
    !options.some((option) => option.value.toLocaleLowerCase() === selectedValue.toLocaleLowerCase())
  ) {
    options.push({ value: selectedValue, label: `${selectedValue} (not in current list)` });
  }
  return [{ value: "all", label: "All repositories" }, ...options];
}

function countStructuredFilters(preferences) {
  return Number(preferences.hideDrafts) +
    Number(preferences.repository !== "all") +
    Number(preferences.review !== "all") +
    Number(preferences.checks !== "all");
}

function formatCount(count) {
  return `${count} pull request${count === 1 ? "" : "s"}`;
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60]
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit);
    }
  }
  return "just now";
}

function compactNote(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 110 ? `Note · ${text.slice(0, 107)}…` : `Note · ${text}`;
}

function renderLifecycle(view, lifecycle) {
  view.lifecycleList.textContent = "";
  const rows = summarizeLifecyclePhases(lifecycle);
  if (!rows.length) {
    const empty = view.lifecycleList.ownerDocument.createElement("div");
    empty.className = "lifecycle-empty";
    empty.textContent = "No lifecycle timing captured yet.";
    view.lifecycleList.append(empty);
    return;
  }
  for (const row of rows) {
    const item = view.lifecycleList.ownerDocument.createElement("div");
    item.className = "lifecycle-row";

    const label = view.lifecycleList.ownerDocument.createElement("span");
    label.className = "lifecycle-row-label";
    label.textContent = row.label;

    const detail = view.lifecycleList.ownerDocument.createElement("span");
    detail.className = "lifecycle-row-detail";
    detail.textContent = row.detail;
    item.append(label, detail);

    if (row.note) {
      const note = view.lifecycleList.ownerDocument.createElement("span");
      note.className = "lifecycle-row-note";
      note.textContent = row.note;
      item.append(note);
    }

    view.lifecycleList.append(item);
  }
}

function summarizeSort(sortPreferences, groupOptions, sortOptions) {
  const groupLabels = new Map(groupOptions.map((option) => [option.value, option.label]));
  const sortLabels = new Map(sortOptions.map((option) => [option.value, option.label]));
  const describe = (level) => {
    const label = sortLabels.get(level.field) || level.field;
    return `${label} ${level.direction === "desc" ? "↓" : "↑"}`;
  };
  const primaryLabel = groupLabels.get(sortPreferences.primary.field) || sortPreferences.primary.field;
  const groupedBy = `${primaryLabel} ${sortPreferences.primary.direction === "desc" ? "↓" : "↑"}`;
  return sortPreferences.secondary
    ? `Group: ${groupedBy} · ${describe(sortPreferences.secondary)}`
    : `Group: ${groupedBy}`;
}
