# T18 界面焦点、重连状态与异步验收

项目所有者授权修复审查遗漏。范围：board/SpaceCanvas.tsx、main.tsx、CanvasShell.tsx、keyboard.ts、history.css；local/client.ts；tests/blank.ts、full.ts。

模态窗口、输入/媒体/IME与已处理事件不触发画布删除或撤销；Escape关闭设置保留选择。点击后的待确认选区可供紧接的按键使用。重连超时不猜测保存成功。历史主轴跨分支行连续。full测试等待新白板真正创建选中，保留断言。

验收：format/typecheck/npm test、test:blank、test:reopen、test:full；设置内Delete/Ctrl-Z/Escape保留卡片和历史，正常画布键仍可用。

工具箱闪变回归：选择/尺寸保存原先会让5个组件按钮disabled状态共变20次；select/camera/place仍串行提交，但不触发全局busy，失败反馈保留。浏览器断言这些操作期间按钮disabled变化为0，不凭换画布库宣称修复。
