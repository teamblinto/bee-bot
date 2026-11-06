import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { Markdown } from "./Markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

it("shows raw HTML as text, never as markup", () => {
  const html = render('Hi <script>alert(1)</script> <img src="https://evil.test/x.png"> there');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
});

it("never emits an image, and turns an http one into a text link", () => {
  const html = render("![a chart](https://evil.test/leak?q=secret)");
  expect(html).not.toContain("<img");
  expect(html).toContain('href="https://evil.test/leak?q=secret"');
  expect(html).toContain(">a chart (evil.test)</a>");
  expect(render("![](https://evil.test/x.png)")).toContain(">Image link (evil.test)</a>");
});

it("renders an image with a disallowed URL as plain text", () => {
  const html = render("![tracker](javascript:alert(1))");
  expect(html).not.toContain("<a");
  expect(html).not.toContain("<img");
  expect(html).toContain("tracker");
});

it("keeps http links, opening externally, and blocks every other scheme", () => {
  expect(render("[ok](https://example.com)")).toContain(
    '<a href="https://example.com" title="https://example.com" target="_blank" rel="noreferrer noopener">ok</a>',
  );
  for (const url of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "file:///c",
  ]) {
    const html = render(`[bad](${url})`);
    expect(html).not.toContain("<a");
    expect(html).toContain("bad");
  }
});
