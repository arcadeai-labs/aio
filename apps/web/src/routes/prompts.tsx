import type { PromptListItem, Segment } from "@aio/db";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { HeatStrip } from "../components/HeatStrip";
import { Nav } from "../components/Nav";
import { fetchPromptList } from "../lib/prompt";
import { resolveUser } from "../lib/route-guard";
import { SEGMENTS, SEGMENT_LABEL, toSegment } from "../lib/segments";
import { PROMPT_THEME_ALL, count, pct } from "../lib/trajectory-view";

// Segment, the active run, and the theme scope all change what the server returns
// (which prompts are listed + the theme options), so all three live in the URL
// (shareable, re-scopable) and are loader deps. The text filter and sort are local
// list controls over already-fetched rows. Mirrors the Cited/Competitive views.
interface PromptsSearch {
  segment: Segment;
  run?: string;
  theme: string;
}

function validateSearch(search: Record<string, unknown>): PromptsSearch {
  return {
    segment: toSegment(search.segment),
    run: typeof search.run === "string" ? search.run : undefined,
    theme: typeof search.theme === "string" ? search.theme : PROMPT_THEME_ALL,
  };
}

export const Route = createFileRoute("/prompts")({
  validateSearch,
  beforeLoad: resolveUser,
  loaderDeps: ({ search }) => ({
    segment: search.segment,
    run: search.run,
    theme: search.theme,
  }),
  loader: async ({ context, deps }) => ({
    user: context.user,
    view: await fetchPromptList({
      data: { segment: deps.segment, run: deps.run, theme: deps.theme },
    }),
  }),
  component: Prompts,
});

type SortKey = "prompt" | "theme" | "rate";
type SortDir = "asc" | "desc";

function Prompts() {
  const { user, view } = Route.useLoaderData();
  const { segment, theme } = Route.useSearch();
  const {
    activeRunDate,
    activeRunIndex,
    runDates,
    runDatesDesc,
    themes,
    prompts,
    total,
  } = view;

  const [query, setQuery] = useState("");
  // Default matches the server order (lowest active-run mention rate first).
  const [sortKey, setSortKey] = useState<SortKey>("rate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text columns read best A→Z; the rate column reads best low→high.
      setSortDir("asc");
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? prompts.filter((p) => p.text.toLowerCase().includes(q))
      : prompts;
    const dir = sortDir === "asc" ? 1 : -1;
    const byText = (a: PromptListItem, b: PromptListItem) =>
      a.text.localeCompare(b.text);
    return [...filtered].sort((a, b) => {
      if (sortKey === "prompt") return dir * byText(a, b);
      if (sortKey === "theme") {
        const at = a.theme ?? "";
        const bt = b.theme ?? "";
        return at !== bt ? dir * at.localeCompare(bt) : byText(a, b);
      }
      // rate: null (absent from the active run) always sorts last, regardless of dir.
      const ar = a.activeRate;
      const br = b.activeRate;
      if (ar == null && br == null) return byText(a, b);
      if (ar == null) return 1;
      if (br == null) return -1;
      return ar !== br ? dir * (ar - br) : byText(a, b);
    });
  }, [prompts, query, sortKey, sortDir]);

  const themeLabel =
    theme === PROMPT_THEME_ALL ? "all themes" : `theme: ${theme}`;

  return (
    <main className="shell">
      <Nav active="prompts" segment={segment} email={user?.email} />

      <section className="comp">
        <div className="comp__head">
          <div className="comp__crumb">
            <Link
              to="/"
              search={{ segment, byTheme: false, byProvider: false }}
              className="shell__link"
            >
              ← Scoreboard
            </Link>
          </div>
          <h1 className="comp__title">Prompts</h1>
          <span className="comp__meta">
            {SEGMENT_LABEL[segment]} segment · {themeLabel}
            {activeRunDate ? (
              <>
                {" "}
                · <span className="comp__den">{count(total)}</span> prompts in
                run <span className="comp__rundate">{activeRunDate}</span> ·
                trend = mention rate per run (gaps where absent)
              </>
            ) : null}
          </span>

          <div className="comp__controls">
            <div className="comp__segctl">
              {SEGMENTS.map((s) => (
                <Link
                  key={s}
                  from={Route.fullPath}
                  // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
                  search={(prev: any) => ({ ...prev, segment: s })}
                  className={
                    s === segment ? "comp__seg comp__seg--active" : "comp__seg"
                  }
                  aria-current={s === segment ? "true" : undefined}
                >
                  {SEGMENT_LABEL[s]}
                </Link>
              ))}
            </div>

            <ScopeSelect
              label="Theme"
              value={theme}
              options={[
                [PROMPT_THEME_ALL, "All themes"],
                ...themes.map((t) => [t, t] as [string, string]),
              ]}
              param="theme"
            />

            {runDatesDesc.length > 0 && (
              <ScopeSelect
                label="Active run"
                value={activeRunDate ?? ""}
                options={runDatesDesc.map((d) => [d, d] as [string, string])}
                param="run"
              />
            )}

            <label className="comp__filter">
              <span className="comp__filterlabel">Find</span>
              <input
                type="search"
                className="comp__select prompts__search"
                placeholder="Filter prompt text…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
        </div>

        {runDatesDesc.length === 0 ? (
          <p className="shell__placeholder">No runs ingested yet.</p>
        ) : prompts.length === 0 ? (
          <p className="shell__placeholder">
            No prompts in the {SEGMENT_LABEL[segment]} segment
            {theme === PROMPT_THEME_ALL ? "" : ` · ${theme}`} for run{" "}
            {activeRunDate}. Try another scope.
          </p>
        ) : (
          <div className="comp__tablewrap">
            <div className="prompts__count">
              {visible.length} of {prompts.length}
              {total > prompts.length
                ? ` (top ${prompts.length} of ${total})`
                : ""}
            </div>
            <table className="comp__table prompts__table">
              <thead>
                <tr>
                  <SortHeader
                    label="Prompt"
                    col="prompt"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <SortHeader
                    label="Theme"
                    col="theme"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <th className="comp__num prompts__trendhead">
                    Trend · mention rate / run
                  </th>
                  <SortHeader
                    label={`Mention rate · ${activeRunDate ?? "run"}`}
                    col="rate"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                    numeric
                    title="Fraction of providers that mentioned the brand for this prompt in the active run"
                  />
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <PromptRow
                    key={p.promptId}
                    prompt={p}
                    segment={segment}
                    runDates={runDates}
                    activeRunIndex={activeRunIndex}
                  />
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <p className="themes__empty">No prompts match “{query}”.</p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

// A clickable column header that drives the client-side sort: click to sort by
// this column, click again to flip direction. Mirrors the drill-down's SortHeader.
function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  numeric,
  title,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  title?: string;
}) {
  const active = sortKey === col;
  const caret = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={numeric ? "comp__num" : undefined} title={title}>
      <button
        type="button"
        className={active ? "dd__sort dd__sort--active" : "dd__sort"}
        onClick={() => onSort(col)}
        aria-sort={
          active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
        }
      >
        {label}
        {caret}
      </button>
    </th>
  );
}

function PromptRow({
  prompt,
  segment,
  runDates,
  activeRunIndex,
}: {
  prompt: PromptListItem;
  segment: Segment;
  runDates: string[];
  activeRunIndex: number;
}) {
  return (
    <tr className="comp__row">
      <td className="prompts__text">
        <Link
          to="/prompt/$promptId"
          params={{ promptId: prompt.promptId }}
          search={{ segment }}
          className="prompts__link"
          title={prompt.text}
        >
          {prompt.text}
        </Link>
      </td>
      <td className="prompts__theme">{prompt.theme ?? "—"}</td>
      <td className="comp__num prompts__spark">
        <HeatStrip
          values={prompt.mentionRate}
          runDates={runDates}
          activeIndex={activeRunIndex}
          ariaLabel={`Mention-rate trend for: ${prompt.text}`}
        />
      </td>
      <td className="comp__num comp__num--key">{pct(prompt.activeRate)}</td>
    </tr>
  );
}

// A labeled <select> that navigates by patching one search param, preserving the
// rest. Same pattern as the Cited/Competitive views' ScopeSelect.
function ScopeSelect({
  label,
  value,
  options,
  param,
}: {
  label: string;
  value: string;
  options: [string, string][];
  param: "theme" | "run";
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <label className="comp__filter">
      <span className="comp__filterlabel">{label}</span>
      <select
        className="comp__select"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          void navigate({
            // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
            search: (prev: any) => ({ ...prev, [param]: next }),
          });
        }}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
