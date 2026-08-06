import { JSDOM } from "jsdom";

export function parseHtml(html, url = "https://github.com/pulls") {
  return new JSDOM(html, { url }).window.document;
}

export function makeDom(url = "https://github.com/pulls?pr_tracker=1") {
  const dom = new JSDOM(
    `<!doctype html><html><head><meta name="user-login" content="octocat"></head><body><main><div id="default-content">Default content</div></main></body></html>`,
    { url, pretendToBeVisual: true }
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.Blob = dom.window.Blob;
  globalThis.URL = dom.window.URL;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}
