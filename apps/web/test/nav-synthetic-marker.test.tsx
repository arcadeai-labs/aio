import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SYNTHETIC_MARKER } from "../src/lib/synthetic-view";

// The render-level half of issue #4. `synthetic-view.test.ts` asserts *when* the
// marker should appear and `syntheticRunDates` asserts the flag survives the
// round trip to Postgres — but both stay green if the marker is deleted from the
// header, which is the one thing this feature is: be visible. Deleting the
// `shell__synthetic` block from Nav has to turn a suite red, and this is it.
//
// Only the router is substituted, never the component under test: `Link` needs a
// RouterProvider that a unit test has no business standing up, and it has nothing
// to do with the marker. Everything else — the scope decision, the wording, the
// markup — is the real Nav.
mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
  }: { children: ReactNode; className?: string }) => (
    // A span, not an anchor: where the nav links point is not what this file is
    // about, and a hrefless <a> is an accessibility lint error.
    <span className={className}>{children}</span>
  ),
}));

import type { NavSection } from "../src/components/Nav";

const { Nav } = await import("../src/components/Nav");

/** Run dates from the seed corpus: its latest run, and the prior one. */
const SEEDED = ["2026-09-14", "2026-09-07"];

const render = (props: Partial<Parameters<typeof Nav>[0]> = {}): string =>
  renderToStaticMarkup(
    <Nav
      active="scoreboard"
      segment="global"
      syntheticRuns={SEEDED}
      run="2026-09-14"
      {...props}
    />,
  );

/** The marker element's own markup, or null when the header renders none. */
const marker = (html: string): string | null =>
  html.match(/<div class="shell__synthetic".*?<\/div>/)?.[0] ?? null;

/** Every section of the nav — i.e. every page in the dashboard. */
const SECTIONS: NavSection[] = [
  "scoreboard",
  "prompts",
  "competitive",
  "cited",
  "runs",
  null,
];

describe("a synthetic scope renders the marker", () => {
  test.each(SECTIONS)("on the %p page", (active) => {
    // The header is shared, so one page cannot be marked while another is not;
    // asserting each section is what makes "on every page" a test rather than a
    // claim.
    const html = render({ active });
    expect(marker(html)).not.toBeNull();
    expect(html).toContain(SYNTHETIC_MARKER);
  });

  test("a page that pools the whole corpus is marked with no run named", () => {
    expect(marker(render({ run: undefined }))).not.toBeNull();
  });

  test("the wording is the shared constant, not a second copy", () => {
    // Two sources for this sentence would let the header say something weaker
    // than the one the rest of the codebase reviews.
    expect(marker(render())).toContain(SYNTHETIC_MARKER);
  });
});

describe("a non-synthetic scope renders no marker", () => {
  test("a real run selected on a mixed corpus", () => {
    expect(marker(render({ run: "2026-09-28" }))).toBeNull();
  });

  test("a corpus with no synthetic runs at all", () => {
    // The normal state of a real deployment, and of every run ingested before
    // the flag existed. Nothing may be marked here.
    expect(marker(render({ syntheticRuns: [], run: undefined }))).toBeNull();
    expect(render({ syntheticRuns: [] })).not.toContain("Synthetic data");
  });
});

describe("the marker is not dismissible", () => {
  test("it carries no control of any kind", () => {
    // A caveat you can close is absent from the screenshot taken after you
    // closed it. The header's only button is sign-out, which is why this looks
    // at the marker element rather than the whole header.
    const el = marker(render({ email: "analyst@example.com" }));
    expect(el).not.toBeNull();
    expect(el).not.toContain("<button");
    expect(el).not.toContain("onclick");
    expect(el?.toLowerCase()).not.toContain("dismiss");
    expect(el?.toLowerCase()).not.toContain("close");
  });
});
