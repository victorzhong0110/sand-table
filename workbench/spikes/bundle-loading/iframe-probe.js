(async () => {
  const violations = [];
  const errors = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
    });
  });
  window.addEventListener("error", (event) => {
    errors.push(event.message || "error");
  });
  const fail = (error) =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const payload = {
    origin: location.origin,
    userAgent: navigator.userAgent,
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? null,
    violations,
    errors,
  };

  function finish() {
    window.parent.postMessage({ type: "probe", payload }, "*");
  }

  try {
    const sources = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("没有收到脚本")), 15000);
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "sources") return;
        clearTimeout(timer);
        resolve(event.data);
      });
    });

    async function withTimeout(work, ms) {
      let timer;
      try {
        return await Promise.race([
          work(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    function injectClassic(code) {
      const script = document.createElement("script");
      script.textContent = code;
      document.head.appendChild(script);
    }

    payload.classicInline = await (async () => {
      try {
        injectClassic("globalThis.__inlineClassic = 5");
        return { ok: globalThis.__inlineClassic === 5 };
      } catch (error) {
        return { ok: false, error: fail(error) };
      }
    })();

    payload.moduleInline = await new Promise((resolve) => {
      const script = document.createElement("script");
      script.type = "module";
      script.textContent = "globalThis.__inlineModule = 4";
      script.onerror = () => resolve({ ok: false, error: "error event" });
      document.head.appendChild(script);
      setTimeout(
        () =>
          resolve({
            ok: globalThis.__inlineModule === 4,
            error: globalThis.__inlineModule === 4 ? undefined : "not set",
          }),
        300,
      );
    });

    async function scriptSrc(url, flag) {
      try {
        await withTimeout(
          () =>
            new Promise((resolve, reject) => {
              const script = document.createElement("script");
              script.src = url;
              script.onload = () => resolve(undefined);
              script.onerror = () => reject(new Error("script error event"));
              document.head.appendChild(script);
            }),
          2000,
        );
        return { ok: globalThis[flag] === 1 };
      } catch (error) {
        return { ok: false, error: fail(error) };
      }
    }

    const blobUrl = URL.createObjectURL(
      new Blob(["globalThis.__blobScript = 1"], { type: "text/javascript" }),
    );
    payload.blobScript = await scriptSrc(blobUrl, "__blobScript");
    URL.revokeObjectURL(blobUrl);
    payload.dataScript = await scriptSrc(
      "data:text/javascript,globalThis.__dataScript=1",
      "__dataScript",
    );
    payload.httpsScript = await scriptSrc(
      "https://example.com/spike.js",
      "__httpsScript",
    );

    payload.newFunction = (() => {
      try {
        const value = new Function("return 2")();
        return { ok: value === 2 };
      } catch (error) {
        return { ok: false, error: fail(error) };
      }
    })();
    payload.evalScript = (() => {
      try {
        const value = eval("3");
        return { ok: value === 3 };
      } catch (error) {
        return { ok: false, error: fail(error) };
      }
    })();

    const importUrl = URL.createObjectURL(
      new Blob(["export const n = 3"], { type: "text/javascript" }),
    );
    try {
      const imported = await withTimeout(() => import(importUrl), 2000);
      payload.dynamicImportBlob = { ok: imported.n === 3 };
    } catch (error) {
      payload.dynamicImportBlob = { ok: false, error: fail(error) };
    } finally {
      URL.revokeObjectURL(importUrl);
    }

    try {
      await withTimeout(() => fetch("https://example.com/"), 2000);
      payload.fetchHttps = { ok: true };
    } catch (error) {
      payload.fetchHttps = { ok: false, error: fail(error) };
    }

    async function tryWorker(moduleWorker) {
      const url = URL.createObjectURL(
        new Blob(["postMessage(1)"], { type: "text/javascript" }),
      );
      try {
        const value = await withTimeout(
          () =>
            new Promise((resolve, reject) => {
              let worker;
              try {
                worker = moduleWorker
                  ? new Worker(url, { type: "module" })
                  : new Worker(url);
              } catch (error) {
                reject(error);
                return;
              }
              worker.onmessage = (event) => {
                worker.terminate();
                resolve(event.data);
              };
              worker.onerror = () => {
                worker.terminate();
                reject(new Error("worker error event"));
              };
            }),
          2000,
        );
        return { ok: value === 1 };
      } catch (error) {
        return { ok: false, error: fail(error) };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    payload.workerClassic = await tryWorker(false);
    payload.workerModule = await tryWorker(true);

    async function runPdf(withWorker) {
      try {
        if (withWorker) {
          injectClassic(sources.worker);
          if (!globalThis.pdfjsWorker?.WorkerMessageHandler) {
            return {
              ok: false,
              error: "worker 脚本没有留下 WorkerMessageHandler",
              errors: errors.slice(),
            };
          }
        }
        injectClassic(sources.runner);
        if (typeof globalThis.__sandRunPdf !== "function") {
          return {
            ok: false,
            error: "api 脚本没有留下 __sandRunPdf",
            errors: errors.slice(),
          };
        }
        const result = await withTimeout(
          () => globalThis.__sandRunPdf(sources.pdfB64),
          20000,
        );
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: fail(error), errors: errors.slice() };
      }
    }

    if (sources.mode === "pdf") payload.pdf = await runPdf(true);
    if (sources.mode === "pdf-without-worker")
      payload.pdf = await runPdf(false);
    finish();
  } catch (error) {
    payload.fatal = fail(error);
    finish();
  }
})();
