import { useEffect, useMemo, useRef, useState } from "react";
import type { EChartsType, init } from "echarts/core";
import type { BindingItem } from "../../kernel/index.ts";
import { useComponentRuntime } from "../runtime/resources.ts";
import type { ViewProps } from "../views/registry.tsx";
import {
  chartKinds,
  chartOf,
  chartOptions,
  initialMapping,
  seriesFor,
  type ChartConfig,
  type ChartKind,
} from "./chart-config.ts";
import { tableOf } from "./table-model.ts";
import { deriveTable, tableViewOf } from "./derive-table.ts";

export function ChartView({ object, readOnly, dispatch, bindings }: ViewProps) {
  const runtime = useComponentRuntime();
  const frame = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<BindingItem>();
  const [reading, setReading] = useState(true);
  const [bindingError, setBindingError] = useState("");
  const [chartError, setChartError] = useState("");
  const [editError, setEditError] = useState("");
  const config = chartOf(object.data);
  const table = useMemo(
    () =>
      source && !source.migrationError
        ? deriveTable(tableOf(source.data), tableViewOf(source.data))
        : undefined,
    [source],
  );
  const chartKey = JSON.stringify(config);

  useEffect(() => {
    let serial = 0,
      active = true;
    async function refresh() {
      const current = ++serial;
      try {
        const { items } = await bindings.read("source");
        if (!active || current !== serial) return;
        const item = items[0];
        setSource(item);
        setBindingError(
          item?.migrationError ||
            (item?.unavailable
              ? /已删除|被删除/.test(item.unavailable)
                ? "绑定的表格已删除。"
                : item.unavailable
              : ""),
        );
      } catch (error) {
        if (!active || current !== serial) return;
        setBindingError(
          error instanceof Error ? error.message : "暂时读取不到源表格。",
        );
      } finally {
        if (active && current === serial) setReading(false);
      }
    }
    const stop = bindings.subscribe("source", () => void refresh());
    void refresh();
    return () => {
      active = false;
      stop();
    };
  }, [bindings]);

  useEffect(() => {
    const node = frame.current;
    if (reading || bindingError || !node) return;
    const controller = new AbortController();
    let chart: EChartsType | undefined;
    let resize: ResizeObserver | undefined;
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
        chart.setOption(
          chartOptions(
            settings,
            data,
            style.getPropertyValue("--ink").trim(),
            style.getPropertyValue("--accent").trim(),
          ),
        );
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
      chart?.dispose();
    };
  }, [runtime, chartKey, table, reading, bindingError]);

  async function edit(set: Record<string, unknown>) {
    try {
      await dispatch([
        {
          op: "object.update",
          id: object.id,
          expectedVersion: object.version,
          set,
        },
      ]);
      setEditError("");
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : "图表配置暂未保存。",
      );
    }
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
