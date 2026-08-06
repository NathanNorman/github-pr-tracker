import { DEFAULT_RECORD, PERSONAL_STATUSES, SAVE_DEBOUNCE_MS, TAG_COLOR_TOKENS, TAG_COLORS } from "./constants.js";
import { debounce, now } from "./utils.js";

const STATUS_LABELS = {
  unsorted: "Unsorted",
  next_up: "Next up",
  waiting: "Waiting",
  blocked: "Blocked",
  done: "Done"
};

export function createUi(container, handlers) {
  const doc = container.ownerDocument;
  const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  const root = doc.createElement("div");
  root.className = "tracker-root";
  shadow.replaceChildren(style, root);

  const pageHeader = doc.createElement("header");
  pageHeader.className = "page-header";
  const heading = doc.createElement("div");
  heading.className = "page-heading";
  const pageTitle = doc.createElement("h1");
  pageTitle.textContent = "My pull requests";
  const pageSubtitle = doc.createElement("div");
  pageSubtitle.className = "page-subtitle";
  const subtitleText = doc.createElement("span");
  subtitleText.textContent = "Personal workflow for pull requests you opened";
  const privacy = doc.createElement("span");
  privacy.className = "privacy-note";
  privacy.textContent = "Private to this browser";
  pageSubtitle.append(subtitleText, privacy);
  heading.append(pageTitle, pageSubtitle);

  const search = doc.createElement("input");
  search.type = "search";
  search.placeholder = "Search my pull requests";
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
  sidebarLabel.textContent = "My status";
  const filters = doc.createElement("div");
  filters.className = "filters";

  const sidebarTools = doc.createElement("div");
  sidebarTools.className = "sidebar-tools";
  const viewLabel = doc.createElement("div");
  viewLabel.className = "eyebrow";
  viewLabel.textContent = "View";
  const showCompleted = makeActionButton("", () => handlers.onToggleCompleted(), "sidebar-action");
  const dataLabel = doc.createElement("div");
  dataLabel.className = "eyebrow data-label";
  dataLabel.textContent = "Local data";
  const exportButton = makeActionButton("Export backup", () => handlers.onExport(), "sidebar-action");
  const importButton = makeActionButton("Import backup", () => handlers.onImport(), "sidebar-action");
  sidebarTools.append(viewLabel, showCompleted, dataLabel, exportButton, importButton);
  sidebar.append(sidebarLabel, filters, sidebarTools);

  const panel = doc.createElement("section");
  panel.className = "panel";
  const panelHeader = doc.createElement("div");
  panelHeader.className = "panel-header";
  const resultCount = doc.createElement("strong");
  resultCount.className = "result-count";
  const refreshButton = makeActionButton("Refresh", () => handlers.onRefresh(), "action-btn");
  panelHeader.append(resultCount, refreshButton);

  const warning = doc.createElement("div");
  warning.className = "warning";
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
        emptyText.textContent = "Try another status or clear your search.";
      }
      empty.append(emptyTitle, emptyText);
      list.append(empty);
      return;
    }

    for (const summary of state.filteredSummaries) {
      const record = state.records[summary.key] || DEFAULT_RECORD;
      const row = doc.createElement("div");
      row.className = "pr-row";
      row.dataset.prKey = summary.key;

      const rowButton = doc.createElement("button");
      rowButton.type = "button";
      rowButton.className = "pr-row-select";
      rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
      rowButton.setAttribute("aria-label", `Edit personal tracking for ${summary.title}`);
      rowButton.addEventListener("click", () => {
        focusedBeforeDrawer = shadow.activeElement;
        handlers.onSelect(summary.key);
      });
      rowButton.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focusedBeforeDrawer = shadow.activeElement;
          handlers.onSelect(summary.key);
        }
      });

      const rowIcon = doc.createElement("span");
      rowIcon.className = "pr-icon";
      rowIcon.setAttribute("aria-hidden", "true");
      rowIcon.textContent = "⑂";
      const rowCopy = doc.createElement("span");
      rowCopy.className = "row-copy";
      const repo = doc.createElement("span");
      repo.className = "repo";
      repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
      const title = doc.createElement("span");
      title.className = "title";
      title.textContent = summary.title;
      const details = doc.createElement("span");
      details.className = "row-details";
      if (summary.updatedAt) {
        const updated = doc.createElement("span");
        updated.textContent = `Updated ${formatRelativeTime(summary.updatedAt)}`;
        details.append(updated);
      }
      appendKnownBadge(details, "Review", summary.review);
      appendKnownBadge(details, "Checks", summary.checks);
      appendKnownBadge(details, "Merge", summary.merge);
      if (summary.draft) {
        details.append(makeBadge("Draft", "draft"));
      }
      if (record.status === "blocked" && record.blockedBy) {
        const blocker = doc.createElement("span");
        blocker.className = "blocker-preview";
        blocker.textContent = `Blocked by ${record.blockedBy}`;
        rowCopy.append(repo, title, details, blocker);
      } else {
        rowCopy.append(repo, title, details);
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

      row.append(rowButton, quickStatus);

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

      list.append(row);
    }
  }

  function renderDrawer(state) {
    shell.classList.toggle("has-drawer", Boolean(state.selectedKey));
    drawer.hidden = !state.selectedKey;
    if (!state.selectedKey) {
      void flushPending(currentSelectedKey);
      currentSelectedKey = null;
      drawer.textContent = "";
      return;
    }

    const summary =
      state.allSummaries.find((item) => item.key === state.selectedKey) ||
      state.filteredSummaries.find((item) => item.key === state.selectedKey);
    const record = state.records[state.selectedKey] || DEFAULT_RECORD;
    currentSelectedKey = state.selectedKey;
    drawer.textContent = "";

    const header = doc.createElement("div");
    header.className = "drawer-header";
    const headerText = doc.createElement("div");
    const drawerTitle = doc.createElement("h2");
    drawerTitle.textContent = "Personal tracking";
    const drawerSubtitle = doc.createElement("div");
    drawerSubtitle.className = "drawer-subtitle";
    drawerSubtitle.textContent = "Saved only in this browser";
    headerText.append(drawerTitle, drawerSubtitle);

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "icon-btn";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close personal tracking panel");
    close.addEventListener("click", async () => {
      await flushPending(state.selectedKey);
      handlers.onSelect(null);
      if (focusedBeforeDrawer instanceof HTMLElement) {
        focusedBeforeDrawer.focus();
      }
    });
    header.append(headerText, close);

    const identity = doc.createElement("div");
    identity.className = "drawer-identity";
    const identityTitle = doc.createElement("div");
    identityTitle.className = "title";
    identityTitle.textContent = summary?.title || state.selectedKey;
    const identityRepo = doc.createElement("div");
    identityRepo.className = "repo";
    identityRepo.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
    identity.append(identityTitle, identityRepo);

    const statusField = makeField("My status");
    const statusSelect = makeStatusSelect(record.status);
    statusSelect.setAttribute("data-focus-id", "status");

    const blockerField = makeField("Blocked by");
    const blockerInput = doc.createElement("input");
    blockerInput.type = "text";
    blockerInput.placeholder = "Person, team, decision, or dependency";
    blockerInput.value = record.blockedBy;
    blockerField.hidden = record.status !== "blocked";
    blockerInput.setAttribute("data-focus-id", "blockedBy");
    blockerInput.addEventListener("input", () => queueSave(state.selectedKey, { blockedBy: blockerInput.value }));
    blockerInput.addEventListener("blur", () => void flushPending(state.selectedKey));
    blockerField.append(blockerInput);

    statusSelect.addEventListener("change", () => {
      queueSave(state.selectedKey, { status: statusSelect.value });
      blockerField.hidden = statusSelect.value !== "blocked";
      if (statusSelect.value === "blocked") {
        blockerInput.focus();
      }
    });
    statusField.append(statusSelect);

    const tagsField = doc.createElement("div");
    tagsField.className = "field";
    const tagsLabel = doc.createElement("div");
    tagsLabel.className = "field-label";
    tagsLabel.textContent = "Private tags";
    const tagForm = doc.createElement("form");
    tagForm.className = "tag-form";
    const tagInput = doc.createElement("input");
    tagInput.type = "text";
    tagInput.placeholder = "Add a tag";
    tagInput.setAttribute("aria-label", "Tag name");
    tagInput.setAttribute("data-focus-id", "tag-name");
    const colorSelect = doc.createElement("select");
    colorSelect.setAttribute("aria-label", "Tag color");
    for (const color of TAG_COLORS) {
      const option = doc.createElement("option");
      option.value = color;
      option.textContent = color;
      colorSelect.append(option);
    }
    const addTag = makeActionButton("Add", null, "action-btn");
    addTag.type = "submit";
    tagForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.onAddTag(state.selectedKey, tagInput.value, colorSelect.value);
      tagInput.value = "";
    });
    tagForm.append(tagInput, colorSelect, addTag);

    const existingTags = doc.createElement("div");
    existingTags.className = "tags";
    for (const tag of record.tags) {
      const pill = makeTagButton(tag, {
        ariaLabel: `Remove tag ${tag.name}`,
        onClick() {
          handlers.onRemoveTag(state.selectedKey, tag.name);
        }
      });
      pill.title = "Remove private tag";
      existingTags.append(pill);
    }
    tagsField.append(tagsLabel, tagForm, existingTags);

    const notesField = makeField("My notes");
    const notesInput = doc.createElement("textarea");
    notesInput.rows = 7;
    notesInput.placeholder = "Context, next steps, reminders…";
    notesInput.value = record.notes;
    notesInput.setAttribute("data-focus-id", "notes");
    notesInput.addEventListener("input", () => queueSave(state.selectedKey, { notes: notesInput.value }));
    notesInput.addEventListener("blur", () => void flushPending(state.selectedKey));
    notesField.append(notesInput);

    const footer = doc.createElement("div");
    footer.className = "drawer-footer";
    const link = doc.createElement("a");
    link.className = "link-btn";
    link.href = summary?.url || "#";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open pull request ↗";
    saveState.textContent = state.saveState;
    footer.append(saveState, link);

    drawer.append(header, identity, statusField, blockerField, tagsField, notesField, footer);
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
    let entry = pendingSaves.get(key);
    if (!entry) {
      entry = {
        patch: {},
        running: Promise.resolve(),
        scheduled: false,
        debounced: debounce(() => {
          void startSave(key);
        }, SAVE_DEBOUNCE_MS)
      };
      pendingSaves.set(key, entry);
    }
    entry.patch = { ...entry.patch, ...patch };
    handlers.onLocalPatch?.(key, patch);
    setSaveState("Saving…");
    entry.debounced();
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
    entry.debounced.flush();
    await entry.running;
    if (!entry.scheduled && !Object.keys(entry.patch).length) {
      pendingSaves.delete(key);
    }
  }

  function startSave(key) {
    const entry = pendingSaves.get(key);
    if (!entry) {
      return Promise.resolve();
    }
    if (entry.scheduled || !Object.keys(entry.patch).length) {
      return entry.running;
    }

    entry.scheduled = true;
    const patchToSave = { ...entry.patch };
    entry.patch = {};
    entry.running = entry.running
      .catch(() => {})
      .then(async () => {
        try {
          await handlers.onEdit(key, patchToSave, now());
        } finally {
          entry.scheduled = false;
          if (Object.keys(entry.patch).length) {
            return startSave(key);
          }
          pendingSaves.delete(key);
        }
      });
    return entry.running;
  }

  function setSaveState(value) {
    saveState.textContent = value;
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

  function makeBadge(label, value) {
    const badge = doc.createElement("span");
    badge.className = "badge";
    badge.dataset.state = value;
    badge.textContent = `${label}: ${String(value).replaceAll("_", " ")}`;
    return badge;
  }

  function appendKnownBadge(target, label, value) {
    if (value && value !== "unknown") {
      target.append(makeBadge(label, value));
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

  return { render, shadow, flushPending, setSaveState };
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
