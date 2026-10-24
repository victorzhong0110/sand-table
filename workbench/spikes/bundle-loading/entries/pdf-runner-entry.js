import { getDocument } from "pdfjs-dist/build/pdf.min.mjs";

function darkPixels(canvas) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 没有 2d context");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    if (pixels[i] < 200 || pixels[i + 1] < 200 || pixels[i + 2] < 200) dark += 1;
  }
  return dark;
}

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
    let pageDark = 0;
    let blankDark = 0;
    let renderError = "";
    try {
      const canvas = document.createElement("canvas");
      const viewport = page.getViewport({ scale: 1 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const blank = document.createElement("canvas");
      blank.width = canvas.width;
      blank.height = canvas.height;
      const blankContext = blank.getContext("2d");
      if (!blankContext) throw new Error("canvas 没有 2d context");
      blankContext.fillStyle = "#ffffff";
      blankContext.fillRect(0, 0, blank.width, blank.height);
      blankDark = darkPixels(blank);
      await page.render({ canvas, viewport }).promise;
      pageDark = darkPixels(canvas);
      // 白底的 RGB 也大于 0。只比空白白页多出来的深色像素才算画出了字形。
      rendered = pageDark > blankDark + 20;
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    }
    return {
      pages: pdf.numPages,
      text,
      rendered,
      pageDark,
      blankDark,
      renderError,
    };
  } finally {
    await loading.destroy();
  }
};
