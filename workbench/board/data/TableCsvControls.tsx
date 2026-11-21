import { useRef, useState } from "react";
import type { ViewProps } from "../views/registry.tsx";
import { csvMaxBytes, formatCsv, parseCsv } from "./csv.ts";
import { cellValue, columnNames, type TableData } from "./table-model.ts";

export function TableCsvControls({
  files,
  source,
  visible,
  title,
  readOnly,
}: {
  files: NonNullable<ViewProps["tableFiles"]>;
  source: TableData;
  visible: TableData;
  title: string;
  readOnly: boolean;
}) {
  const [preview, setPreview] = useState<{ title: string; table: TableData }>();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const readId = useRef(0);
  const failure = (reason: unknown) =>
    setMessage(reason instanceof Error ? reason.message : "暂时无法处理文件。");
  async function read(file?: File) {
    const id = ++readId.current;
    setPreview(undefined);
    setMessage("");
    if (!file) return;
    try {
      if (file.size > csvMaxBytes)
        throw Error("CSV 文件最多 1 MB，请拆分后导入。");
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw Error("无法读取此文件。请另存为 UTF-8 CSV 后重试。");
      }
      if (id !== readId.current) return;
      setPreview({
        title:
          file.name
            .replace(/\.(csv|tsv)$/i, "")
            .trim()
            .slice(0, 300) || "导入表格",
        table: parseCsv(text),
      });
    } catch (reason) {
      if (id === readId.current) failure(reason);
    }
  }
  async function insert() {
    if (!preview || saving || readOnly) return;
    setSaving(true);
    try {
      await files.create(preview.title, preview.table);
      setMessage(`已新建表格「${preview.title}」。`);
      setPreview(undefined);
    } catch (reason) {
      failure(reason);
    } finally {
      setSaving(false);
    }
  }
  const filename =
    (title
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .slice(0, 150) || "表格") + ".csv";
  function download(data: TableData) {
    if (files.download)
      void files.download(filename, formatCsv(data)).catch(failure);
  }
  return (
    <details>
      <summary>CSV 导入与导出</summary>
      {!readOnly && (
        <label>
          选择 CSV 或 TSV 文件
          <input
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            disabled={saving}
            onChange={(event) => {
              void read(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {files.download && (
        <div>
          <button
            type="button"
            disabled={!visible.columns.length}
            onClick={() => download(visible)}
          >
            导出当前视图
          </button>
          <button
            type="button"
            disabled={!source.columns.length}
            onClick={() => download(source)}
          >
            导出全部数据
          </button>
        </div>
      )}
      {preview && (
        <div aria-label="CSV 导入预览" role="region">
          <p>
            {preview.title} · {preview.table.rows.length} 行 · 前{" "}
            {Math.min(20, preview.table.rows.length)} 行预览
          </p>
          <table>
            <thead>
              <tr>
                {preview.table.columns.map(({ key, label, type }) => (
                  <th scope="col" key={key}>
                    {label}（{columnNames[type]}）
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.table.rows.slice(0, 20).map((row) => (
                <tr key={row.key}>
                  {preview.table.columns.map(({ key }) => (
                    <td key={key}>{String(cellValue(row, key) ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" disabled={saving} onClick={() => void insert()}>
            确认新建表格
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setPreview(undefined)}
          >
            取消导入
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
