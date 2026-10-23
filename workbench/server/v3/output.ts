// v3 工具面的输出约定。
//
// 模型只读 content 里的精简 JSON（一般不超过 4 KB）；界面要的完整数据放 _meta.data。
// 出错时给 { code, message, hint }：message 说清发生了什么，hint 按错误码固定，
// 告诉模型下一步该做什么。

import { CommandError, type ErrorCode } from "../../kernel/index.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";

/** 模型一次能读的文本上限（字节）。 */
export const MODEL_TEXT_BUDGET = 4096;

const HINTS: Record<ErrorCode, string> = {
  UNKNOWN_TYPE:
    "Call sand_types to see the types this workspace has, then use one of those type names.",
  INVALID_DATA:
    "Fix the fields named in the message, then send the same request again.",
  LIMIT: "Send less in one call: fewer rows, fewer objects or shorter text.",
  VERSION_CONFLICT: "Call sand_read to get the current version, then retry.",
  NOT_FOUND: "Call sand_status to see what still exists, then use a fresh id.",
  NOT_CONTAINER:
    "Put the item inside a container type, or drop the parent reference.",
  CYCLE: "Move the item outside the board it would contain, then try again.",
  LOCKED: "Unlock the item first, then move or resize it.",
  FORBIDDEN:
    "Ask the person to do this in the app; the agent is not allowed to do it.",
  HISTORY_CONFLICT:
    "Call sand_history to see the current position, then try again.",
  INTERNAL:
    "Try again. If it keeps failing, ask the person to reopen the workspace.",
};

/** 工具返回值：visible 给模型（content 文本），data 给界面（_meta.data）。 */
const TOOL_VALUE = Symbol("sand.toolValue");

export type ToolValue = {
  [TOOL_VALUE]: true;
  visible: unknown;
  data?: unknown;
};

/** 做一个带界面数据的返回值。 */
export function toolValue(visible: unknown, data?: unknown): ToolValue {
  return {
    [TOOL_VALUE]: true,
    visible,
    ...(data === undefined ? {} : { data }),
  };
}

export function isToolValue(value: unknown): value is ToolValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ToolValue)[TOOL_VALUE] === true
  );
}

export function modelText(value: unknown): string {
  return JSON.stringify(value);
}

/** 文本是不是超过模型能读的预算。 */
export function overBudget(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MODEL_TEXT_BUDGET;
}

/** 工具正常返回：模型看精简文本，界面看完整数据。 */
export function toolResult(value: unknown): CallToolResult {
  if (isToolValue(value)) {
    return {
      content: [{ type: "text", text: modelText(value.visible) }],
      structuredContent: { data: value.visible },
      ...(value.data === undefined ? {} : { _meta: { data: value.data } }),
    };
  }
  return {
    content: [{ type: "text", text: modelText(value) }],
    structuredContent: { data: value },
  };
}

/** 工具失败：文本里是 { code, message, hint }，宿主与模型读的是同一份。 */
export function toolError(error: unknown): CallToolResult {
  const described = describeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: modelText(described) }],
    structuredContent: { data: described },
  };
}

export function describeError(error: unknown): {
  code: string;
  message: string;
  hint: string;
} {
  if (error instanceof CommandError)
    return {
      code: error.code,
      message: error.message,
      hint: HINTS[error.code],
    };
  return {
    code: "INTERNAL",
    message:
      error instanceof Error ? error.message : "工具执行失败，请再试一次。",
    hint: HINTS.INTERNAL,
  };
}
