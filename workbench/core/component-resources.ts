export const COMPONENT_RESOURCES = {
  "pdf-worker": { file: "pdf-worker.js", global: "pdfjsWorker" },
  "pdf-api": { file: "pdf-api.js", global: "sandTablePdf" },
  charts: { file: "charts.js", global: "sandTableChart" },
} as const;

export type ComponentResource = keyof typeof COMPONENT_RESOURCES;
export const COMPONENT_RESOURCE_MIME = "text/javascript";

export function componentResourceUri(name: ComponentResource): string {
  if (!Object.hasOwn(COMPONENT_RESOURCES, name))
    throw Error("这个组件资源未注册。");
  return "ui://sand-table/chunks/" + COMPONENT_RESOURCES[name].file;
}
