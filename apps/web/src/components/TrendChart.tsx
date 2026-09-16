// A reusable visx line chart for run-date trends — the dashboard is going chart-
// heavy, so the rank and share-of-voice trends share this one component. From the
// design language: thin lines, a sparse grid, a dimmed context field behind the
// highlighted series, and an interactive crosshair tooltip listing every series'
// value at the hovered run. Dark theme is inlined as hex (a future light theme
// would lift these to tokens, matching the v1 dark-only scope).
import { AxisBottom, AxisLeft } from "@visx/axis";
import { localPoint } from "@visx/event";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback } from "react";
import { tooltipRows } from "../lib/trend-chart-view";

export interface TrendSeries {
  label: string;
  /** Stroke for highlighted lines; dimmed lines use the neutral context color. */
  color: string;
  highlighted: boolean;
  /** One value per run, in `xLabels` order; null breaks the line (a gap). */
  values: (number | null)[];
  /** Pins this series to the top of the tooltip, ahead of the value sort, so the
   * {@link TOOLTIP_ROWS} cap can only ever drop other series. Used for the
   * brand's own line, whose value must stay readable at every rank — a series
   * that's always drawn but whose number can't be read isn't actually shown. */
  pinned?: boolean;
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 48 };
// Dark-theme chrome (mirrors the CSS tokens: --border, --fg-muted,
// --border-strong, --bg). SVG presentation attributes can't read CSS custom
// properties, so the values are inlined here in sync with styles.css.
const GRID = "#1d1f23";
const AXIS_TEXT = "#8a8f98";
const DIM_LINE = "#2a2d33";
const HALO = "#08090a";
/** Tooltip rows are capped so a 30-competitor SoV chart stays readable. */
const TOOLTIP_ROWS = 12;

interface Datum {
  i: number;
  v: number | null;
}

export function TrendChart({
  series,
  xLabels,
  xTooltipLabels,
  focusIndex,
  format,
  height = 300,
  ariaLabel,
}: {
  series: TrendSeries[];
  /** Compact x-axis tick labels (e.g. MM-DD). */
  xLabels: string[];
  /** Optional unambiguous labels (e.g. full dates) shown in the tooltip header;
   * defaults to `xLabels`. */
  xTooltipLabels?: string[];
  focusIndex: number;
  format: (v: number) => string;
  height?: number;
  ariaLabel?: string;
}) {
  return (
    <div className="comp__chartwrap" style={{ height }}>
      <ParentSize debounceTime={0}>
        {({ width }) =>
          width > 0 ? (
            <TrendChartInner
              series={series}
              xLabels={xLabels}
              xTooltipLabels={xTooltipLabels ?? xLabels}
              focusIndex={focusIndex}
              format={format}
              width={width}
              height={height}
              ariaLabel={ariaLabel}
            />
          ) : null
        }
      </ParentSize>
    </div>
  );
}

function TrendChartInner({
  series,
  xLabels,
  xTooltipLabels,
  focusIndex,
  format,
  width,
  height,
  ariaLabel,
}: {
  series: TrendSeries[];
  xLabels: string[];
  xTooltipLabels: string[];
  focusIndex: number;
  format: (v: number) => string;
  width: number;
  height: number;
  ariaLabel?: string;
}) {
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const n = xLabels.length;

  const xScale = scaleLinear({
    domain: [0, Math.max(1, n - 1)],
    range: [0, innerW],
  });
  const rawMax = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((v): v is number => v != null)),
  );
  const yMax = rawMax <= 0 ? 1 : rawMax * 1.1;
  const yScale = scaleLinear({
    domain: [0, yMax],
    range: [innerH, 0],
    nice: true,
  });

  const {
    showTooltip,
    hideTooltip,
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
  } = useTooltip<{ index: number }>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  const handleMove = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      const p = localPoint(e);
      if (!p) return;
      const i = Math.max(
        0,
        Math.min(n - 1, Math.round(xScale.invert(p.x - MARGIN.left))),
      );
      showTooltip({
        tooltipData: { index: i },
        tooltipLeft: MARGIN.left + xScale(i),
        tooltipTop: MARGIN.top,
      });
    },
    [n, xScale, showTooltip],
  );

  const reduceMotion = useReducedMotion();
  const dim = series.filter((s) => !s.highlighted);
  const hl = series.filter((s) => s.highlighted);
  const idx = tooltipOpen && tooltipData ? tooltipData.index : -1;

  const data = (s: TrendSeries): Datum[] => s.values.map((v, i) => ({ i, v }));
  const defined = (d: Datum) => d.v != null;
  const getX = (d: Datum) => xScale(d.i);
  const getY = (d: Datum) => yScale(d.v ?? 0);

  return (
    <>
      <svg
        ref={containerRef}
        width={width}
        height={height}
        className="comp__chart"
        role="img"
        aria-label={ariaLabel ?? "Trend over run dates"}
      >
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={yScale} width={innerW} numTicks={4} stroke={GRID} />
          <AxisLeft
            scale={yScale}
            numTicks={4}
            tickFormat={(v) => format(Number(v))}
            stroke={GRID}
            tickStroke={GRID}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "end",
              dx: -4,
              dy: 3,
            })}
          />
          <AxisBottom
            scale={xScale}
            top={innerH}
            tickValues={xLabels.map((_, i) => i)}
            tickFormat={(v) => xLabels[Number(v)] ?? ""}
            stroke={GRID}
            tickStroke={GRID}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "middle",
            })}
          />
          {focusIndex >= 0 && (
            <line
              x1={xScale(focusIndex)}
              x2={xScale(focusIndex)}
              y1={0}
              y2={innerH}
              stroke={AXIS_TEXT}
              strokeDasharray="3 3"
              opacity={0.5}
            />
          )}
          {idx >= 0 && (
            <line
              x1={xScale(idx)}
              x2={xScale(idx)}
              y1={0}
              y2={innerH}
              stroke={AXIS_TEXT}
              opacity={0.35}
            />
          )}
          {dim.map((s) => (
            <LinePath<Datum>
              key={s.label}
              data={data(s)}
              defined={defined}
              x={getX}
              y={getY}
              stroke={DIM_LINE}
              strokeWidth={1}
              opacity={0.7}
            />
          ))}
          {hl.map((s) => (
            // Draw-in: each highlighted line traces itself on mount via pathLength
            // (spec §9: "chart draw-in"). LinePath's render prop hands us the `d`
            // string so a motion.path can animate it; reduced motion renders it
            // already-drawn.
            <LinePath<Datum>
              key={s.label}
              data={data(s)}
              defined={defined}
              x={getX}
              y={getY}
            >
              {({ path }) => (
                <motion.path
                  d={path(data(s)) || ""}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  initial={reduceMotion ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              )}
            </LinePath>
          ))}
          {idx >= 0 &&
            hl.map((s) => {
              const v = s.values[idx];
              return v == null ? null : (
                <circle
                  key={s.label}
                  cx={xScale(idx)}
                  cy={yScale(v)}
                  r={3}
                  fill={s.color}
                  stroke={HALO}
                  strokeWidth={1}
                />
              );
            })}
          <rect
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={hideTooltip}
          />
        </Group>
      </svg>
      {tooltipOpen && idx >= 0 && (
        <TooltipInPortal
          left={tooltipLeft}
          top={tooltipTop}
          className="comp__tip"
          unstyled
        >
          <div className="comp__tiprun">{xTooltipLabels[idx]}</div>
          {tooltipRows(
            series.map((s) => ({
              label: s.label,
              color: s.highlighted ? s.color : DIM_LINE,
              v: s.values[idx],
              pinned: s.pinned,
            })),
            TOOLTIP_ROWS,
          ).map((r) => (
            <div key={r.label} className="comp__tiprow">
              <span className="comp__swatch" style={{ background: r.color }} />
              <span className="comp__tiplabel">{r.label}</span>
              <span className="comp__tipval">{format(r.v)}</span>
            </div>
          ))}
        </TooltipInPortal>
      )}
    </>
  );
}
