// Issue #39: a segmented control may never mark two options as current.
//
// The defect was invisible at rest. Before the click one pill was current, after
// the loader resolved one pill was current, and for the ~50ms in between *two*
// were — one marked from the route's data, one from the location, which had
// already moved. A test that renders once and asserts the settled markup proves
// nothing about it, exactly as issue #23 found for the KPI tiles.
//
// So these tests drive a real router over a real (memory) history with a loader
// that is deliberately slow, and sample the rendered DOM across the click. The
// predicate is the browser sampler's, verbatim: an option reads as current if it
// carries an `--active` class **or** `aria-current`. Asserting only on the class
// would miss half the defect — assistive tech reads the attribute, not the CSS.
//
// The first test is the control and is load-bearing: it proves the harness can
// observe the window this bug lives in at all. If the router ever resolved its
// loaders synchronously under happy-dom, the invariant tests below would go
// green while checking nothing.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real origin, not the default `about:blank`: the nav imports the better-auth
// browser client, which resolves its base URL from `window.location` at import
// and throws on a URL with no protocol. Registration is conditional and the URL
// is set either way, because `bun test` shares one process across files and
// another suite may have registered happy-dom first (registering twice throws).
if (GlobalRegistrator.isRegistered) {
  window.happyDOM.setURL("http://localhost/");
} else {
  GlobalRegistrator.register({ url: "http://localhost/" });
}

// Imported after the DOM exists: react-dom/client binds to globals at import.
const { createRoot } = await import("react-dom/client");
const {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} = await import("@tanstack/react-router");
const { Nav } = await import("../src/components/Nav");
const { SegmentPills } = await import("../src/components/SegmentPills");
const { toSegment } = await import("../src/lib/segments");

/** How long each route's loader takes to answer. Wide enough to sample across
 * on a loaded CI box; the real window on the seeded corpus was ~50ms. */
const LOADER_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A router shaped like the dashboard's, minus the database ─────────────────
//
// Two routes, both scoped by `segment` in the URL, both with a slow loader, both
// rendering the real Nav and the real SegmentPills. Nothing about the control is
// stubbed: only the data behind it is.

const rootRoute = createRootRoute({ component: () => <Outlet /> });

// The two routes' real search shapes (apps/web/src/routes/index.tsx and
// cited.tsx). They matter: the nav links carry a search of their own, and how it
// compares against the current one is part of what decides whether a link reads
// as current.
function scoreboardSearch(search: Record<string, unknown>) {
  return {
    segment: toSegment(search.segment),
    byTheme: search.byTheme === true || search.byTheme === "true",
    byProvider: search.byProvider === true || search.byProvider === "true",
  };
}

function citedSearch(search: Record<string, unknown>) {
  return {
    segment: toSegment(search.segment),
    theme: typeof search.theme === "string" ? search.theme : "all",
  };
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: scoreboardSearch,
  loaderDeps: ({ search }) => ({ segment: search.segment }),
  loader: async ({ deps }) => {
    await sleep(LOADER_MS);
    return { segment: deps.segment };
  },
  component: function Scoreboard() {
    const { segment } = indexRoute.useLoaderData();
    return (
      <>
        <Nav active="scoreboard" segment={segment} syntheticRuns={[]} />
        <SegmentPills to="/" variant="scoreboard" />
        {/* What the *data* says, so a frame can be compared against it. */}
        <p className="loaded">{`scoreboard:${segment}`}</p>
      </>
    );
  },
});

const citedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cited",
  validateSearch: citedSearch,
  loaderDeps: ({ search }) => ({ segment: search.segment }),
  loader: async ({ deps }) => {
    await sleep(LOADER_MS);
    return { segment: deps.segment };
  },
  component: function Cited() {
    const { segment } = citedRoute.useLoaderData();
    return (
      <>
        <Nav active="cited" segment={segment} syntheticRuns={[]} />
        <SegmentPills to="/cited" variant="panel" />
        <p className="loaded">{`cited:${segment}`}</p>
      </>
    );
  },
});

interface Frame {
  t: number;
  /** The labels of every option that reads as current in this frame. */
  current: string[];
  /** What the rendered route data says, for the control. */
  loaded: string;
}

/** The browser sampler's predicate, unchanged. */
function currentLabels(host: Element, selector: string): string[] {
  return [...host.querySelectorAll(selector)]
    .filter(
      (el) =>
        el.className.includes("--active") || el.getAttribute("aria-current"),
    )
    .map((el) => el.textContent?.trim() ?? "");
}

// biome-ignore lint/suspicious/noExplicitAny: the ad-hoc test router
const ROUTERS = new WeakMap<Element, any>();
// biome-ignore lint/suspicious/noExplicitAny: the ad-hoc test router
const routerOf = (host: Element): any => ROUTERS.get(host);

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, citedRoute]),
    history: createMemoryHistory({ initialEntries: ["/?segment=global"] }),
  });
  ROUTERS.set(host, router);
  await router.load();
  // biome-ignore lint/suspicious/noExplicitAny: an ad-hoc router, not the app's registered one
  createRoot(host).render(<RouterProvider router={router as any} />);
  for (let i = 0; i < 100 && !host.querySelector(".loaded"); i++) {
    await sleep(10);
  }
  return host;
}

/** Clicks the option labelled `label`, then samples every ~8ms for `ms`. */
async function sampleAcrossClick(
  host: Element,
  selector: string,
  label: string,
  ms = 600,
): Promise<Frame[]> {
  const target = [...host.querySelectorAll(selector)].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!target) throw new Error(`no ${selector} labelled ${label}`);

  const frames: Frame[] = [];
  const t0 = performance.now();
  (target as HTMLElement).click();
  while (performance.now() - t0 < ms) {
    frames.push({
      t: Math.round(performance.now() - t0),
      current: currentLabels(host, selector),
      loaded: host.querySelector(".loaded")?.textContent ?? "",
    });
    await sleep(8);
  }
  return frames;
}

const offenders = (frames: Frame[]) =>
  frames
    .filter((f) => f.current.length !== 1)
    .map((f) => `t=${f.t}ms current=[${f.current.join(", ")}]`);

describe("the harness can see the window this bug lives in (control)", () => {
  test("the control leads the data across a segment switch", async () => {
    // If this stops holding, the loader is resolving before anything can be
    // sampled and every assertion below is vacuous.
    const host = await mount();
    const frames = await sampleAcrossClick(host, ".segctl__opt", "Branded");
    expect(frames.length).toBeGreaterThan(20);

    const leading = frames.filter(
      (f) => f.current[0] === "Branded" && f.loaded === "scoreboard:global",
    );
    expect(leading.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]?.loaded).toBe("scoreboard:branded");
  });
});

describe("exactly one option reads as current, in every frame", () => {
  test("the scoreboard's segment control", async () => {
    const host = await mount();
    const frames = await sampleAcrossClick(host, ".segctl__opt", "Branded");
    expect(offenders(frames)).toEqual([]);
    expect(frames[frames.length - 1]?.current).toEqual(["Branded"]);
  });

  test("the Cited view's segment pills", async () => {
    const host = await mount();
    await sampleAcrossClick(host, ".shell__navlink", "Cited", 400);
    const frames = await sampleAcrossClick(host, ".comp__seg", "Unbranded");
    expect(offenders(frames)).toEqual([]);
    expect(frames[frames.length - 1]?.current).toEqual(["Unbranded"]);
  });

  test("the nav's section links", async () => {
    const host = await mount();
    const frames = await sampleAcrossClick(host, ".shell__navlink", "Cited");
    expect(offenders(frames)).toEqual([]);
    expect(frames[frames.length - 1]?.current).toEqual(["Cited"]);
  });
});

describe("and at rest, on the page it landed on", () => {
  test("one nav link is current on the scoreboard, and one on Cited", async () => {
    // The settled half of the same invariant. It is separate because the two
    // failures are different: a control that reads double *during* a switch is a
    // timing defect, and one that reads double after it has settled is a
    // matching defect — a link whose `to` is a prefix of every other page.
    const host = await mount();
    expect(currentLabels(host, ".shell__navlink")).toEqual(["Scoreboard"]);

    await sampleAcrossClick(host, ".shell__navlink", "Cited", 400);
    expect(currentLabels(host, ".shell__navlink")).toEqual(["Cited"]);
  });

  test("the scoreboard stays current with a breakdown toggled open", async () => {
    // The nav marks a *section*, not a scope: expanding the theme breakdown puts
    // `byTheme=true` in the URL and must not un-highlight Scoreboard.
    const host = await mount();
    const router = routerOf(host);
    await router.navigate({
      to: "/",
      search: { segment: "global", byTheme: true, byProvider: false },
    });
    await sleep(LOADER_MS * 2);
    expect(currentLabels(host, ".shell__navlink")).toEqual(["Scoreboard"]);
  });
});

describe("the current option is announced, not only coloured", () => {
  test("it carries aria-current, which is what assistive tech reads", async () => {
    const host = await mount();
    await sampleAcrossClick(host, ".segctl__opt", "Unbranded", 400);
    const announced = [...host.querySelectorAll(".segctl__opt")]
      .filter((el) => el.getAttribute("aria-current"))
      .map((el) => el.textContent?.trim());
    expect(announced).toEqual(["Unbranded"]);
  });
});
