import { resultData } from "../core/results.ts";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
declare global {
  interface Window {
    __token: string;
    __boardId: string;
  }
}
async function rpc(method: string, params: unknown) {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sand-Token": window.__token,
    },
    body: JSON.stringify({ method, params }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Request rejected");
  return result;
}
async function main() {
  const result = await rpc("tools/call", {
    name: "sand_open_board",
    arguments: { title: "代码如何协作" },
  });
  window.__boardId = resultData(result).id;
  const resource = await rpc("resources/read", {
    uri: "ui://sand-table/overview.html",
  });
  const frame = document.querySelector("iframe")!;
  const bridge = new AppBridge(
    null,
    { name: "Local protocol harness (no AI)", version: "0.1.0" },
    { serverTools: {} },
    {
      hostContext: {
        theme: "light",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        locale: "zh-CN",
      },
    },
  );
  bridge.oncalltool = (params) => rpc("tools/call", params);
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(result);
  };
  await bridge.connect(
    new PostMessageTransport(frame.contentWindow!, frame.contentWindow!),
  );
  frame.srcdoc = resource.contents[0].text.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">`,
  );
  document.getElementById("read")!.onclick = async () => {
    const output = document.getElementById("context")!;
    output.hidden = false;
    try {
      output.textContent = JSON.stringify(
        await rpc("tools/call", {
          name: "sand_read_context",
          arguments: { boardId: window.__boardId },
        }),
        null,
        2,
      );
    } catch (e) {
      output.textContent = String(e);
    }
  };
}
void main().catch((e) => {
  document.body.textContent = String(e);
});
