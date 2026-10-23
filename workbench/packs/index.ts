// 内置包清单：内核启动时按这个顺序注册。
//
// 顺序有讲究：base 必须最先注册，其他包的类型才能引用 base 的关系类型
// （代码包的意图槽用 base.related 表示「涉及的对象」）。

import type { PackSpec } from "../kernel/index.ts";
import { basePack } from "./base/index.ts";
import { codePack } from "./code/index.ts";
import { novelPack } from "./novel/index.ts";
import { researchPack } from "./research/index.ts";

export const builtinPacks: PackSpec[] = [
  basePack,
  novelPack,
  researchPack,
  codePack,
];
