import { useRef, useState } from "react";
import type { ViewProps } from "../views/registry.tsx";

export function useViewSave({ object, dispatch, readOnly }: ViewProps) {
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(set: Record<string, unknown>, unset: string[] = []) {
    if (lock.current || readOnly) return false;
    lock.current = true;
    setSaving(true);
    try {
      await dispatch([
        {
          op: "object.update",
          id: object.id,
          expectedVersion: object.version,
          set,
          unset,
        },
      ]);
      setError("");
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "这次修改未保存，请重试。",
      );
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return { disabled: saving || readOnly, error, save };
}
