import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serializeJsonLd } from "@hraness/web-discovery";
import { benchmarkJsonLd, homeJsonLd, PAGE_JSON_LD } from "./structured-data.ts";

const root = import.meta.dir;

describe("structured data", () => {
  test("home graph defines the website node the blog points at and makes no offer", () => {
    const home = homeJsonLd();
    const ids = home["@graph"].map(node => node["@id"]);
    expect(ids).toContain("https://clankdar.com/#website");
    expect(ids).toContain("https://clankdar.com/#software");
    expect(home["@graph"].every(node => !("@context" in node))).toBe(true);
    expect(JSON.stringify(home)).not.toContain("offers");
    for (const node of home["@graph"]) expect(node.publisher["@id"]).toBe("https://hraness.com/#organization");
  });

  test("benchmark dataset carries the report license and lists only files that exist", () => {
    const dataset = benchmarkJsonLd();
    expect(dataset.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(dataset.distribution.length).toBeGreaterThan(0);
    for (const { contentUrl } of dataset.distribution) {
      expect(contentUrl.startsWith("https://clankdar.com/benchmark/")).toBe(true);
      expect(contentUrl).not.toMatch(/\.jsonl\.gz$/);
      expect(existsSync(resolve(root, contentUrl.slice("https://clankdar.com/".length)))).toBe(true);
    }
  });

  test("serialized JSON-LD cannot close its script element", () => {
    for (const build of Object.values(PAGE_JSON_LD)) {
      const text = serializeJsonLd(build());
      expect(text).not.toContain("</script");
      expect(JSON.parse(text)).toEqual(build());
    }
  });
});
