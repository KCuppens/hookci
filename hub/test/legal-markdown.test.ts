import { describe, expect, it } from "vitest";
import { renderMarkdownSubset } from "../src/legal/markdown";

describe("renderMarkdownSubset", () => {
  it("escapes raw HTML", () => {
    expect(renderMarkdownSubset(`Hi <script>alert(1)</script> & "q"`)).toBe(
      "<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>",
    );
  });

  it("renders links to anything but http(s) or relative URLs as text", () => {
    expect(renderMarkdownSubset("[x](javascript:alert(1))")).toBe("<p>x</p>");
    for (const url of ["JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "mailto:a@example.invalid", "java\tscript:alert(1)"]) {
      const html = renderMarkdownSubset(`[x](${url})`);
      expect(html).not.toContain("<a");
      expect(html).not.toContain("href");
    }
  });

  it("links http(s) and relative URLs with the href escaped", () => {
    expect(renderMarkdownSubset("[a](https://e.example/x?a=1&b=2) [b](/security) [c](#top)")).toBe(
      '<p><a href="https://e.example/x?a=1&amp;b=2">a</a> <a href="/security">b</a> <a href="#top">c</a></p>',
    );
  });

  it("renders headings, paragraphs, lists, tables and inline code", () => {
    const md = [
      "# Title",
      "Para line one",
      "line two.",
      "",
      "## Lists",
      "- one",
      "- two `x<y`",
      "  continued",
      "",
      "1. first",
      "2. second",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | <b> |",
    ].join("\n");
    expect(renderMarkdownSubset(md)).toBe(
      [
        "<h1>Title</h1>",
        "<p>Para line one line two.</p>",
        "<h2>Lists</h2>",
        "<ul>",
        "<li>one</li>",
        "<li>two <code>x&lt;y</code> continued</li>",
        "</ul>",
        "<ol>",
        "<li>first</li>",
        "<li>second</li>",
        "</ol>",
        "<table>",
        "<thead><tr><th>A</th><th>B</th></tr></thead>",
        "<tbody>",
        "<tr><td>1</td><td>&lt;b&gt;</td></tr>",
        "</tbody>",
        "</table>",
      ].join("\n"),
    );
  });
});
