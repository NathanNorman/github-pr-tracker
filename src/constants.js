export const APP_ID = "tm-github-pr-tracker";
export const SCHEMA_VERSION = 1;
export const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
export const DETAIL_PARSER_VERSION = 2;
export const OPEN_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
export const SAVE_DEBOUNCE_MS = 400;

export const PERSONAL_STATUSES = ["unsorted", "next_up", "waiting", "blocked", "done"];
export const ACTIVE_STATUSES = PERSONAL_STATUSES.filter((status) => status !== "done");
export const REVIEW_STATES = ["approved", "changes_requested", "required", "none", "unknown"];
export const CHECK_STATES = ["passing", "failing", "pending", "none", "unknown"];
export const MERGE_STATES = ["clean", "blocked", "conflicting", "unknown"];
export const TAG_COLORS = ["gray", "blue", "purple", "green", "yellow", "orange", "red", "pink"];

export const DEFAULT_RECORD = Object.freeze({
  status: "unsorted",
  blockedBy: "",
  notes: "",
  tags: [],
  modifiedAt: 0
});

export const TAG_COLOR_TOKENS = {
  gray: {
    fg: "var(--button-default-fgColor-rest, var(--fgColor-default, inherit))",
    bg: "var(--bgColor-neutral-muted, rgba(175,184,193,0.2))",
    border: "var(--borderColor-neutral-muted, rgba(175,184,193,0.4))"
  },
  blue: {
    fg: "var(--fgColor-accent, #0969da)",
    bg: "var(--bgColor-accent-muted, rgba(84,174,255,0.2))",
    border: "var(--borderColor-accent-muted, rgba(84,174,255,0.4))"
  },
  purple: {
    fg: "var(--fgColor-done, #8250df)",
    bg: "var(--bgColor-done-muted, rgba(194,151,255,0.2))",
    border: "var(--borderColor-done-muted, rgba(194,151,255,0.4))"
  },
  green: {
    fg: "var(--fgColor-success, #1a7f37)",
    bg: "var(--bgColor-success-muted, rgba(74,194,107,0.2))",
    border: "var(--borderColor-success-muted, rgba(74,194,107,0.4))"
  },
  yellow: {
    fg: "var(--fgColor-attention, #9a6700)",
    bg: "var(--bgColor-attention-muted, rgba(212,167,44,0.2))",
    border: "var(--borderColor-attention-muted, rgba(212,167,44,0.4))"
  },
  orange: {
    fg: "var(--fgColor-severe, #bc4c00)",
    bg: "var(--bgColor-severe-muted, rgba(251,143,68,0.2))",
    border: "var(--borderColor-severe-muted, rgba(251,143,68,0.4))"
  },
  red: {
    fg: "var(--fgColor-danger, #d1242f)",
    bg: "var(--bgColor-danger-muted, rgba(255,129,130,0.2))",
    border: "var(--borderColor-danger-muted, rgba(255,129,130,0.4))"
  },
  pink: {
    fg: "var(--fgColor-sponsors, #bf3989)",
    bg: "var(--bgColor-sponsors-muted, rgba(255,128,200,0.2))",
    border: "var(--borderColor-sponsors-muted, rgba(255,128,200,0.4))"
  }
};
