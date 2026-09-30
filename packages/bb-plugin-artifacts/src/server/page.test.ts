import { describe, expect, it } from "vitest";
import { pageMarkdown } from "./page";

const version = (name: string, size = 10) => ({ name, mime: "", size });

describe("pageMarkdown", () => {
  it("copies Markdown and fences code longer than any backtick run inside", () => {
    expect(pageMarkdown(version("a.md"), "# Hi")).toBe("# Hi");
    expect(pageMarkdown(version("a.ts"), "const a = 1;")).toBe("```ts\nconst a = 1;\n```");
    expect(pageMarkdown(version("a.txt"), "x ```` y")).toBe("`````\nx ```` y\n`````");
  });

  it("handles more backtick runs than a call takes arguments", () => {
    const text = "` ".repeat(300_000);
    expect(pageMarkdown(version("a.txt"), text).startsWith("```\n")).toBe(true);
  });

  it("says why an artifact can't become a page", () => {
    expect(() => pageMarkdown(version("a.html"), "<p>x</p>")).toThrow(/Only Markdown, text and code/);
    expect(() => pageMarkdown(version("a.png"), null)).toThrow(/Only Markdown, text and code/);
    expect(() => pageMarkdown(version("big.md", 2 * 1024 * 1024), null)).toThrow(/big\.md is 2(\.0)? MB; pages can be made from text up to 1(\.0)? MB/);
  });
});
