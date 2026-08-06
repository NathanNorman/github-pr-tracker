import { DEFAULT_RECORD, SAVE_DEBOUNCE_MS, TAG_COLOR_TOKENS, TAG_COLORS } from "./constants.js";
import { debounce, now } from "./utils.js";

export function createUi(container, handlers) {
  const shadow = container.shadowRoot || container.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  const root = document.createElement("div");
  root.className = "tracker-root";
  shadow.replaceChildren(style, root);

  const shell = document.createElement("div");
  shell.className = "tracker-shell";
  const panel = document.createElement("section");
  panel.className = "panel";
  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  shell.append(panel, drawer);
  root.append(shell);

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search titles, repos, tags, notes";
  search.setAttribute("aria-label", "Search pull requests");
  search.setAttribute("data-focus-id", "search");
  search.addEventListener("input", (event) => handlers.onSearch(event.target.value));
  const filters = document.createElement("div");
  filters.className = "filters";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  const showCompleted = makeActionButton(() => handlers.onToggleCompleted());
  const refreshButton = makeActionButton(() => handlers.onRefresh());
  const exportButton = makeActionButton(() => handlers.onExport());
  const importButton = makeActionButton(() => handlers.onImport());
  toolbar.append(search, filters, spacer, showCompleted, refreshButton, exportButton, importButton);

  const warning = document.createElement("div");
  warning.className = "warning";
  const list = document.createElement("div");
  list.className = "list";
  panel.append(toolbar, warning, list);

  const saveState = document.createElement("div");
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
    showCompleted.textContent = state.showCompleted ? "Hide completed" : "Show completed";
    refreshButton.textContent = state.refreshing ? "Refreshing..." : "Refresh";
    refreshButton.disabled = state.refreshing;
    exportButton.textContent = "Export data";
    importButton.textContent = "Import data";

    const options = ["all", ...state.visibleStatuses];
    const existing = new Map([...filters.querySelectorAll("button")].map((button) => [button.dataset.status, button]));
    for (const status of options) {
      let button = existing.get(status);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "filter-btn";
        button.dataset.status = status;
        button.addEventListener("click", () => handlers.onStatusFilter(status));
        filters.append(button);
      }
      button.textContent = status === "all" ? "All" : status.replaceAll("_", " ");
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
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No pull requests match the current filters.";
      list.append(empty);
      return;
    }

    for (const summary of state.filteredSummaries) {
      const record = state.records[summary.key] || DEFAULT_RECORD;
      const row = document.createElement("div");
      row.className = "pr-row";
      row.dataset.prKey = summary.key;

      const rowButton = document.createElement("button");
      rowButton.type = "button";
      rowButton.className = "pr-row-select";
      rowButton.setAttribute("aria-selected", String(state.selectedKey === summary.key));
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

      const main = document.createElement("div");
      main.className = "row-main";
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = summary.title;
      const repo = document.createElement("div");
      repo.className = "repo";
      repo.textContent = `${summary.owner}/${summary.repo} #${summary.number}`;
      left.append(title, repo);

      const status = document.createElement("div");
      status.className = "badge";
      status.textContent = `My status: ${record.status.replaceAll("_", " ")}`;
      main.append(left, status);

      const badges = document.createElement("div");
      badges.className = "badges";
      badges.append(
        makeBadge("Review", summary.review || "unknown"),
        makeBadge("Checks", summary.checks || "unknown"),
        makeBadge("Merge", summary.merge || "unknown"),
        makeBadge("Draft", summary.draft ? "yes" : "no")
      );

      rowButton.append(main, badges);
      row.append(rowButton);

      if (record.tags.length) {
        const tags = document.createElement("div");
        tags.className = "tags";
        for (const tag of record.tags) {
          const tagButton = makeTagButton(tag, {
            ariaLabel: `Filter by tag ${tag.name}`,
            onClick(event) {
              event.stopPropagation();
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

    const header = document.createElement("div");
    header.className = "drawer-header";
    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = summary?.title || state.selectedKey;
    const subtitle = document.createElement("div");
    subtitle.className = "repo";
    subtitle.textContent = summary ? `${summary.owner}/${summary.repo} #${summary.number}` : state.selectedKey;
    titleWrap.append(title, subtitle);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "action-btn";
    close.textContent = "Close";
    close.addEventListener("click", async () => {
      await flushPending(state.selectedKey);
      handlers.onSelect(null);
      if (focusedBeforeDrawer instanceof HTMLElement) {
        focusedBeforeDrawer.focus();
      }
    });
    header.append(titleWrap, close);

    const statusField = document.createElement("label");
    statusField.textContent = "My status";
    const statusSelect = document.createElement("select");
    statusSelect.setAttribute("data-focus-id", "status");
    for (const status of ["unsorted", "next_up", "waiting", "blocked", "done"]) {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status.replaceAll("_", " ");
      option.selected = record.status === status;
      statusSelect.append(option);
    }

    const blockerField = document.createElement("label");
    blockerField.textContent = "Blocked by";
    const blockerInput = document.createElement("input");
    blockerInput.type = "text";
    blockerInput.value = record.blockedBy;
    blockerInput.hidden = record.status !== "blocked";
    blockerInput.setAttribute("data-focus-id", "blockedBy");
    blockerInput.addEventListener("input", () => queueSave(state.selectedKey, { blockedBy: blockerInput.value }));
    blockerInput.addEventListener("blur", () => {
      void flushPending(state.selectedKey);
    });
    blockerField.append(blockerInput);

    statusSelect.addEventListener("change", () => {
      queueSave(state.selectedKey, { status: statusSelect.value });
      blockerInput.hidden = statusSelect.value !== "blocked";
      if (statusSelect.value === "blocked") {
        blockerInput.focus();
      }
    });
    statusField.append(statusSelect);

    const notesField = document.createElement("label");
    notesField.textContent = "My notes";
    const notesInput = document.createElement("textarea");
    notesInput.rows = 8;
    notesInput.value = record.notes;
    notesInput.setAttribute("data-focus-id", "notes");
    notesInput.addEventListener("input", () => queueSave(state.selectedKey, { notes: notesInput.value }));
    notesInput.addEventListener("blur", () => {
      void flushPending(state.selectedKey);
    });
    notesField.append(notesInput);

    const tagsField = document.createElement("div");
    const tagsLabel = document.createElement("div");
    tagsLabel.textContent = "Private tags";
    const tagForm = document.createElement("form");
    tagForm.className = "tag-form";
    const tagInput = document.createElement("input");
    tagInput.type = "text";
    tagInput.placeholder = "Add tag";
    tagInput.setAttribute("aria-label", "Tag name");
    tagInput.setAttribute("data-focus-id", "tag-name");
    const colorSelect = document.createElement("select");
    colorSelect.setAttribute("aria-label", "Tag color");
    for (const color of TAG_COLORS) {
      const option = document.createElement("option");
      option.value = color;
      option.textContent = color;
      colorSelect.append(option);
    }
    const addTag = document.createElement("button");
    addTag.type = "submit";
    addTag.className = "action-btn";
    addTag.textContent = "Add";
    tagForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.onAddTag(state.selectedKey, tagInput.value, colorSelect.value);
      tagInput.value = "";
    });
    tagForm.append(tagInput, colorSelect, addTag);

    const existingTags = document.createElement("div");
    existingTags.className = "tags";
    for (const tag of record.tags) {
      const pill = makeTagButton(tag, {
        ariaLabel: `Remove tag ${tag.name}`,
        onClick() {
          handlers.onRemoveTag(state.selectedKey, tag.name);
        }
      });
      existingTags.append(pill);
    }

    const link = document.createElement("a");
    link.className = "link-btn";
    link.href = summary?.url || "#";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open pull request";

    saveState.textContent = state.saveState;
    tagsField.append(tagsLabel, tagForm, existingTags);
    drawer.append(header, saveState, statusField, blockerField, notesField, tagsField, link);
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
    setSaveState("Saving...");
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
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `${label}: ${value.replace?.("_", " ") || value}`;
    return badge;
  }

  function makeTagButton(tag, { onClick, ariaLabel }) {
    const pill = document.createElement("button");
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

  return { render, shadow, flushPending, setSaveState };

  function makeActionButton(onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-btn";
    button.addEventListener("click", onClick);
    return button;
  }
}
