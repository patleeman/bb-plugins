import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN, cleanExplainerMarkdown } from "./markdown";

const body = "## What it is\n\nThe job queue retries failed jobs with exponential backoff, stored in `jobs`.\n\n## Why it matters\n\nBilling depends on it.";

describe("cleaning the worker's Markdown", () => {
  it("lifts the trailing ::explore line into follow-ups", () => {
    const result = cleanExplainerMarkdown(`${body}\n\n::explore{items="🔗 Where retries are scheduled|🐛 Timeout is never reset|🕐 A|🏗️ B"}\n`);
    expect(result.markdown).toBe(body);
    expect(result.followUps).toEqual([
      { emoji: "🔗", label: "Where retries are scheduled" },
      { emoji: "🐛", label: "Timeout is never reset" },
      { emoji: "🕐", label: "A" },
    ]);
  });

  it("drops a ::reactions line after it too", () => {
    const result = cleanExplainerMarkdown(`${body}\n::explore{items="🔗 Next"}\n::reactions{items="👍 Thanks"}`);
    expect(result.markdown).toBe(body);
    expect(result.followUps).toEqual([{ emoji: "🔗", label: "Next" }]);
  });

  it("drops a stray ::reactions line mid-document, but not inside code", () => {
    const code = "```md\n::reactions{items=\"👍 Kept\"}\n```";
    const result = cleanExplainerMarkdown(`${body}\n::reactions{items="👍 Thanks"}\n\n${code}\n\nMore.`);
    expect(result.markdown).toBe(`${body}\n\n${code}\n\nMore.`);
  });

  it("leaves ::explore alone when it isn't trailing", () => {
    const text = `${body}\n\n::explore{items="🔗 Mid"}\n\nMore text after it.`;
    expect(cleanExplainerMarkdown(text)).toEqual({ markdown: text, followUps: [] });
  });

  it("unwraps a fence around the whole document", () => {
    expect(cleanExplainerMarkdown(`\`\`\`markdown\n${body}\n\`\`\``).markdown).toBe(body);
    expect(cleanExplainerMarkdown(`\`\`\`\n${body}\n\`\`\``).markdown).toBe(body);
  });

  it("keeps a document that is one diagram or code block", () => {
    const diagram = "```mermaid\ngraph TD\n  A[Enqueue] --> B[Worker] --> C[Retry with backoff] --> B\n  B --> D[Done]\n```";
    expect(cleanExplainerMarkdown(diagram).markdown).toBe(diagram);
  });

  it("drops a preamble and a leading title", () => {
    expect(cleanExplainerMarkdown(`Here's the explainer:\n\n# The job queue\n\n${body}`).markdown).toBe(body);
    expect(cleanExplainerMarkdown(`# The job queue\n${body}`).markdown).toBe(body);
  });

  it("rejects an empty or tiny result", () => {
    expect(() => cleanExplainerMarkdown("")).toThrow(/empty/);
    expect(() => cleanExplainerMarkdown(null)).toThrow(/empty/);
    expect(() => cleanExplainerMarkdown('Done.\n::explore{items="🔗 X"}')).toThrow(/empty/);
  });

  it("caps the size, closing a fence it cut through", () => {
    const huge = `${body}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(20_000)}\`\`\``;
    const { markdown } = cleanExplainerMarkdown(huge);
    expect(markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN + 100);
    expect(markdown).toMatch(/cut short/);
    expect((markdown.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it("closes a longer fence it cut through with the same fence", () => {
    const huge = `${body}\n\n\`\`\`\`html\n<pre>\n\`\`\`\n</pre>\n${"<p>x</p>\n".repeat(30_000)}\`\`\`\``;
    const { markdown } = cleanExplainerMarkdown(huge);
    expect(markdown).toMatch(/\n````\n\n\*This explainer was cut short/);
  });

  it("normalizes line endings", () => {
    expect(cleanExplainerMarkdown(body.replace(/\n/g, "\r\n")).markdown).toBe(body);
  });
});
