# T09 桌面接入与Windows验收

项目所有者授权修复PR #53。确认其既有 Electron 45.0.0、electron-builder 26.15.3、Playwright 1.62.1 依赖，不新增依赖。

范围：desktop/main、desktop/tests、desktop/scripts、desktop/README.md；local/config.ts、tests/desktop-config.test.ts；.github/workflows/desktop.yml。

环境变量覆盖JSON/命令/TOML，Windows命令适配PowerShell；便携MCP运行时持久保存。Windows打包与安装/窗口验收独立执行，未取得真人记录前保持待验。

检查：workbench格式/类型/单元测试，桌面路径删除回归与脚本语法，Windows工作流构建并打开实际exe。
