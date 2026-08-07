import { GITHUB_ORIGIN } from "./constants.js";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
const HTML_ACCEPT = "text/html,application/xhtml+xml";

export async function squashMergePullRequest({ fetchImpl, parser, summary }) {
  return submitPullRequestAction({
    fetchImpl,
    parser,
    summary,
    action: "merge",
    configure(form, fields) {
      requireSuccessfulFields(fields, ["authenticity_token", "head_sha", "commit_title", "commit_message"]);
      const squashControl = form.querySelector('input[type="hidden"][name="do"]');
      if (!squashControl || squashControl.value !== "squash" || squashControl.matches(":disabled")) {
        throw new Error("The native squash merge form is missing its squash action control.");
      }
      if (!fields.get("authenticity_token") || !fields.get("head_sha")) {
        throw new Error("The native squash merge form is missing required authenticated values.");
      }
      fields.set("commit_message", "");
      fields.set("do", "squash");
    },
    expectedState: "merged"
  });
}

export async function closePullRequest({ fetchImpl, parser, summary, comment = "" }) {
  return submitPullRequestAction({
    fetchImpl,
    parser,
    summary,
    action: "close",
    configure(form, fields) {
      requireSuccessfulFields(fields, ["authenticity_token", "comment[body]"]);
      const closeButton = form.querySelector('button[name="comment_and_close"]');
      if (
        !closeButton ||
        closeButton.value !== "1" ||
        closeButton.matches(":disabled")
      ) {
        throw new Error("The native close form is missing its comment-and-close submit control.");
      }
      if (!fields.get("authenticity_token")) {
        throw new Error("The native close form is missing its authenticated value.");
      }
      fields.set("comment[body]", String(comment ?? ""));
      fields.set("comment_and_close", "1");
    },
    expectedState: "closed"
  });
}

async function submitPullRequestAction({ fetchImpl, parser, summary, action, configure, expectedState }) {
  if (typeof fetchImpl !== "function" || typeof parser !== "function") {
    throw new TypeError("A fetch implementation and HTML parser are required.");
  }

  const pullRequest = parseCanonicalPullRequest(summary);
  const getResponse = await fetchImpl(summary.url, {
    credentials: "include",
    headers: { Accept: HTML_ACCEPT }
  });
  assertOkResponse(getResponse, `Loading pull request #${pullRequest.number}`);

  const pageHtml = await getResponse.text();
  const pageDocument = parseDocument(parser, pageHtml, pullRequest.url.href);
  const { form, actionUrl } = findNativeForm(pageDocument, pullRequest, action);
  const fields = serializeSuccessfulControls(form);
  configure(form, fields);

  const postResponse = await fetchImpl(actionUrl.href, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: HTML_ACCEPT,
      "Content-Type": FORM_CONTENT_TYPE
    },
    body: fields.toString()
  });
  assertOkResponse(postResponse, `${action === "merge" ? "Merging" : "Closing"} pull request #${pullRequest.number}`);

  const responseHtml = await postResponse.text();
  const responseDocument = parseDocument(parser, responseHtml, pullRequest.url.href);
  if (!documentConfirmsState(responseDocument, expectedState)) {
    throw new Error(`GitHub did not confirm that pull request #${pullRequest.number} was ${expectedState}.`);
  }

  return { state: expectedState };
}

function parseCanonicalPullRequest(summary) {
  if (!summary || typeof summary.url !== "string" || !summary.url) {
    throw new TypeError("A pull request summary with a URL is required.");
  }

  let url;
  try {
    url = new URL(summary.url);
  } catch {
    throw new Error("The pull request URL is invalid.");
  }
  if (url.origin !== GITHUB_ORIGIN) {
    throw new Error("The pull request URL must use the authenticated GitHub origin.");
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || url.search || url.hash) {
    throw new Error("The pull request URL must identify one canonical pull request.");
  }

  const [, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (
    (summary.owner != null && String(summary.owner) !== owner) ||
    (summary.repo != null && String(summary.repo) !== repo) ||
    (summary.number != null && Number(summary.number) !== number)
  ) {
    throw new Error("The pull request summary does not match its URL.");
  }

  return {
    url,
    owner,
    repo,
    number,
    path: `/${owner}/${repo}/pull/${numberText}`
  };
}

function findNativeForm(doc, pullRequest, action) {
  const expectedPath = action === "merge"
    ? `${pullRequest.path}/merge`
    : `${pullRequest.path}/comment`;

  for (const form of doc.querySelectorAll("form")) {
    if ((form.getAttribute("method") || "get").trim().toLowerCase() !== "post") {
      continue;
    }
    const rawAction = form.getAttribute("action");
    if (!rawAction) {
      continue;
    }

    let actionUrl;
    try {
      actionUrl = new URL(rawAction, pullRequest.url);
    } catch {
      continue;
    }
    if (
      actionUrl.origin !== pullRequest.url.origin ||
      actionUrl.pathname !== expectedPath ||
      actionUrl.hash
    ) {
      continue;
    }
    if (action === "merge" && actionUrl.search) {
      continue;
    }
    if (action === "close" && !hasExactStickyQuery(actionUrl)) {
      continue;
    }
    return { form, actionUrl };
  }

  throw new Error(`No valid same-origin native ${action} form was found for this pull request.`);
}

function hasExactStickyQuery(url) {
  const entries = [...url.searchParams.entries()];
  return entries.length === 1 && entries[0][0] === "sticky" && entries[0][1] === "true";
}

function serializeSuccessfulControls(form) {
  const fields = new URLSearchParams();
  for (const control of form.elements) {
    const name = control.getAttribute("name") || "";
    if (!name || control.matches(":disabled")) {
      continue;
    }

    const tagName = control.tagName.toLowerCase();
    if (tagName === "button") {
      continue;
    }
    if (tagName === "select") {
      for (const option of control.selectedOptions) {
        if (!option.disabled) {
          fields.append(name, option.value);
        }
      }
      continue;
    }

    const type = (control.getAttribute("type") || "").toLowerCase();
    if (["button", "submit", "reset", "image", "file"].includes(type)) {
      continue;
    }
    if (["checkbox", "radio"].includes(type) && !control.checked) {
      continue;
    }
    fields.append(name, control.value);
  }
  return fields;
}

function requireSuccessfulFields(fields, names) {
  for (const name of names) {
    if (!fields.has(name)) {
      throw new Error(`The native form is missing the required ${name} control.`);
    }
  }
}

function parseDocument(parser, html, url) {
  const doc = parser(html, url);
  if (!doc || typeof doc.querySelectorAll !== "function") {
    throw new Error("The HTML parser did not return a document.");
  }
  return doc;
}

function assertOkResponse(response, context) {
  if (!response || !response.ok) {
    const status = response?.status == null ? "unknown" : response.status;
    throw new Error(`${context} failed with HTTP ${status}.`);
  }
}

function documentConfirmsState(doc, state) {
  const title = state[0].toUpperCase() + state.slice(1);
  const selectors = [
    `.State--${state}`,
    `[title="Status: ${title}"]`,
    `[aria-label="Status: ${title}"]`,
    `[data-test-selector="pr-state"][data-state="${state}"]`,
    `[aria-label="Pull request state"][data-state="${state}"]`
  ];
  for (const element of doc.querySelectorAll(selectors.join(","))) {
    const semanticValue = [
      element.getAttribute("data-state"),
      element.getAttribute("title")?.replace(/^Status:\s*/i, ""),
      element.getAttribute("aria-label")?.replace(/^(?:Status:\s*|Pull request state\s*:?\s*)/i, ""),
      element.textContent
    ]
      .filter(Boolean)
      .map((value) => value.trim().toLowerCase());
    if (semanticValue.includes(state)) {
      return true;
    }
  }
  return false;
}
