import { useEffect, useRef, useState } from "react";

export type HostShellMessage = {
  type: "sand-table:shell";
  embedded: boolean;
  connected: boolean;
  statusText: string;
  config: { json: string; codex: string; toml: string };
  prompt: string;
  askText: string;
  askSeq: number;
  revealSeq: number;
};

export const EMPTY_SHELL: HostShellMessage = {
  type: "sand-table:shell",
  embedded: false,
  connected: false,
  statusText: "正在确认连接…",
  config: { json: "", codex: "", toml: "" },
  prompt: "",
  askText: "",
  askSeq: 0,
  revealSeq: 0,
};

export function readShellMessage(data: unknown): HostShellMessage | null {
  if (!data || typeof data !== "object") return null;
  const row = data as {
    type?: unknown;
    embedded?: unknown;
    connected?: unknown;
    statusText?: unknown;
    config?: { json?: unknown; codex?: unknown; toml?: unknown };
    prompt?: unknown;
    askText?: unknown;
    askSeq?: unknown;
    revealSeq?: unknown;
  };
  if (row.type !== "sand-table:shell") return null;
  const config = row.config ?? {};
  return {
    type: "sand-table:shell",
    embedded: Boolean(row.embedded),
    connected: Boolean(row.connected),
    statusText: typeof row.statusText === "string" ? row.statusText : "",
    config: {
      json: typeof config.json === "string" ? config.json : "",
      codex: typeof config.codex === "string" ? config.codex : "",
      toml: typeof config.toml === "string" ? config.toml : "",
    },
    prompt: typeof row.prompt === "string" ? row.prompt : "",
    askText: typeof row.askText === "string" ? row.askText : "",
    askSeq: typeof row.askSeq === "number" ? row.askSeq : 0,
    revealSeq: typeof row.revealSeq === "number" ? row.revealSeq : 0,
  };
}

export function HelpPanel({
  shell,
  onAsk,
  onClose,
}: {
  shell: HostShellMessage;
  onAsk: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const copiedAsk = useRef(0);
  const fields = useRef<Record<string, HTMLTextAreaElement | null>>({});

  async function copyText(id: string, value: string) {
    const field = fields.current[id];
    try {
      await navigator.clipboard.writeText(value);
      setStatus("已复制。粘贴到你的本机 AI 客户端即可。");
    } catch {
      field?.focus();
      field?.select();
      setStatus("请按系统复制快捷键，文本已选中。");
    }
  }

  useEffect(() => {
    if (!shell.askSeq || shell.askSeq === copiedAsk.current) return;
    copiedAsk.current = shell.askSeq;
    void copyText("ask-text", shell.askText);
  }, [shell.askSeq, shell.askText]);

  return (
    <div className="help-panel">
      {!shell.embedded && (
        <section className="help-config">
          <h3>和你自己的 AI 共用这张白板</h3>
          <p>
            在本机 MCP
            客户端中安装一次，然后在它的对话里提问。白板不自带模型，也不需要新的
            API Key。
          </p>
          <p className="help-note">
            装一次就够：工作台重启后，只要 MCP 配置里的 --session-file
            还是这一份，客户端就会自动跟随。浏览器和 MCP
            客户端看的是同一张白板。
          </p>
          <label>
            Codex CLI 安装命令
            <textarea
              id="codex"
              readOnly
              ref={(node) => {
                fields.current.codex = node;
              }}
              value={shell.config.codex}
            />
          </label>
          <button
            type="button"
            data-copy="codex"
            onClick={() => void copyText("codex", shell.config.codex)}
          >
            复制命令
          </button>
          <label>
            JSON
            <textarea
              id="json"
              readOnly
              aria-label="MCP JSON"
              ref={(node) => {
                fields.current.json = node;
              }}
              value={shell.config.json}
            />
          </label>
          <button
            type="button"
            data-copy="json"
            onClick={() => void copyText("json", shell.config.json)}
          >
            复制 JSON
          </button>
          <label>
            TOML
            <textarea
              id="toml"
              readOnly
              ref={(node) => {
                fields.current.toml = node;
              }}
              value={shell.config.toml}
            />
          </label>
          <button
            type="button"
            data-copy="toml"
            onClick={() => void copyText("toml", shell.config.toml)}
          >
            复制 TOML
          </button>
        </section>
      )}
      <section>
        <h3>Agent 发来的消息</h3>
        <textarea
          id="prompt"
          readOnly
          aria-label="Agent 消息"
          ref={(node) => {
            fields.current.prompt = node;
          }}
          value={shell.prompt}
          placeholder="AI 发来的编排消息会显示在这里。"
        />
        <button
          type="button"
          data-copy="prompt"
          onClick={() => void copyText("prompt", shell.prompt)}
        >
          复制这条消息
        </button>
        <label>
          选区提问
          <textarea
            id="ask-text"
            readOnly
            aria-label="选区提问"
            ref={(node) => {
              fields.current["ask-text"] = node;
            }}
            value={shell.askText}
          />
        </label>
        <button type="button" onClick={onAsk}>
          复制当前选区提问
        </button>
        <p className="help-note">
          选区提问写在上面单独的框里，不会盖掉 Agent 发来的原文。
        </p>
      </section>
      <section>
        <h3>快捷键</h3>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "?", bubbles: true }),
            );
          }}
        >
          快捷键说明
        </button>
      </section>
      <section>
        <h3>连接状态</h3>
        <p role="status">{shell.statusText || "正在确认连接…"}</p>
        <p className="help-note">
          帮助按钮上的圆点：绿色表示已经有 MCP
          接入，灰色表示还没接上或已经断开。圆点不是 AI 正在思考。
        </p>
      </section>
      <p id="setup-status" role="status">
        {status}
      </p>
      <button type="button" onClick={onClose}>
        返回白板
      </button>
    </div>
  );
}
