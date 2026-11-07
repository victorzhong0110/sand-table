export type ThemeWrite = {
  workspaceId: string | undefined;
  commands: Record<string, unknown>[];
};

const workspaceTails = new Map<string | undefined, Promise<void>>();

export function createThemeWriter(
  send: (write: ThemeWrite) => Promise<void>,
  onError: (error: unknown) => void,
  delay = 500,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ThemeWrite | undefined;
  let outstanding = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const enqueue = (write: ThemeWrite) => {
    const key = write.workspaceId;
    const tail = workspaceTails.get(key) ?? Promise.resolve();
    outstanding += 1;
    const result = tail
      .then(() => send(write))
      .finally(() => {
        outstanding -= 1;
      });
    const settled = result.catch(() => {});
    workspaceTails.set(key, settled);
    void settled.then(() => {
      if (workspaceTails.get(key) === settled) workspaceTails.delete(key);
    });
    return result;
  };
  const flush = () => {
    const write = pending;
    cancel();
    if (write) void enqueue(write).catch(onError);
  };
  return {
    schedule(write: ThemeWrite) {
      cancel();
      pending = write;
      timer = setTimeout(flush, delay);
    },
    writeNow(write: ThemeWrite) {
      cancel();
      return enqueue(write);
    },
    flush,
    isBusy() {
      return pending !== undefined || outstanding > 0;
    },
  };
}
