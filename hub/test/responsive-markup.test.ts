import { describe, expect, it } from "vitest";
import { loginPage } from "../src/pages/account";
import { signInPage } from "../src/pages/dashboard";
import { errorPage } from "../src/pages/error";
import { startPage } from "../src/pages/start";

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
const INSTALL = "https://github.com/apps/x/installations/new";
const FORM = { csrf: "t", googleEnabled: false };

async function render(res: Response | Promise<Response>): Promise<string> {
  return (await res).text();
}

describe("responsive markup invariants", () => {
  it("every styled page sets the safe-area viewport", async () => {
    const pages = [
      await render(loginPage(FORM)),
      await render(signInPage()),
      await render(errorPage("rate_limited", 429)),
      await render(startPage(INSTALL, "c=1")),
    ];
    for (const html of pages) expect(html).toContain(VIEWPORT);
  });

  it("marketing pages ship a no-JS mobile menu and keep Docs reachable", async () => {
    const html = await render(startPage(INSTALL, "c=1"));
    expect(html).toContain('<details class="mm"');
    expect(html).toContain("https://hookci.com/docs");
  });

  it("login inputs disable mobile autocorrection", async () => {
    const html = await render(loginPage(FORM));
    expect(html).toContain('inputmode="email"');
    expect(html).toContain('autocapitalize="off"');
  });

  it("styles stay in the hashed stylesheet with responsive rules present", async () => {
    const html = await render(loginPage(FORM));
    expect(html).toContain("@media");
    expect(html).not.toContain('style="');
  });
});
