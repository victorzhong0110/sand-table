// One editing session per component instance.
//
// A session is a run of continuous typing. The property panel's auto-save and
// the canvas's inline edit share the same token for the same instance, so the
// server merges everything typed in that session into **one** history step
// (issue #9: "一次连续输入算一步").
//
// The token changes when the session ends: the field loses focus, the person
// presses Esc, or they move to another component. Coming back later is a new
// intent and therefore a new step.
//
// The format is `edit:<instanceId>:<token>` — the same string the server sees
// on every update op of that session.
let counter = 0;
const tokens = new Map<string, string>();

/** The intent for the instance's current editing session. */
export function editIntent(instanceId: string) {
  let token = tokens.get(instanceId);
  if (!token) {
    token = `s${++counter}`;
    tokens.set(instanceId, token);
  }
  return `edit:${instanceId}:${token}`;
}

/** End the session: the next edit is a new intent and therefore a new step. */
export function endEditSession(instanceId: string) {
  tokens.set(instanceId, `s${++counter}`);
}

/** A fresh token for one drag, so a drag is one intent and one history step. */
export function dragIntent(instanceId: string) {
  return `move:${instanceId}:d${++counter}`;
}

// —— Unsaved input (drafts) ——
//
// The auto-save writes 600ms after the person stops typing, but the input
// must survive more than that: leaving the component (or the panel) before
// the write lands must not throw the typing away. The draft therefore lives
// outside the component, keyed by instance, and is restored when the person
// comes back.
//
// The draft also carries the values the fields had *before* the person
// touched them (`starts`). That is the baseline the server compares against
// to tell "this field was changed by somebody else" from "this field was
// changed by me" (integration contract D5).

/** What the person typed but has not saved yet. */
export type EditDraft = {
  /** 标题草稿 */
  title: string;
  /** 改标题之前的标题：没改过就不必写回 */
  startTitle: string;
  /** 改过的字段：路径 → 新值 */
  edits: Record<string, unknown>;
  /** 改过的字段在改之前的值：冲突判定要拿它跟服务端的当前值比 */
  starts: Record<string, unknown>;
};

const drafts = new Map<string, EditDraft>();

/** The instance's unsaved draft, if there is one. */
export function readDraft(instanceId: string): EditDraft | undefined {
  return drafts.get(instanceId);
}

/** Keep (or replace) the instance's unsaved draft. */
export function writeDraft(instanceId: string, draft: EditDraft): void {
  drafts.set(instanceId, draft);
}

/** Drop the instance's draft: there is nothing left to save. */
export function clearDraft(instanceId: string): void {
  drafts.delete(instanceId);
}
