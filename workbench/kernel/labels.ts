import type { Command } from "./types.ts";

export type LabelLookup = {
  objectTitle(id: string): string;
  presentationObjectTitle(id: string): string;
  endpointTitle(id: string): string;
  packTitle(id: string, manifest?: Record<string, unknown>): string;
};

export function makeLabel(
  commands: Command[],
  explicit: string | undefined,
  lookup: LabelLookup,
): string {
  if (explicit !== undefined) return explicit;
  const creates = commands.filter((command) => command.op === "object.create");
  if (
    creates.length === 1 &&
    commands.every(
      (command) =>
        command.op === "object.create" || command.op === "presentation.create",
    )
  ) {
    const title =
      creates[0]?.op === "object.create" ? (creates[0].title ?? "") : "";
    return `新建「${clip(title)}」`;
  }
  if (
    commands.length > 0 &&
    commands.every((command) => command.op === "presentation.update")
  ) {
    const sized = commands.some(
      (command) =>
        command.op === "presentation.update" &&
        (command.width !== undefined || command.height !== undefined),
    );
    const moved = commands.every(
      (command) =>
        command.op === "presentation.update" &&
        (command.x !== undefined || command.y !== undefined) &&
        command.width === undefined &&
        command.height === undefined,
    );
    if (!sized && moved) {
      if (commands.length === 1 && commands[0]?.op === "presentation.update")
        return `移动「${clip(lookup.presentationObjectTitle(commands[0].id))}」`;
      return `移动 ${commands.length} 个组件`;
    }
    if (
      sized &&
      commands.length === 1 &&
      commands[0]?.op === "presentation.update"
    )
      return `调整「${clip(lookup.presentationObjectTitle(commands[0].id))}」的大小`;
  }
  if (
    commands.length > 0 &&
    commands.every((command) => command.op === "object.update") &&
    new Set(
      commands.flatMap((command) =>
        command.op === "object.update" ? [command.id] : [],
      ),
    ).size === 1 &&
    commands[0]?.op === "object.update"
  )
    return `修改「${clip(lookup.objectTitle(commands[0].id))}」`;
  if (
    commands.length > 0 &&
    commands.every((command) => command.op === "object.delete")
  ) {
    if (commands.length === 1 && commands[0]?.op === "object.delete")
      return `删除「${clip(lookup.objectTitle(commands[0].id))}」`;
    return `删除 ${commands.length} 个对象`;
  }
  if (
    commands.length > 0 &&
    commands.every((command) => command.op === "presentation.delete")
  )
    return `移除 ${commands.length} 个展示`;
  if (commands.length === 1 && commands[0]?.op === "relation.create") {
    const command = commands[0];
    return `连接「${clip(lookup.endpointTitle(command.sourceId))}」→「${clip(lookup.endpointTitle(command.targetId))}」`;
  }
  if (
    commands.length > 0 &&
    commands.every(
      (command) => command.op === "setting.set" && command.key === "theme",
    )
  )
    return "修改外观";
  if (
    commands.length === 1 &&
    commands[0] &&
    commands[0].op.startsWith("pack.")
  ) {
    const command = commands[0];
    const title = clip(packTitleOf(command, lookup));
    if (command.op === "pack.enable") return `启用组件包「${title}」`;
    if (command.op === "pack.disable") return `停用组件包「${title}」`;
    if (command.op === "pack.import") return `导入组件包「${title}」`;
    if (command.op === "pack.remove") return `移除组件包「${title}」`;
  }
  return `编辑 ${commands.length} 处`;
}

function packTitleOf(command: Command, lookup: LabelLookup) {
  if (command.op === "pack.import") {
    const title = command.manifest.title;
    const name = command.manifest.name;
    if (typeof title === "string" && title) return title;
    if (typeof name === "string" && name) return name;
    return lookup.packTitle(
      typeof command.manifest.id === "string" ? command.manifest.id : "",
      command.manifest,
    );
  }
  if (
    command.op === "pack.enable" ||
    command.op === "pack.disable" ||
    command.op === "pack.remove"
  )
    return lookup.packTitle(command.id);
  return "";
}

function clip(title: string) {
  const chars = Array.from(title);
  if (chars.length <= 20) return title;
  return `${chars.slice(0, 20).join("")}…`;
}
