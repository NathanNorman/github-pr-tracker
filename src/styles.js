export const styles = `
:host {
  display: block;
  width: 100%;
  min-width: 0;
  color: var(--fgColor-default, #1f2328);
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
}
* {
  box-sizing: border-box;
}
button,
input,
select,
textarea {
  font: inherit;
}
button,
select {
  cursor: pointer;
}
.tracker-root {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
  padding: 24px 24px 56px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  margin: 0 0 20px;
}
.page-heading {
  min-width: 0;
}
.page-heading h1 {
  margin: 0;
  color: var(--fgColor-default, #1f2328);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
}
.page-subtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 6px;
  color: var(--fgColor-muted, #59636e);
}
.privacy-note::before {
  content: "●";
  margin-right: 6px;
  color: var(--fgColor-success, #1a7f37);
  font-size: 8px;
  vertical-align: 2px;
}
.page-header input[type="search"] {
  width: min(360px, 38vw);
  height: 36px;
  padding: 7px 12px 7px 34px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 8px;
  background-color: var(--bgColor-default, #ffffff);
  background-image: radial-gradient(circle, transparent 5px, var(--fgColor-muted, #59636e) 5px, var(--fgColor-muted, #59636e) 6px, transparent 6px), linear-gradient(45deg, transparent 46%, var(--fgColor-muted, #59636e) 47%, var(--fgColor-muted, #59636e) 54%, transparent 55%);
  background-position: 10px 10px, 22px 22px;
  background-repeat: no-repeat;
  background-size: 14px 14px, 7px 7px;
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-inset, inset 0 1px 0 rgba(31,35,40,0.04));
}
.tracker-shell {
  display: grid;
  grid-template-columns: 172px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.tracker-shell.has-drawer {
  grid-template-columns: 172px minmax(0, 1fr) minmax(340px, 380px);
}
.status-sidebar {
  position: sticky;
  top: 20px;
  min-width: 0;
}
.eyebrow {
  margin: 0 10px 8px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.filters {
  display: grid;
  gap: 3px;
}
.filter-btn,
.sidebar-action {
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fgColor-default, #1f2328);
  text-align: left;
}
.filter-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
}
.filter-btn:hover,
.sidebar-action:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
}
.filter-btn[aria-pressed="true"] {
  background: var(--control-transparent-bgColor-selected, rgba(175,184,193,0.22));
  box-shadow: inset 3px 0 0 var(--borderColor-accent-emphasis, #0969da);
  font-weight: 600;
}
.filter-label::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  vertical-align: 1px;
}
.filter-btn[data-status="all"] .filter-label::before,
.filter-btn[data-status="next_up"] .filter-label::before {
  background: var(--fgColor-accent, #0969da);
}
.filter-btn[data-status="waiting"] .filter-label::before {
  background: var(--fgColor-attention, #9a6700);
}
.filter-btn[data-status="blocked"] .filter-label::before {
  background: var(--fgColor-danger, #d1242f);
}
.filter-btn[data-status="done"] .filter-label::before {
  background: var(--fgColor-success, #1a7f37);
}
.filter-count {
  min-width: 26px;
  padding: 1px 7px;
  border: 1px solid var(--borderColor-muted, #d8dee4);
  border-radius: 999px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  text-align: center;
}
.sidebar-tools {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.sidebar-action {
  padding: 7px 10px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.sidebar-action[aria-pressed="true"] {
  color: var(--fgColor-accent, #0969da);
}
.backup-menu {
  margin-top: 14px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.backup-menu summary {
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  list-style-position: inside;
}
.backup-menu summary:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.16));
}
.backup-actions {
  margin-top: 3px;
  padding-left: 10px;
}
.panel,
.drawer {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 10px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-resting-small, 0 1px 0 rgba(31,35,40,0.04));
}
.panel-header {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--borderColor-muted, #d8dee4);
  background: var(--bgColor-muted, #f6f8fa);
}
.result-count {
  font-size: 14px;
  font-weight: 600;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sort-menu {
  position: relative;
}
.sort-summary {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 7px;
  background: var(--button-default-bgColor-rest, var(--bgColor-default, #ffffff));
  color: var(--button-default-fgColor-rest, var(--fgColor-default, #1f2328));
  font-size: 13px;
  font-weight: 500;
  list-style: none;
  user-select: none;
}
.sort-summary::-webkit-details-marker {
  display: none;
}
.sort-summary::after {
  content: "▾";
  margin-left: 8px;
  color: var(--fgColor-muted, #59636e);
  font-size: 11px;
}
.sort-menu[open] .sort-summary,
.sort-summary:hover {
  background: var(--button-default-bgColor-hover, var(--bgColor-neutral-muted, #eaeef2));
}
.sort-rows {
  position: absolute;
  z-index: 20;
  top: calc(100% + 8px);
  right: 0;
  display: grid;
  gap: 10px;
  min-width: 320px;
  padding: 12px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 10px;
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  box-shadow: var(--shadow-floating-large, 0 12px 28px rgba(31,35,40,0.15));
}
.sort-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 118px;
  gap: 8px;
  align-items: center;
}
.sort-row-label {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
  font-weight: 600;
}
.sort-row select {
  height: 32px;
  padding: 5px 9px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 6px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
}
.sort-row select:disabled {
  color: var(--fgColor-muted, #59636e);
  background: var(--bgColor-muted, #f6f8fa);
}
.action-btn,
.link-btn,
.icon-btn {
  border: 1px solid var(--borderColor-default, #d1d9e0);
  background: var(--button-default-bgColor-rest, var(--bgColor-muted, #f6f8fa));
  color: var(--button-default-fgColor-rest, var(--fgColor-default, #1f2328));
  text-decoration: none;
}
.action-btn {
  min-height: 32px;
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
}
.action-btn:hover,
.icon-btn:hover {
  background: var(--button-default-bgColor-hover, var(--bgColor-neutral-muted, #eaeef2));
}
.action-btn:disabled {
  cursor: default;
  opacity: 0.65;
}
.list {
  display: grid;
}
.pr-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 156px;
  grid-template-areas:
    "select status"
    "tags status";
  align-items: center;
  border-top: 1px solid var(--borderColor-muted, #d8dee4);
}
.pr-row:first-child {
  border-top: 0;
}
.pr-row:hover {
  background: var(--control-transparent-bgColor-hover, rgba(175,184,193,0.08));
}
.pr-row:has(.pr-row-select[aria-selected="true"]) {
  background: var(--bgColor-accent-muted, rgba(84,174,255,0.12));
  box-shadow: inset 3px 0 0 var(--borderColor-accent-emphasis, #0969da);
}
.pr-row-select {
  grid-area: select;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 13px;
  width: 100%;
  min-width: 0;
  padding: 14px 12px 12px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}
.pr-icon {
  width: 10px;
  height: 10px;
  margin-top: 21px;
  border: 2px solid var(--fgColor-open, var(--fgColor-success, #1a7f37));
  border-radius: 50%;
}
.row-copy {
  display: block;
  min-width: 0;
}
.title,
.repo,
.row-details,
.blocker-preview {
  display: block;
}
.note-preview,
.personal-hint {
  display: block;
  overflow: hidden;
  margin-top: 5px;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-preview {
  color: var(--fgColor-default, #1f2328);
}
.personal-hint {
  color: var(--fgColor-muted, #59636e);
  opacity: 0.72;
}
.pr-row:hover .personal-hint,
.pr-row:focus-within .personal-hint {
  color: var(--fgColor-accent, #0969da);
  opacity: 1;
}
.title {
  overflow: hidden;
  color: var(--fgColor-default, #1f2328);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
}
.repo {
  margin-bottom: 2px;
  color: var(--fgColor-muted, #59636e);
  font-size: 13px;
}
.row-details {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  margin-top: 7px;
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
}
.badge {
  white-space: nowrap;
}
.badge::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  vertical-align: 1px;
}
.badge[data-state="approved"]::before,
.badge[data-state="passing"]::before,
.badge[data-state="clean"]::before {
  background: var(--fgColor-success, #1a7f37);
}
.badge[data-state="failing"]::before,
.badge[data-state="changes_requested"]::before,
.badge[data-state="conflicting"]::before,
.badge[data-state="blocked"]::before {
  background: var(--fgColor-danger, #d1242f);
}
.badge[data-state="pending"]::before,
.badge[data-state="required"]::before {
  background: var(--fgColor-attention, #9a6700);
}
.badge[data-state="unknown"] {
  opacity: 0.68;
}
.blocker-preview {
  overflow: hidden;
  margin-top: 5px;
  color: var(--fgColor-danger, #d1242f);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-status {
  position: relative;
  grid-area: status;
  margin: 0 14px 0 4px;
}
.quick-status::before {
  content: "";
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 11px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fgColor-muted, #59636e);
  transform: translateY(-50%);
  pointer-events: none;
}
.quick-status[data-status="next_up"]::before {
  background: var(--fgColor-accent, #0969da);
}
.quick-status[data-status="waiting"]::before {
  background: var(--fgColor-attention, #9a6700);
}
.quick-status[data-status="blocked"]::before {
  background: var(--fgColor-danger, #d1242f);
}
.quick-status[data-status="done"]::before {
  background: var(--fgColor-success, #1a7f37);
}
.status-select,
.drawer select,
.drawer textarea,
.drawer input[type="text"] {
  width: 100%;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 7px;
  background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-inset, inset 0 1px 0 rgba(31,35,40,0.04));
}
.status-select {
  height: 34px;
  padding: 5px 28px 5px 28px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.row-tags {
  grid-area: tags;
  padding: 0 12px 12px 41px;
}
.tag-pill {
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 6px;
  font-size: 12px;
}
.drawer {
  position: sticky;
  top: 20px;
  display: grid;
  gap: 20px;
  max-height: calc(100vh - 40px);
  padding: 20px;
  overflow: auto;
}
.drawer[hidden] {
  display: none;
}
.drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.drawer-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.drawer-subtitle,
.save-state {
  color: var(--fgColor-muted, #59636e);
  font-size: 12px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  border-color: transparent;
  border-radius: 7px;
  background: transparent;
  font-size: 22px;
  line-height: 1;
}
.drawer-identity {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--borderColor-muted, #d8dee4);
}
.drawer-identity .title {
  white-space: normal;
}
.field {
  display: grid;
  gap: 7px;
}
.field[hidden] {
  display: none;
}
.field-label {
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
  font-weight: 600;
}
.drawer select,
.drawer input[type="text"] {
  height: 36px;
  padding: 7px 10px;
}
.drawer textarea {
  min-height: 150px;
  padding: 9px 10px;
  line-height: 1.5;
  resize: vertical;
}
.tag-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px auto;
  gap: 7px;
}
.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}
.save-state {
  min-height: 18px;
}
.link-btn {
  border: 0;
  background: transparent;
  color: var(--fgColor-accent, #0969da);
  font-size: 13px;
}
.warning {
  margin: 12px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--borderColor-attention-muted, #d4a72c66);
  border-radius: 7px;
  background: var(--bgColor-attention-muted, #fff8c5);
  color: var(--fgColor-default, #1f2328);
  font-size: 13px;
}
.warning[hidden] {
  display: none;
}
.empty {
  display: grid;
  place-items: center;
  gap: 5px;
  min-height: 240px;
  padding: 36px 20px;
  color: var(--fgColor-muted, #59636e);
  text-align: center;
}
.empty strong {
  color: var(--fgColor-default, #1f2328);
  font-size: 16px;
}
.empty span {
  font-size: 13px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
:focus-visible {
  outline: 2px solid var(--focus-outlineColor, var(--borderColor-accent-emphasis, #0969da));
  outline-offset: 2px;
}
@media (max-width: 1180px) {
  .tracker-shell.has-drawer {
    grid-template-columns: 172px minmax(0, 1fr);
  }
  .drawer {
    position: fixed;
    z-index: 1000;
    top: 76px;
    right: 18px;
    bottom: 18px;
    width: min(380px, calc(100vw - 36px));
    max-height: none;
    background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
    box-shadow: var(--shadow-floating-large, 0 8px 24px rgba(31,35,40,0.18));
  }
}
@media (max-width: 820px) {
  .tracker-root {
    padding: 20px 12px 36px;
  }
  .page-header {
    align-items: stretch;
    flex-direction: column;
    gap: 16px;
  }
  .page-header input[type="search"] {
    width: 100%;
  }
  .tracker-shell,
  .tracker-shell.has-drawer {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .panel-header {
    align-items: flex-start;
  }
  .panel-actions {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .status-sidebar {
    position: static;
  }
  .filters {
    display: flex;
    overflow-x: auto;
  }
  .filter-btn {
    width: auto;
    min-width: max-content;
  }
  .sidebar-tools {
    display: none;
  }
  .sort-rows {
    min-width: min(320px, calc(100vw - 48px));
  }
}
@media (max-width: 620px) {
  .panel-header,
  .drawer-footer {
    flex-direction: column;
    align-items: stretch;
  }
  .sort-row {
    grid-template-columns: 1fr;
  }
  .pr-row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "select"
      "tags"
      "status";
  }
  .quick-status {
    margin: 0 16px 14px 52px;
  }
}
`;
