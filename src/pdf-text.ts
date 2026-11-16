import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 旧版 PDF.js 可能遗漏无 ToUnicode 表的中文字体内容；新版引擎仅用于本地修复。
export async function extractPdfTextLocally(buffer: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    let text = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        text += (lastY === undefined || Math.abs(lastY - y) > 2 ? '\n' : ' ') + item.str;
        lastY = y;
      }
      text += '\n';
    }
    return text.normalize('NFKC').trim();
  } finally {
    await task.destroy();
  }
}
