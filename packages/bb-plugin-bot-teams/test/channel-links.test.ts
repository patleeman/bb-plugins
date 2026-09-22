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
const path = `/plugins/bot-teams/channels/${id}/message/${encodeURIComponent(messageId)}`;
const known = new Set([id]);

test("legacy Bots links retain message IDs and only adopt known channels", () => {
  const legacy = path.replace("/bot-teams/", "/bots/");
  for (const href of [legacy, `http://127.0.0.1:38886${legacy}`]) {
    assert.equal(
      channelLinkDestination(href, "http://127.0.0.1:38886", known),
      `${id}/message/${messageId}`,
    );
    assert.equal(
      channelLinkDestination(href, "http://127.0.0.1:38886", new Set()),
      null,
    );
  }
});

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
        `${id}/message/${messageId}`,
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
      `${id}/message/${messageId}`,
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
    `${id}/message/${messageId}`,
  );
});

test("BB's localhost hostname rewrite still resolves when mobile uses another port or scheme", () => {
  const href = `http://bb.example.com:38886${path}`;
  assert.equal(
    channelLinkDestination(href, "https://bb.example.com", known),
    `${id}/message/${messageId}`,
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
    `/plugins/bot-teams/files/${id}`,
    `${path}/extra`,
    `${path}?download=1`,
    `/plugins/bot-teams/channels/${id}/message/%E0%A4%A`,
    `/plugins/bot-teams/channels/${id}/message/%00`,
  ])
    assert.equal(
      channelLinkDestination(href, "https://bb.example.com", known),
      null,
    );
});
