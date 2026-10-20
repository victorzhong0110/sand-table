// 领域包注册入口。
//
// 内核只认注册表；领域语义（类型、组件、关系、工具、模板）由各领域包提供。
// 契约见 docs/architecture/domain-packs.zh-CN.md。
//
// 注册是**显式**的：进程启动时调用一次，禁用某个包就是不在这里注册它。

import { registerDomainPack } from "../core/domains.ts";
import { registerCodeDomain } from "./code/index.ts";
import { novelPack } from "./novel/index.ts";
import { researchPack } from "./research/index.ts";
import {
  componentTypes,
  defaultData,
  nativeContentTypes,
  referenceContentTypes,
} from "../core/spaces.ts";
import type { DomainPack } from "../core/objects.ts";

/** 内置原生类型：内核自带的词汇，规则也住在内核。 */
export const builtinPack: DomainPack = {
  id: "builtin",
  title: "内置原生类型",
  version: 1,
  description: "便签、标题、指标、状态、图表、表格等通用内容类型。",
  objectTypes: [
    /* 「code」由代码领域包认领：注册表按注册顺序取先注册者，
       内置包先注册的话，代码片段的领域规则就永远不触发。 */
    ...(nativeContentTypes as readonly string[])
      .filter((type) => type !== "code")
      .map((type) => ({
        type,
        title: componentTypes.find((c) => c.type === type)?.title ?? type,
        defaultData: defaultData(type),
      })),
    ...(referenceContentTypes as readonly string[]).map((type) => ({
      type,
      title: componentTypes.find((c) => c.type === type)?.title ?? type,
      defaultData: defaultData(type),
    })),
  ],
  componentTypes: componentTypes.map((c) => ({
    type: c.type,
    title: c.title,
  })),
};

/** 注册内置原生类型。通用内核只需要它。 */
export function registerBuiltinDomain(): void {
  registerDomainPack(builtinPack);
}

/**
 * 注册全部领域包（内置 + 代码 + 小说 + 科研）。
 *
 * 模板只是**起点**：用户可以从空白开始，包的存在不强制任何流程。
 */
export function registerAllDomains(): void {
  registerBuiltinDomain();
  registerDomainPack(novelPack);
  registerDomainPack(researchPack);
}

/**
 * 注册代码领域包。
 *
 * **要显式调用**：代码包会带进索引器（TypeScript 编译器），空白启动不该背这份依赖。
 * 绑定仓库时才注册。
 */
export function registerCodeDomainSync(): void {
  registerCodeDomain();
}
