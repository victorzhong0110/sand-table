type Event = {
  seq: number;
  time: number;
  type: string;
  data: any;
  ignorable?: boolean;
};
type Definition = {
  init(header: unknown, inherited: number): unknown;
  apply(state: unknown, event: Event): unknown;
};

export function dshWorkbenchFixture() {
  const listeners = new Set<(session: any, event: Event) => void>();
  const durable = new Map<
    string,
    { header: any; events: Event[]; inherited: number }
  >();
  const live = new Map<string, any>();
  function attach(id = "session", createdAt = Date.now(), inherited = 0) {
    const stored = durable.get(id);
    const session = {
      id,
      header: stored?.header ?? { id, createdAt },
      inheritedEventCount: stored?.inherited ?? inherited,
      events: [...(stored?.events ?? [])] as Event[],
    };
    live.set(id, session);
    return session;
  }
  const session = attach();
  function emit(
    type: string,
    data: unknown,
    target = session,
    ignorable = false,
  ) {
    const event = {
      type,
      data,
      seq: target.events.length + 1,
      time: Date.now(),
      ...(ignorable ? { ignorable } : {}),
    };
    target.events.push(event);
    for (const listener of listeners) listener(target, event);
    return event.seq;
  }
  const records = {
    appendPluginRecord(target: any, type: string, data: unknown) {
      return emit(type, data, target, true);
    },
    pluginRecordOf(event: Event) {
      return event.ignorable ? event : undefined;
    },
  };
  const services = {
    sessions: {
      get: (id: string) => live.get(id),
      async flush(target: any) {
        durable.set(target.id, {
          header: target.header,
          events: structuredClone(target.events),
          inherited: target.inheritedEventCount,
        });
        return true;
      },
    },
    sessionPersistence: {
      async open(id: string) {
        const stored = durable.get(id);
        if (!stored) throw Error("找不到持久会话。");
        return {
          header: stored.header,
          inheritedEventCount: stored.inherited,
          read: async () => ({ events: structuredClone(stored.events) }),
          close: async () => {},
        };
      },
    },
    sessionProjections: {
      async register(definition: Definition) {
        return {
          stateOf: (target: any) =>
            target.events.reduce(
              definition.apply,
              definition.init(target.header, target.inheritedEventCount),
            ),
          dispose: async () => {},
        };
      },
    },
  };
  return {
    session,
    emit,
    records,
    attach,
    detach: (id: string) => live.delete(id),
    flush: services.sessions.flush,
    ctx(controller: unknown) {
      return {
        get(name: string) {
          if (name === "sessionController") return controller;
          return services[name as keyof typeof services];
        },
        on(_name: string, fn: (session: any, event: Event) => void) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    },
  };
}

export const workbenchArtifactTool = "sand_table_publish_artifact";
export function emitArtifact(
  fixture: ReturnType<typeof dshWorkbenchFixture>,
  turn: number,
  value: unknown,
  options: { callId?: string; toolName?: string; session?: any } = {},
) {
  const toolCallId = options.callId ?? `call-${turn}`;
  fixture.emit(
    "tool/call",
    {
      turn,
      step: 1,
      callId: toolCallId,
      name: options.toolName ?? workbenchArtifactTool,
    },
    options.session,
  );
  fixture.emit(
    "tool/result",
    {
      turn,
      step: 1,
      message: {
        toolCallId,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              protocol: "sand-table/artifact-v1",
              artifact: value,
            }),
          },
        ],
      },
    },
    options.session,
  );
}
