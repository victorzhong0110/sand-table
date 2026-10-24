import { getDocument } from "pdfjs-dist/build/pdf.min.mjs";

function bytesFromB64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

globalThis.__sandRunPdf = async (b64) => {
  const loading = getDocument({
    data: bytesFromB64(b64),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");
    let rendered = false;
    let renderError = "";
    try {
      const canvas = document.createElement("canvas");
      const viewport = page.getViewport({ scale: 1 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas 没有 2d context");
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 0) ink += 1;
      }
      rendered = ink > 20;
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    }
    return { pages: pdf.numPages, text, rendered, renderError };
  } finally {
    await loading.destroy();
  }
};
