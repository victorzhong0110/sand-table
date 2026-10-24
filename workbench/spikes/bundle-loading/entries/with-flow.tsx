import "../../../board/main.tsx";
import * as flow from "./flow-symbols.ts";

// 挂到 globalThis，打包器才会留下这些符号。
Object.assign(globalThis, { __sandFlowProbe: flow });
