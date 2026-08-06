import { createTrackerApp } from "./app.js";
import { detectCurrentLogin, ensureTrackerNav } from "./github.js";
import { createStorage } from "./storage.js";

function createDocumentParser() {
  return (html) => new DOMParser().parseFromString(html, "text/html");
}

function getGmApi() {
  return {
    getValue: globalThis.GM_getValue?.bind(globalThis),
    setValue: globalThis.GM_setValue?.bind(globalThis),
    addValueChangeListener: globalThis.GM_addValueChangeListener?.bind(globalThis),
    removeValueChangeListener: globalThis.GM_removeValueChangeListener?.bind(globalThis)
  };
}

async function bootstrap() {
  const login = detectCurrentLogin(document);
  if (!login) {
    return;
  }
  ensureTrackerNav(document);
  const app = createTrackerApp({
    doc: document,
    win: window,
    fetchImpl: window.fetch.bind(window),
    parser: createDocumentParser(),
    storage: createStorage(getGmApi(), login),
    login
  });

  await app.init();
  const rerun = () => {
    ensureTrackerNav(document);
    app.handleRoute();
  };

  const observer = new MutationObserver(() => rerun());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", rerun);
  window.addEventListener("beforeunload", () => app.flushPending?.());
  document.addEventListener("pjax:end", rerun);
}

bootstrap().catch((error) => {
  console.error("GitHub PR Tracker failed to start", error);
});
