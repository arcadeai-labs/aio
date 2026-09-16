import type { ResultDetail, Segment } from "@aio/db";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Nav } from "../components/Nav";
import { fetchResultDetail } from "../lib/result";
import {
  hasText,
  hostOf,
  promptMetaFields,
  visibleCitations,
  visibleQueries,
  visibleSearchResults,
} from "../lib/result-view";
import { resolveUser } from "../lib/route-guard";
import { SEGMENT_LABEL, toSegment } from "../lib/segments";

// The single-result editorial reading view (issue #10, DASHBOARD_SPEC §8.3):
// every part of one (prompt × provider) result — the prompt and its metadata,
// the response, citations, search queries, search results, and the complete
// judge verdict. Sections a provider left empty render a muted "none" line, not
// a broken box.
// The segment the analyst was drilling in, threaded through so the back-link
// returns to the same scope rather than resetting to global. Optional — a
// directly-shared /result/$id URL just falls back to global.
interface ResultSearch {
  segment: Segment;
}

function validateSearch(search: Record<string, unknown>): ResultSearch {
  return { segment: toSegment(search.segment) };
}

export const Route = createFileRoute("/result/$id")({
  validateSearch,
  beforeLoad: resolveUser,
  loader: async ({ context, params }) => ({
    user: context.user,
    result: await fetchResultDetail({ data: { id: params.id } }),
  }),
  component: ResultDetailView,
});

const score = (n: number | null): string => (n === null ? "—" : `${n}/5`);
const yesNo = (v: boolean): string => (v ? "Yes" : "No");
const rankLabel = (rank: string): string =>
  rank === "not_ranked" ? "Not ranked" : rank;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rd__field">
      <span className="rd__label">{label}</span>
      <span className="rd__value">{value}</span>
    </div>
  );
}

// A section wrapper that owns the graceful-empty contract: when `empty`, it
// renders the heading plus a muted line instead of whatever children would be.
function Section({
  title,
  empty,
  emptyLabel,
  children,
}: {
  title: string;
  empty: boolean;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rd__section">
      <h2 className="rd__h2">{title}</h2>
      {empty ? <p className="rd__empty">{emptyLabel}</p> : children}
    </div>
  );
}

function ExternalLink({ url }: { url: string }) {
  return (
    <a
      className="rd__link"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
    >
      {hostOf(url)}
    </a>
  );
}

// A citation or search-result row: a title (when present), a link (only when the
// provider gave a url), and a snippet/excerpt (when present). Blank-only rows are
// filtered out upstream, so at least one piece always renders.
function SourceItem({
  title,
  url,
  body,
}: {
  title: string | null;
  url: string;
  body: string | null;
}) {
  return (
    <li className="rd__item">
      <div className="rd__itemhead">
        {hasText(title) && <span className="rd__itemtitle">{title}</span>}
        {hasText(url) && <ExternalLink url={url} />}
      </div>
      {hasText(body) && <p className="rd__snippet">{body}</p>}
    </li>
  );
}

function Verdict({
  verdict,
}: { verdict: NonNullable<ResultDetail["verdict"]> }) {
  return (
    <>
      <div className="rd__facts">
        <Field label="Mentioned" value={yesNo(verdict.mentioned)} />
        <Field label="Mentions" value={String(verdict.mentionCount)} />
        <Field label="Accuracy" value={score(verdict.accuracyScore)} />
        <Field label="Owned-cited" value={yesNo(verdict.ownedCited)} />
        <Field label="Competitive" value={yesNo(verdict.othersPresent)} />
        <Field label="Rank" value={rankLabel(verdict.brandRank)} />
        <Field label="Competitors" value={String(verdict.othersCount)} />
      </div>

      {verdict.accuracyReasoning && (
        <div className="rd__reason">
          <span className="rd__label">Accuracy reasoning</span>
          <p className="rd__body">{verdict.accuracyReasoning}</p>
        </div>
      )}

      {verdict.mentionHypothesis && (
        <div className="rd__reason">
          <span className="rd__label">Mention hypothesis</span>
          <p className="rd__body">{verdict.mentionHypothesis}</p>
        </div>
      )}

      {verdict.excerpts.length > 0 && (
        <div className="rd__reason">
          <span className="rd__label">Mention excerpts</span>
          <ul className="rd__excerpts">
            {verdict.excerpts.map((ex, i) => (
              // Excerpts are free text with no stable id; index is acceptable
              // for a static, never-reordered list.
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <li key={i} className="rd__excerpt">
                {ex}
              </li>
            ))}
          </ul>
        </div>
      )}

      {verdict.competitors.length > 0 && (
        <div className="rd__reason">
          <span className="rd__label">Competitors present</span>
          <div className="rd__chips">
            {verdict.competitors.map((c) => (
              <span key={c} className="rd__chip">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {verdict.ownedUrls.length > 0 && (
        <div className="rd__reason">
          <span className="rd__label">Owned URLs cited</span>
          <ul className="rd__list">
            {verdict.ownedUrls.map((url) => (
              <li key={url} className="rd__item">
                <ExternalLink url={url} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ResultDetailView() {
  const { user, result } = Route.useLoaderData();
  const { segment } = Route.useSearch();

  // Drop provider-supplied blank rows so the sections reflect real content (and
  // empty-state copy fires when only placeholders came back).
  const cites = result ? visibleCitations(result.citations) : [];
  const searches = result ? visibleSearchResults(result.searchResults) : [];
  const queries = result ? visibleQueries(result.searchQueries) : [];
  const metaFields = result ? promptMetaFields(result) : [];

  return (
    <main className="shell">
      <Nav active={null} segment={segment} email={user?.email} />

      <section className="rd">
        {!result ? (
          <p className="shell__placeholder">Result not found.</p>
        ) : (
          <>
            <div className="rd__head">
              <div className="rd__crumb">
                <Link
                  to="/run/$run/provider/$provider"
                  params={{ run: result.runDate, provider: result.provider }}
                  search={{ segment }}
                  className="shell__link"
                >
                  ← {result.provider} · {result.runDate}
                </Link>
              </div>
              <h1 className="rd__title">{result.promptText}</h1>
              <div className="rd__crumb">
                <Link
                  to="/prompt/$promptId"
                  params={{ promptId: result.promptId }}
                  search={{ segment }}
                  className="shell__link"
                >
                  View prompt trajectory →
                </Link>
              </div>
              <div className="rd__facts">
                <Field label="Run" value={result.runDate} />
                <Field label="Provider" value={result.provider} />
                <Field label="Model" value={result.model} />
                <Field label="Theme" value={result.theme ?? "Uncategorized"} />
                <Field
                  label="Segment"
                  value={
                    result.brandedType
                      ? (SEGMENT_LABEL[result.brandedType as Segment] ??
                        result.brandedType)
                      : "—"
                  }
                />
              </div>
              {metaFields.length > 0 && (
                <div className="rd__facts rd__facts--meta">
                  {metaFields.map((f) => (
                    <Field key={f.label} label={f.label} value={f.value} />
                  ))}
                </div>
              )}
            </div>

            <div className="rd__section">
              <h2 className="rd__h2">Response</h2>
              {result.hasError ? (
                <p className="rd__error">
                  {result.errorMessage ?? "This provider call errored."}
                </p>
              ) : result.responseText ? (
                <p className="rd__body">{result.responseText}</p>
              ) : (
                <p className="rd__empty">No response text.</p>
              )}
            </div>

            <Section
              title="Citations"
              empty={cites.length === 0}
              emptyLabel="This provider cited no sources."
            >
              <ul className="rd__list">
                {cites.map((c, i) => (
                  // URLs can repeat across citations with different excerpts, so
                  // pair the url with its index for a stable, unique key.
                  <SourceItem
                    key={`${c.url}-${i}`}
                    title={c.title}
                    url={c.url}
                    body={c.citedText}
                  />
                ))}
              </ul>
            </Section>

            <Section
              title="Search queries"
              empty={queries.length === 0}
              emptyLabel="This provider issued no search queries."
            >
              <ul className="rd__queries">
                {queries.map((q, i) => (
                  <li key={`${q.query}-${i}`} className="rd__query">
                    {q.query}
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="Search results"
              empty={searches.length === 0}
              emptyLabel="This provider surfaced no search results."
            >
              <ul className="rd__list">
                {searches.map((s, i) => (
                  <SourceItem
                    key={`${s.url}-${i}`}
                    title={s.title}
                    url={s.url}
                    body={s.snippet}
                  />
                ))}
              </ul>
            </Section>

            <Section
              title="Verdict"
              empty={result.verdict === null}
              emptyLabel={
                result.hasError
                  ? "No verdict — the provider call errored."
                  : "No verdict for this result."
              }
            >
              {result.verdict && <Verdict verdict={result.verdict} />}
            </Section>
          </>
        )}
      </section>
    </main>
  );
}
