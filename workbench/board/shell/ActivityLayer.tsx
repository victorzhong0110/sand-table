import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Activity, Board, SpaceActivity } from "../data-client/model.ts";

function stateLabel(state: Activity["state"]) {
  switch (state) {
    case "running":
      return "进行中";
    case "waiting":
      return "等待";
    case "done":
      return "完成";
    case "unknown":
      return "未知";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function liveActivities(board: Board) {
  return (board.activities ?? []).filter((item) => !item.stale);
}

function instancesFor(activity: Activity, board: Board) {
  return board.instances.filter(
    (item) =>
      (item.objectId && activity.objectIds.includes(item.objectId)) ||
      activity.objectIds.includes(item.id),
  );
}

export function ActivityLayer({
  board,
  onOpen,
}: {
  board: Board;
  onOpen: (activity: Activity, space: SpaceActivity | undefined) => void;
}) {
  const activities = liveActivities(board);
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const liveKey = activities
    .map((item) => item.agentId + item.state + item.reportedAt + item.task)
    .join("|");
  const instanceKey = board.instances.map((item) => item.id).join("|");

  useLayoutEffect(() => {
    let cancelled = false;
    const collect = () => {
      if (cancelled) return;
      const root = document.querySelector(".flow-canvas");
      const next = root
        ? [...root.querySelectorAll<HTMLElement>("[data-instance-id]")]
        : [];
      setHosts((current) =>
        current.length === next.length &&
        current.every((node, index) => node === next[index])
          ? current
          : next,
      );
    };
    collect();
    const frame = requestAnimationFrame(collect);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [instanceKey, liveKey, board.revision]);

  const running = activities.some((item) => item.state === "running");
  return (
    <>
      {hosts.map((host) => {
        const id = host.getAttribute("data-instance-id") || "";
        const match = activities
          .filter((item) =>
            instancesFor(item, board).some((instance) => instance.id === id),
          )
          .sort((a, b) => b.reportedAt - a.reportedAt)[0];
        if (!match || !host.isConnected) return null;
        return createPortal(
          <span className="activity-badge" key={match.agentId}>
            {(match.agentId || "Agent") + " · " + stateLabel(match.state)}
          </span>,
          host,
        );
      })}
      {activities.length > 0 && (
        <aside className="activity-corner" aria-label="Agent 活动">
          {running && <p>● Agent 有活动报告</p>}
          {activities
            .slice()
            .sort((a, b) => b.reportedAt - a.reportedAt)
            .map((activity) => {
              const space = board.spaceActivities?.find(
                (item) => item.agentId === activity.agentId,
              );
              return (
                <button
                  type="button"
                  key={activity.agentId + ":" + activity.reportedAt}
                  onClick={() => onOpen(activity, space)}
                >
                  <b>{activity.agentId || "Agent"}</b>
                  <span>{stateLabel(activity.state)}</span>
                  <span>{activity.task}</span>
                </button>
              );
            })}
        </aside>
      )}
    </>
  );
}
