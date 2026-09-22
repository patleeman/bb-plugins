import test from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  channelLinkDestination,
  channelMessageReference,
} from "../channel-links";

const id = "1a5943b7-4148-436b-94b0-aab0a5401064";
const messageId =
  "return:job:2925deb5-e703-42c1-b4fa-7cae2ac51692:bot_7fdaa88f26cf748a:bot_7fdaa88f26cf748a";
const path = `/plugins/bots/channels/${id}/message/${encodeURIComponent(messageId)}`;
const known = new Set([id]);

test("copied message references are portable Markdown with intact message identity", () => {
  const reference = channelMessageReference(
    id,
    "Command [Center] *notes*\n",
    messageId,
  );
  assert.ok(!reference.includes("http"));
  const paragraph = fromMarkdown(reference).children[0];
  assert.equal(paragraph?.type, "paragraph");
  if (paragraph?.type !== "paragraph") assert.fail();
  const link = paragraph.children[0];
  assert.equal(link?.type, "link");
  if (link?.type !== "link") assert.fail();
  assert.equal(link.url, path);
  assert.equal(link.children[0]?.type, "text");
});

test("relative and same-server message links stay in the current client", () => {
  for (const origin of ["http://127.0.0.1:38886", "https://bb.example.com"]) {
    for (const href of [path, `${origin}${path}`]) {
      assert.equal(
        channelLinkDestination(href, origin, known),
        path.replace("/plugins/bots/channels/", ""),
      );
    }
  }
});

test("old desktop localhost links resolve on mobile only for a known channel", () => {
  for (const hostname of [
    "127.0.0.1:38886",
    "localhost:38886",
    "[::1]:38886",
  ]) {
    const href = `http://${hostname}${path}`;
    assert.equal(
      channelLinkDestination(href, "https://bb.example.com", known),
      path.replace("/plugins/bots/channels/", ""),
    );
    assert.equal(
      channelLinkDestination(href, "https://bb.example.com", new Set()),
      null,
    );
  }
});

test("uppercase channel IDs resolve to the canonical channel", () => {
  assert.equal(
    channelLinkDestination(
      path.replace(id, id.toUpperCase()),
      "https://bb.example.com",
      known,
    ),
    path.replace("/plugins/bots/channels/", ""),
  );
});

test("BB's localhost hostname rewrite still resolves when mobile uses another port or scheme", () => {
  const href = `http://bb.example.com:38886${path}`;
  assert.equal(
    channelLinkDestination(href, "https://bb.example.com", known),
    path.replace("/plugins/bots/channels/", ""),
  );
  assert.equal(
    channelLinkDestination(href, "https://bb.example.com", new Set()),
    null,
  );
});

test("unrelated servers, schemes, downloads and malformed routes are not treated as channel links", () => {
  for (const href of [
    `https://elsewhere.example${path}`,
    `//elsewhere.example${path}`,
    `javascript:alert(1)`,
    `https://user:pass@bb.example.com${path}`,
    `/plugins/bots/files/${id}`,
    `${path}/extra`,
    `${path}?download=1`,
    `/plugins/bots/channels/${id}/message/%E0%A4%A`,
    `/plugins/bots/channels/${id}/message/%00`,
  ])
    assert.equal(
      channelLinkDestination(href, "https://bb.example.com", known),
      null,
    );
});
