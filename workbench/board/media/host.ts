export type DownloadFile = (
  filename: string,
  content: string | { blob: string; mimeType: string },
) => Promise<void>;
