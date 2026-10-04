import { expect, test } from "bun:test";
import snapshot from "../portfolio-messaging.generated.json";
import { renderPortfolioCopy } from "./portfolio-copy";

for (const page of ["index.html", "docs/index.html", "blog/page.html", "benchmark/index.html", "404.html"]) {
  test(`${page} renders the canonical Clankdar wordmark independently of its accessible label`, async () => {
    const source = await Bun.file(new URL(page, import.meta.url)).text();
    const html = renderPortfolioCopy(source, snapshot);
    const text: string[] = [];
    await new HTMLRewriter().on("a.wordmark", { text(chunk) { text.push(chunk.text); } }).transform(new Response(html)).text();
    expect(text.join("").trim()).toBe(snapshot.messaging.names.name);
    expect(html).toContain(`aria-label="${snapshot.messaging.names.name} home"`);
  });
}
