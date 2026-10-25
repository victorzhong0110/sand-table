import { useEffect, useRef, useState } from "react";
import { v3DataOf } from "../data-client/adapter.ts";
import { editIntent, endEditSession } from "../edit-session.ts";
import type { Board } from "../data-client/model.ts";
import type { ComponentInstance } from "../data-client/spaces.ts";
import { useTypeCatalog } from "./catalog.tsx";
import {
  fieldLabel,
  packIdOf,
  type JsonSchema,
  type TypeSpecView,
} from "./format.ts";
import { OtherFields } from "./OtherFields.tsx";
import { RelationSlots, type SlotLink } from "./RelationSlots.tsx";
import { propertyEntries, widgetFor } from "./registry.tsx";
import { UnknownType } from "./UnknownType.tsx";

type ToolError = { code: string; message: string };

export function GenericForm({
  instance,
  board,
  call,
  operate,
  onOpenSettings,
}: {
  instance: ComponentInstance;
  board: Board;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  operate: (op: any) => Promise<any>;
  onOpenSettings?: () => void;
}) {
  const catalog = useTypeCatalog();
  const kernelType = instance.kernelType || instance.type;
  const spec = catalog.specs.get(kernelType);
  const objectId = instance.objectId || "";
  const content = board.contentObjects.find((item) => item.id === objectId);
  const [title, setTitle] = useState(content?.title || instance.title);
  const titleRef = useRef(content?.title || instance.title);
  const serverTitle = useRef(content?.title || instance.title);
  serverTitle.current = content?.title || instance.title;
  const [data, setData] = useState<Record<string, unknown>>(() =>
    v3DataOf(kernelType, instance.data ?? {}),
  );
  const [migrationError, setMigrationError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const version = useRef<number | undefined>(content?.version);
  /** 这次输入开始时看到的版本。别人先写了，保存仍用这个版本才会报冲突。 */
  const editVersion = useRef<number | undefined>(undefined);
  const epoch = useRef(0);
  /** 刚保存过。用户再改之前，失焦和计时器不要把旧标题又写一遍。 */
  const hold = useRef(false);
  const startTitle = useRef(content?.title || instance.title);
  const edits = useRef<Record<string, unknown | undefined>>({});
  const timer = useRef(0);
  const titleDirty = useRef(false);
  /** 串起保存：后一次等前一次写完再看草稿，避免同一笔修改打出两次。 */
  const tail = useRef(Promise.resolve());
  const callRef = useRef(call);
  callRef.current = call;

  useEffect(() => {
    let cancelled = false;
    if (!objectId) return;
    void callRef
      .current("sand_read", { ids: [objectId], include: ["relations"] })
      .then((result) => {
        if (cancelled) return;
        const row = (result?.objects ?? []).find(
          (item: { id?: string }) => item?.id === objectId,
        );
        if (!row) return;
        setMigrationError(
          typeof row.migrationError === "string" ? row.migrationError : "",
        );
        if (Object.keys(edits.current).length || titleDirty.current) return;
        if (
          typeof row.version === "number" &&
          row.version !== version.current
        ) {
          clearTimeout(timer.current);
          timer.current = 0;
        }
        if (typeof row.version === "number") version.current = row.version;
        if (typeof row.title === "string") {
          startTitle.current = row.title;
          titleRef.current = row.title;
          setTitle(row.title);
        }
        if (row.data && typeof row.data === "object")
          setData({ ...(row.data as Record<string, unknown>) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [objectId, content?.version]);

  useEffect(() => {
    epoch.current += 1;
    if (Object.keys(edits.current).length || titleDirty.current) return;
    clearTimeout(timer.current);
    timer.current = 0;
  }, [content?.version]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => () => endEditSession(instance.id), [instance.id]);

  const readOnlyData = Boolean(migrationError) || !spec;
  const captureVersion = () => {
    if (editVersion.current !== undefined) return;
    const current = version.current ?? content?.version;
    if (current !== undefined) editVersion.current = current;
  };
  const commit = async (overrideVersion?: number, manual = false) => {
    if (hold.current && !manual) return;
    const seen = epoch.current;
    clearTimeout(timer.current);
    timer.current = 0;
    const sent = { ...edits.current };
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(sent)) {
      if (value === undefined) unset.push(key);
      else set[key] = value;
    }
    const sentTitle = titleDirty.current ? titleRef.current : undefined;
    const nextTitle =
      sentTitle !== undefined && sentTitle !== serverTitle.current
        ? sentTitle
        : undefined;
    if (!unset.length && !Object.keys(set).length && nextTitle === undefined)
      return;
    if (!manual && epoch.current !== seen) return;
    const usedVersion =
      overrideVersion ?? editVersion.current ?? version.current;
    const result = await operate({
      kind: "fields",
      instanceId: instance.id,
      intentId: editIntent(instance.id),
      reportError: true,
      ...(usedVersion !== undefined ? { expectedVersion: usedVersion } : {}),
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(Object.keys(set).length ? { set } : {}),
      ...(unset.length ? { unset } : {}),
    });
    const error = result?.error as ToolError | undefined;
    if (error?.code === "VERSION_CONFLICT") {
      setConflict(true);
      return;
    }
    if (error) return;
    setConflict(false);
    const warningMap: Record<string, string> = {};
    for (const warning of result?.warnings ?? []) {
      const path = typeof warning?.path === "string" ? warning.path : "";
      const key = path.split("/").filter(Boolean)[0];
      if (key && typeof warning?.message === "string")
        warningMap[key] = warning.message;
    }
    setWarnings(warningMap);
    if (sentTitle !== undefined && titleRef.current === sentTitle) {
      startTitle.current = sentTitle;
      titleDirty.current = false;
    }
    const written = (result?.changed ?? []).find(
      (item: { table?: string; id?: string; version?: number }) =>
        item?.table === "objects" &&
        item.id === objectId &&
        typeof item.version === "number",
    );
    version.current =
      typeof written?.version === "number"
        ? written.version
        : typeof usedVersion === "number"
          ? usedVersion + 1
          : version.current;
    editVersion.current = undefined;
    for (const key of Object.keys(sent)) {
      if (edits.current[key] === sent[key]) delete edits.current[key];
    }
    const pending = Object.keys(edits.current).length > 0 || titleDirty.current;
    hold.current = !pending;
    setData((current) => {
      const nextData = { ...current };
      for (const key of unset) delete nextData[key];
      return { ...nextData, ...set };
    });
    if (pending) schedule();
  };
  const flush = (overrideVersion?: number, manual = false) => {
    const job = tail.current.then(() => commit(overrideVersion, manual));
    tail.current = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };

  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };

  const changeField = (key: string, next: unknown | undefined) => {
    hold.current = false;
    captureVersion();
    edits.current = { ...edits.current, [key]: next };
    setData((current) => {
      const copy = { ...current };
      if (next === undefined) delete copy[key];
      else copy[key] = next;
      return copy;
    });
    schedule();
  };

  const overwrite = async () => {
    const fresh = await call("sand_read", { ids: [objectId] });
    const row = (fresh?.objects ?? []).find(
      (item: { id?: string }) => item?.id === objectId,
    );
    const nextVersion =
      typeof row?.version === "number" ? row.version : undefined;
    if (nextVersion === undefined) return;
    version.current = nextVersion;
    editVersion.current = nextVersion;
    await flush(nextVersion, true);
  };

  const discard = async () => {
    clearTimeout(timer.current);
    edits.current = {};
    titleDirty.current = false;
    editVersion.current = undefined;
    setConflict(false);
    const fresh = await call("sand_read", { ids: [objectId] });
    const row = (fresh?.objects ?? []).find(
      (item: { id?: string }) => item?.id === objectId,
    );
    if (!row) return;
    if (typeof row.version === "number") version.current = row.version;
    if (typeof row.title === "string") {
      startTitle.current = row.title;
      titleRef.current = row.title;
      setTitle(row.title);
    }
    setData(
      row.data && typeof row.data === "object"
        ? { ...(row.data as Record<string, unknown>) }
        : {},
    );
    endEditSession(instance.id);
  };

  const links = slotLinks(board, objectId, spec);
  const pack = catalog.packs.find((item) => item.id === packIdOf(kernelType));

  if (catalog.ready && !spec)
    return (
      <UnknownType
        title={title}
        typeName={kernelType}
        packTitle={pack?.title || ""}
        data={data}
        readOnly
        onOpenSettings={onOpenSettings}
      />
    );

  return (
    <section className="component-editor generic-form">
      <h3>配置</h3>
      {migrationError && (
        <p role="status" className="migration-error">
          {migrationError}
        </p>
      )}
      {conflict && (
        <div className="version-conflict" role="status">
          <p>这个对象刚被别人改过</p>
          <button type="button" onClick={() => void overwrite()}>
            用我的覆盖
          </button>
          <button type="button" onClick={() => void discard()}>
            放弃我的修改
          </button>
        </div>
      )}
      <label>
        {kernelType === "novel.character" ? "姓名" : "名称"}
        <input
          aria-label={
            kernelType === "novel.character" ? "姓名" : "编辑组件名称"
          }
          value={title}
          onChange={(event) => {
            hold.current = false;
            captureVersion();
            titleDirty.current = true;
            titleRef.current = event.target.value;
            setTitle(event.target.value);
            schedule();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            clearTimeout(timer.current);
            titleDirty.current = false;
            titleRef.current = startTitle.current;
            setTitle(startTitle.current);
            event.currentTarget.blur();
          }}
          onBlur={() => {
            void flush();
          }}
        />
      </label>
      {propertyEntries(spec?.schema).map(([key, schema]) => (
        <Field
          key={key}
          name={key}
          schema={schema}
          required={required(spec, key)}
          value={data[key]}
          warning={warnings[key]}
          readOnly={readOnlyData}
          ariaLabel={
            kernelType === "base.note" && key === "body" ? "内容" : undefined
          }
          onChange={(next) => changeField(key, next)}
          onBlur={() => {
            void flush();
          }}
        />
      ))}
      <RelationSlots
        slots={spec?.relationSlots ?? []}
        linksBySlot={links}
        readOnly={readOnlyData}
        selfId={objectId}
        call={call}
        onChange={(change) =>
          void operate({
            kind: "slot",
            intentId: editIntent(instance.id),
            removeIds: change.removeIds,
            ...(change.create ? { create: change.create } : {}),
          })
        }
      />
      <OtherFields data={data} spec={spec} />
      <p className="save-hint">
        停止输入约 1 秒后自动写入，也可以点「保存组件」立即写入。
      </p>
      <button type="button" onClick={() => void flush(undefined, true)}>
        保存组件
      </button>
    </section>
  );
}

function required(spec: TypeSpecView | undefined, key: string): boolean {
  return Boolean(spec?.schema?.required?.includes(key));
}

function Field({
  name,
  schema,
  required: must,
  value,
  warning,
  readOnly,
  ariaLabel,
  onChange,
  onBlur,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  warning?: string;
  readOnly: boolean;
  ariaLabel?: string;
  onChange: (next: unknown | undefined) => void;
  onBlur: () => void;
}) {
  const label = fieldLabel(name, schema);
  const Editor = widgetFor(schema).Editor;
  return (
    <label onBlur={onBlur}>
      {label}
      {must ? <span aria-hidden="true"> *</span> : null}
      <Editor
        value={value}
        schema={schema}
        label={label}
        ariaLabel={ariaLabel}
        readOnly={readOnly}
        onChange={onChange}
      />
      {warning && <small className="field-warning">{warning}</small>}
    </label>
  );
}

function slotLinks(
  board: Board,
  objectId: string,
  spec: TypeSpecView | undefined,
): Record<string, SlotLink[]> {
  const grouped: Record<string, SlotLink[]> = {};
  for (const slot of spec?.relationSlots ?? []) {
    grouped[slot.key] = [];
    for (const relation of board.objectRelations) {
      if ((relation.kernelKind || relation.kind) !== slot.kind) continue;
      const mine = slot.direction === "out" ? relation.source : relation.target;
      const other =
        slot.direction === "out" ? relation.target : relation.source;
      if (mine !== objectId) continue;
      const object = board.contentObjects.find((item) => item.id === other);
      grouped[slot.key].push({
        id: relation.id,
        otherId: other,
        title: object?.title || "未命名",
      });
    }
  }
  return grouped;
}
