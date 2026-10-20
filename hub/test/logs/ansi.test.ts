import { describe, expect, it } from "vitest";
import { ansiToHtml } from "../../src/logs/ansi";

describe("ansiToHtml", () => {
  it("escapes HTML in the log", () => {
    expect(ansiToHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });

  it("turns SGR 31 into a c-red span and closes it on reset", () => {
    expect(ansiToHtml("\x1b[31mred\x1b[0m plain")).toBe('<span class="c-red">red</span> plain');
  });

  it("maps bold, dim, italic, underline and bright colours, and the codes that clear them", () => {
    expect(ansiToHtml("\x1b[1;92mok\x1b[22;39m done")).toBe('<span class="c-bold c-bright-green">ok</span> done');
    expect(ansiToHtml("\x1b[2;3;4mx\x1b[23;24my\x1b[mz")).toBe('<span class="c-dim c-italic c-underline">x</span><span class="c-dim">y</span>z');
    expect(ansiToHtml("\x1b[34ma\x1b[33mb")).toBe('<span class="c-blue">a</span><span class="c-yellow">b</span>');
  });

  it("maps 256-colour indexes 0-15 to the basic colours and drops the rest and truecolour", () => {
    expect(ansiToHtml("\x1b[38;5;1ma\x1b[38;5;12mb")).toBe('<span class="c-red">a</span><span class="c-bright-blue">b</span>');
    expect(ansiToHtml("\x1b[38;5;208ma\x1b[38;2;255;0;0;1mb")).toBe('a<span class="c-bold">b</span>');
    expect(ansiToHtml("\x1b[48;5;1;48;2;1;2;3mbg")).toBe("bg");
  });

  it("strips OSC 8 hyperlinks, titles and cursor moves", () => {
    expect(ansiToHtml("\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(ansiToHtml("\x1b]0;title\x07a\x1b[2Kb\x1b[1Ac\x1b[10;20Hd\x1b[?25le\x1b7f\x1b8")).toBe("abcdef");
  });

  it("drops a CSI that holds markup instead of leaking it", () => {
    expect(ansiToHtml("\x1b[<31ma<b>")).toBe("a&lt;b&gt;");
  });

  it("closes a colour the log never resets", () => {
    expect(ansiToHtml("\x1b[31mred to the end")).toBe('<span class="c-red">red to the end</span>');
    expect(ansiToHtml("cut mid-escape \x1b[3")).toBe("cut mid-escape ");
  });
});
