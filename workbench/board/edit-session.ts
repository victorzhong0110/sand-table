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
