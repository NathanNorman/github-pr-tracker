export const styles = `
:host {
  color: var(--fgColor-default, inherit);
  font: var(--base-text-body, normal 400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
}
* {
  box-sizing: border-box;
}
.tracker-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
  gap: 16px;
  align-items: start;
}
.panel,
.drawer,
.modal {
  background: var(--bgColor-default, transparent);
  color: var(--fgColor-default, inherit);
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  border-radius: 12px;
  box-shadow: var(--shadow-resting-small, none);
}
.panel {
  overflow: hidden;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
}
.toolbar input[type="search"],
.drawer textarea,
.drawer input[type="text"],
.drawer select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  border-radius: 8px;
  background: var(--bgColor-inset, var(--bgColor-default, transparent));
  color: inherit;
}
.toolbar .spacer {
  flex: 1 1 160px;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.filter-btn,
.action-btn,
.link-btn {
  border: 1px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  background: var(--button-default-bgColor-rest, var(--bgColor-muted, transparent));
  color: var(--button-default-fgColor-rest, inherit);
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
  text-decoration: none;
}
.filter-btn[aria-pressed="true"] {
  border-color: var(--borderColor-accent-emphasis, currentColor);
  outline: 2px solid transparent;
}
.list {
  display: grid;
}
.pr-row,
.pr-row-select {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
  cursor: pointer;
}
.pr-row {
  border-top: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
}
.pr-row:first-child,
.pr-row-select:first-child {
  border-top: 0;
}
.pr-row-select {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: inherit;
}
.pr-row-select[aria-selected="true"] {
  background: var(--bgColor-accent-muted, color-mix(in srgb, currentColor 8%, transparent));
}
.row-main {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.title {
  font-weight: 600;
}
.repo {
  color: var(--fgColor-muted, inherit);
}
.badges,
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.badge,
.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--borderColor-muted, color-mix(in srgb, currentColor 15%, transparent));
  font-size: 12px;
}
.drawer {
  position: sticky;
  top: 16px;
  padding: 16px;
  display: grid;
  gap: 12px;
}
.drawer label {
  display: grid;
  gap: 6px;
  font-weight: 600;
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: start;
}
.save-state {
  color: var(--fgColor-muted, inherit);
  min-height: 1.25em;
}
.warning {
  margin: 0 16px 16px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--borderColor-attention-muted, color-mix(in srgb, currentColor 22%, transparent));
  background: var(--bgColor-attention-muted, color-mix(in srgb, currentColor 8%, transparent));
}
.empty {
  padding: 24px 16px;
  color: var(--fgColor-muted, inherit);
}
.tag-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}
.tag-colors {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag-color {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 2px solid var(--borderColor-default, color-mix(in srgb, currentColor 22%, transparent));
  cursor: pointer;
}
.tag-color[aria-pressed="true"] {
  outline: 2px solid var(--borderColor-accent-emphasis, currentColor);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
:focus-visible {
  outline: 2px solid var(--focus-outlineColor, var(--borderColor-accent-emphasis, currentColor));
  outline-offset: 2px;
}
@media (max-width: 960px) {
  .tracker-shell {
    grid-template-columns: 1fr;
  }
  .drawer {
    position: fixed;
    inset: auto 12px 12px 12px;
    max-height: min(80vh, 720px);
    overflow: auto;
    z-index: 1000;
    background: var(--overlay-bgColor, var(--bgColor-default, transparent));
  }
}
`;
