import { describe, expect, test } from "bun:test";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { Nav, type NavSection } from "../src/components/Nav";
import { SYNTHETIC_MARKER } from "../src/lib/synthetic-view";

// The render-level half of issue #4. `synthetic-view.test.ts` asserts *when* the
// marker should appear and `syntheticRunDates` asserts the flag survives the
// round trip to Postgres — but both stay green if the marker is deleted from the
// header, which is the one thing this feature is: be visible. Deleting the
// `shell__synthetic` block from Nav has to turn a suite red, and this is it.
//
// Nothing is substituted. The header is rendered inside a real router over a
// memory history — `Link` needs one, and since issue #39 so does the highlight,
// which reads the location. This used to stub `@tanstack/react-router` with
// `mock.module`, which is process-global in `bun test`: it reached into every
// other file in the run, and the render-level suite that stands up a real router
// got the stub instead and failed in CI while passing locally on file order.

/** Run dates from the seed corpus: its latest run, and the prior one. */
const SEEDED = ["2026-09-14", "2026-09-07"];

async function render(
  props: Partial<Parameters<typeof Nav>[0]> = {},
): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => (
      <Nav
        active="scoreboard"
        segment="global"
        syntheticRuns={SEEDED}
        run="2026-09-14"
        {...props}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  // biome-ignore lint/suspicious/noExplicitAny: an ad-hoc router, not the app's registered one
  return renderToStaticMarkup(<RouterProvider router={router as any} />);
}

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
  test.each(SECTIONS)("on the %p page", async (active) => {
    // The header is shared, so one page cannot be marked while another is not;
    // asserting each section is what makes "on every page" a test rather than a
    // claim.
    const html = await render({ active });
    expect(marker(html)).not.toBeNull();
    expect(html).toContain(SYNTHETIC_MARKER);
  });

  test("a page that pools the whole corpus is marked with no run named", async () => {
    expect(marker(await render({ run: undefined }))).not.toBeNull();
  });

  test("the wording is the shared constant, not a second copy", async () => {
    // Two sources for this sentence would let the header say something weaker
    // than the one the rest of the codebase reviews.
    expect(marker(await render())).toContain(SYNTHETIC_MARKER);
  });
});

describe("a non-synthetic scope renders no marker", () => {
  test("a real run selected on a mixed corpus", async () => {
    expect(marker(await render({ run: "2026-09-28" }))).toBeNull();
  });

  test("a corpus with no synthetic runs at all", async () => {
    // The normal state of a real deployment, and of every run ingested before
    // the flag existed. Nothing may be marked here.
    expect(
      marker(await render({ syntheticRuns: [], run: undefined })),
    ).toBeNull();
    expect(await render({ syntheticRuns: [] })).not.toContain("Synthetic data");
  });
});

describe("the marker is not dismissible", () => {
  test("it carries no control of any kind", async () => {
    // A caveat you can close is absent from the screenshot taken after you
    // closed it. The header's only button is sign-out, which is why this looks
    // at the marker element rather than the whole header.
    const el = marker(await render({ email: "analyst@example.com" }));
    expect(el).not.toBeNull();
    expect(el).not.toContain("<button");
    expect(el).not.toContain("onclick");
    expect(el?.toLowerCase()).not.toContain("dismiss");
    expect(el?.toLowerCase()).not.toContain("close");
  });
});
