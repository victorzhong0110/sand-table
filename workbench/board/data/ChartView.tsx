import { useEffect, useMemo, useRef, useState } from "react";
import type { EChartsType, init } from "echarts/core";
import { useComponentRuntime } from "../runtime/resources.ts";
import type { ViewProps } from "../views/registry.tsx";
import {
  chartAggregates,
  chartKinds,
  chartOf,
  chartOptions,
  initialMapping,
  pointKeys,
  seriesFor,
  type ChartConfig,
  type ChartKind,
} from "./chart-config.ts";
import { useDerivedTableSource } from "./use-table-source.ts";

import { signalChartFocus, useLinkedChartFocus } from "./chart-linkage.ts";
import { useViewSave } from "./use-view-save.ts";

export function ChartView(props: ViewProps) {
  const { object, readOnly, bindings, workspaceId, presentation } = props;
  const { save: edit, error: editError, disabled } = useViewSave(props);
  const runtime = useComponentRuntime();
  const frame = useRef<HTMLDivElement>(null);
  const {
    source,
    table,
    reading,
    error: bindingError,
  } = useDerivedTableSource(bindings);
  const [chartError, setChartError] = useState("");
  const config = chartOf(object.data);
  const chartKey = JSON.stringify(config);
  const tableId = source?.id;
  const { received, unmatched } = useLinkedChartFocus(
    bindings,
    workspaceId,
    tableId,
  );
  const liveChart = useRef<EChartsType | undefined>(undefined);
  const redrawFocus = useRef<(keys: string[]) => void>(() => {});
  const latestFocus = useRef(received);
  latestFocus.current = received;
  const [selected, setSelected] = useState<string[]>([]);
  const [brushing, setBrushing] = useState(false);
  useEffect(() => redrawFocus.current(received), [received]);

  useEffect(() => {
    const node = frame.current;
    if (reading || bindingError || !node) return;
    const controller = new AbortController();
    let chart: EChartsType | undefined;
    let resize: ResizeObserver | undefined;
    let brushedKeys: string[] = [];
    const signal = (keys: string[]) => {
      if (tableId)
        signalChartFocus({
          workspace: workspaceId,
          chart: object.id,
          presentation: presentation.id,
          table: tableId,
          keys,
        });
    };
    void (async () => {
      try {
        const settings = JSON.parse(chartKey) as ChartConfig;
        const data = seriesFor(settings, table);
        if (!runtime) throw Error("当前宿主无法加载图表组件。");
        await runtime.loadComponentResource("charts", controller.signal);
        controller.signal.throwIfAborted();
        const module = (
          globalThis as { sandTableChart?: { init: typeof init } }
        ).sandTableChart;
        if (!module) throw Error("图表资源加载失败。");
        const style = getComputedStyle(node);
        chart = module.init(node, undefined, { renderer: "canvas" });
        liveChart.current = chart;
        const ink = style.getPropertyValue("--ink").trim();
        const accent = style.getPropertyValue("--accent").trim();
        const options = (keys: string[]) =>
          chartOptions(settings, data, ink, accent, new Set(keys));
        chart.setOption(options(latestFocus.current));
        redrawFocus.current = (keys) =>
          chart?.setOption({ series: options(keys).series });
        const keysAt = (series: number, index: number) => {
          const point = data.series[series]?.values[index];
          return point ? pointKeys(point) : [];
        };
        chart.on("mouseover", "series", ({ seriesIndex, dataIndex }) => {
          if (typeof seriesIndex === "number" && typeof dataIndex === "number")
            signal(keysAt(seriesIndex, dataIndex));
        });
        chart.on("mouseout", "series", () => signal(brushedKeys));
        chart.on("globalout", () => signal(brushedKeys));
        chart.on("brushSelected", (event) => {
          const { batch } = event as unknown as {
            batch?: {
              selected: { seriesIndex: number; dataIndex: number[] }[];
            }[];
          };
          brushedKeys = [
            ...new Set(
              (batch?.[0]?.selected ?? []).flatMap(
                ({ seriesIndex, dataIndex }) =>
                  dataIndex.flatMap((index) => keysAt(seriesIndex, index)),
              ),
            ),
          ];
          setSelected(brushedKeys);
          signal(brushedKeys);
        });
        resize = new ResizeObserver(() => chart?.resize());
        resize.observe(node);
        setChartError("");
      } catch (error) {
        if (!controller.signal.aborted)
          setChartError(
            error instanceof Error ? error.message : "暂时无法生成图表。",
          );
      }
    })();
    return () => {
      controller.abort();
      resize?.disconnect();
      signal([]);
      liveChart.current = undefined;
      redrawFocus.current = () => {};
      chart?.dispose();
    };
  }, [
    runtime,
    chartKey,
    table,
    tableId,
    object.id,
    presentation.id,
    workspaceId,
    reading,
    bindingError,
  ]);
  useEffect(() => {
    setSelected([]);
    setBrushing(false);
  }, [tableId]);
  function toggleBrush() {
    const chart = liveChart.current;
    if (!chart) return;
    if (brushing) chart.dispatchAction({ type: "brush", areas: [] });
    chart.dispatchAction({
      type: "takeGlobalCursor",
      key: "brush",
      brushOption: {
        brushType: brushing ? false : "lineX",
        brushMode: "single",
      },
    });
    setBrushing(!brushing);
  }

  const mapping =
    config.mapping ?? (table ? initialMapping(table.columns) : undefined);
  return (
    <section className="nodrag nowheel nopan" aria-label="图表">
      {config.title && <strong>{config.title}</strong>}
      {reading && <p role="status">正在读取源表格…</p>}
      {!reading && (bindingError || chartError) && (
        <p role="status">{bindingError || chartError}</p>
      )}
      {table?.configurationErrors.map((error) => (
        <p role="status" key={error}>
          {error}
        </p>
      ))}
      {!reading && !source && Boolean(config.legacyPoints?.length) && (
        <p>当前显示原有数据点。绑定表格后将改用表格数据，原数据点仍保留。</p>
      )}
      <div
        ref={frame}
        aria-label={chartKinds[config.kind]}
        style={{
          width: "100%",
          height: 160,
          visibility: bindingError || chartError ? "hidden" : "visible",
        }}
      />
      {table && !bindingError && !chartError && (
        <div>
          <button type="button" aria-pressed={brushing} onClick={toggleBrush}>
            {brushing ? "结束框选" : "框选横轴范围"}
          </button>
          {selected.length > 0 && !readOnly && (
            <button
              type="button"
              disabled={disabled}
              onClick={async () => {
                if (await edit({ rowScope: selected })) {
                  setSelected([]);
                  setBrushing(false);
                }
              }}
            >
              只看这一段
            </button>
          )}
          {config.rowScope && !readOnly && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void edit({}, ["rowScope"])}
            >
              显示全部行
            </button>
          )}
          {received.length > 0 && (
            <output aria-label="联动高亮行数">{received.length}</output>
          )}
          {unmatched && <p role="status">部分联动图表未绑定同一张源表。</p>}
          {source?.chartScopes?.some(({ keys }) => keys !== null) && (
            <p>正在应用同源图表的选区，显示 {table.rows.length} 行。</p>
          )}
        </div>
      )}
      {!readOnly && (
        <details>
          <summary>配置图表</summary>
          <input
            key={config.title}
            aria-label="图表标题"
            defaultValue={config.title ?? ""}
            maxLength={200}
            onBlur={(event) => {
              if (event.target.value !== (config.title ?? ""))
                void edit({ title: event.target.value });
            }}
          />
          <select
            aria-label="图表类型"
            value={config.kind}
            onChange={(event) =>
              void edit({ kind: event.target.value as ChartKind })
            }
          >
            {Object.entries(chartKinds).map(([kind, name]) => (
              <option key={kind} value={kind}>
                {name}
              </option>
            ))}
          </select>
          {table && mapping && (
            <>
              <select
                aria-label="图表聚合方式"
                value={config.aggregation ?? "none"}
                disabled={disabled}
                onChange={(event) =>
                  void edit({ aggregation: event.target.value })
                }
              >
                {Object.entries(chartAggregates).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={config.showLegend ?? mapping.y.length > 1}
                  disabled={disabled}
                  onChange={(event) =>
                    void edit({ showLegend: event.target.checked })
                  }
                />
                显示图例
              </label>
              <select
                aria-label="横轴列"
                value={mapping.x}
                onChange={(event) =>
                  void edit({ mapping: { ...mapping, x: event.target.value } })
                }
              >
                {table.columns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </select>
              <select
                multiple
                aria-label="数值列"
                value={mapping.y}
                onChange={(event) =>
                  void edit({
                    mapping: {
                      ...mapping,
                      y: [...event.target.selectedOptions].map(
                        ({ value }) => value,
                      ),
                    },
                  })
                }
              >
                {table.columns
                  .filter((column) => column.type === "number")
                  .map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label}
                    </option>
                  ))}
              </select>
            </>
          )}
          {editError && <p role="status">{editError}</p>}
        </details>
      )}
    </section>
  );
}
