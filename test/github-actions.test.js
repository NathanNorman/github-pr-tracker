import test from "node:test";
import assert from "node:assert/strict";
import { closePullRequest, squashMergePullRequest } from "../src/github-actions.js";
import { parseHtml } from "./helpers.js";

const summary = {
  owner: "acme",
  repo: "api",
  number: 12,
  url: "https://github.toasttab.com/acme/api/pull/12"
};

function mergePage(action = "/acme/api/pull/12/merge") {
  return `
    <form action="${action}" method="post">
      <input type="hidden" name="authenticity_token" value="csrf-token">
      <input type="hidden" name="head_sha" value="abc123">
      <input name="commit_title" value="Improve the API (#12)">
      <textarea name="commit_message">default generated message</textarea>
      <input type="hidden" name="do" value="squash">
      <input name="ignored" value="disabled" disabled>
      <input type="checkbox" name="notify" value="yes">
    </form>`;
}

function closePage(action = "/acme/api/pull/12/comment?sticky=true") {
  return `
    <form action="${action}" method="post">
      <input type="hidden" name="authenticity_token" value="close-token">
      <textarea name="comment[body]"></textarea>
      <button name="comment_and_close" value="1">Close pull request</button>
    </form>`;
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

function parser(html, url) {
  return parseHtml(html, url);
}

test("squashMergePullRequest refreshes the form and posts the exact squash payload", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? response(mergePage())
      : response('<span class="State State--merged">Merged</span>');
  };

  assert.deepEqual(await squashMergePullRequest({ fetchImpl, parser, summary }), { state: "merged" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, summary.url);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].url, "https://github.toasttab.com/acme/api/pull/12/merge");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.credentials, "include");
  assert.equal(calls[1].options.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(
    calls[1].options.body,
    "authenticity_token=csrf-token&head_sha=abc123&commit_title=Improve+the+API+%28%2312%29&commit_message=&do=squash"
  );
});

test("closePullRequest posts an empty optional comment and the native close submitter", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? response(closePage())
      : response('<span title="Status: Closed" class="State State--closed">Closed</span>');
  };

  assert.deepEqual(await closePullRequest({ fetchImpl, parser, summary }), { state: "closed" });
  assert.equal(calls[1].url, "https://github.toasttab.com/acme/api/pull/12/comment?sticky=true");
  assert.equal(
    calls[1].options.body,
    "authenticity_token=close-token&comment%5Bbody%5D=&comment_and_close=1"
  );
});

test("closePullRequest replaces the close form comment with the supplied text", async () => {
  const calls = [];
  await closePullRequest({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response(closePage())
        : response('<span aria-label="Pull request state" data-state="closed">Closed</span>');
    },
    parser,
    summary,
    comment: "Closing because this is superseded."
  });
  assert.equal(
    calls[1].options.body,
    "authenticity_token=close-token&comment%5Bbody%5D=Closing+because+this+is+superseded.&comment_and_close=1"
  );
});

test("action helpers reject cross-origin and wrong-PR forms without posting", async () => {
  for (const html of [
    mergePage("https://evil.example/acme/api/pull/12/merge"),
    mergePage("/acme/api/pull/13/merge")
  ]) {
    let requests = 0;
    await assert.rejects(
      squashMergePullRequest({
        fetchImpl: async () => {
          requests += 1;
          return response(html);
        },
        parser,
        summary
      }),
      /No valid same-origin native merge form/
    );
    assert.equal(requests, 1);
  }
});

test("action helpers reject non-ok GET and POST responses without retrying", async () => {
  let getRequests = 0;
  await assert.rejects(
    squashMergePullRequest({
      fetchImpl: async () => {
        getRequests += 1;
        return response("unavailable", { ok: false, status: 503 });
      },
      parser,
      summary
    }),
    /HTTP 503/
  );
  assert.equal(getRequests, 1);

  let postRequests = 0;
  await assert.rejects(
    closePullRequest({
      fetchImpl: async () => {
        postRequests += 1;
        return postRequests === 1
          ? response(closePage())
          : response("forbidden", { ok: false, status: 403 });
      },
      parser,
      summary
    }),
    /HTTP 403/
  );
  assert.equal(postRequests, 2);
});

test("action helpers reject ok responses without a semantic success marker", async () => {
  let requests = 0;
  await assert.rejects(
    squashMergePullRequest({
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? response(mergePage())
          : response("<main><p>Merged changes are discussed in the timeline.</p></main>");
      },
      parser,
      summary
    }),
    /did not confirm.*merged/
  );
  assert.equal(requests, 2);
});
