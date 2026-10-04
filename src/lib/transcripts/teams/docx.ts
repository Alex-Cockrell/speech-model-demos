/**
 * Reading the text of a .docx in the browser, without libraries. OWNER: meeting agent.
 *
 * A .docx is a ZIP archive; the text is in word/document.xml. The archive's central directory (at its end) lists
 * every entry with its compression method, sizes and where its local header starts; entries are stored (method
 * 0) or deflated (method 8, inflated with DecompressionStream('deflate-raw')). Paragraphs (w:p) become lines;
 * their text is the w:t runs, with w:tab as a tab and w:br / w:cr as a line break.
 */

export class DocxError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Entries of the archive's central directory. */
export function listZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is the last 22 bytes, plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError('The file is not a complete Word document (its archive directory is missing).');
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset === 0xffffffff || count === 0xffff) throw new DocxError('This Word document is too large to read here.');
  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];
  let p = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new DocxError('The Word document is damaged (its archive directory cannot be read).');
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new DocxError('This browser cannot unpack Word documents. Paste the transcript text or use the .vtt download instead.');
  }
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The bytes of one archive entry, or null when it is not in the archive. */
export async function readZipEntry(bytes: Uint8Array, path: string): Promise<Uint8Array | null> {
  const entry = listZipEntries(bytes).find((e) => e.name === path);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localHeaderOffset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== LOCAL_SIGNATURE) {
    throw new DocxError('The Word document is damaged (an archive entry cannot be found).');
  }
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length < entry.compressedSize) throw new DocxError('The Word document is cut off.');
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    try {
      return await inflateRaw(data);
    } catch (e) {
      if (e instanceof DocxError) throw e;
      throw new DocxError('The Word document is damaged (its text cannot be unpacked).');
    }
  }
  throw new DocxError(`The Word document uses an unsupported compression (method ${entry.method}).`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * word/document.xml → its paragraphs as lines. Only w:t text counts (field codes, deleted text and the fallback
 * copy of text boxes are skipped).
 */
export function documentXmlToText(xml: string): string {
  const paragraphs: string[] = [];
  let current: string[] | null = null;
  let inText = false;
  let inProperties = false;
  /** Depth inside elements whose content must be skipped. */
  let skip = 0;
  const tokens = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(xml))) {
    if (m[5] !== undefined) {
      if (inText && skip === 0 && current) current.push(decodeXmlEntities(m[5]));
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2];
    const selfClosing = m[4] === '/';
    if (name === 'mc:Fallback' || name === 'w:delText' || name === 'w:instrText') {
      if (!selfClosing) skip += closing ? -1 : 1;
      if (skip < 0) skip = 0;
      continue;
    }
    if (skip > 0) continue;
    // Paragraph properties hold tab-stop definitions (<w:tabs><w:tab …/></w:tabs>), not tabs.
    if (name === 'w:pPr') {
      if (!selfClosing) inProperties = !closing;
      continue;
    }
    if (inProperties) continue;
    switch (name) {
      case 'w:p':
        if (closing) {
          if (current) paragraphs.push(current.join(''));
          current = null;
        } else if (selfClosing) {
          paragraphs.push('');
        } else {
          current = [];
        }
        break;
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tab':
        if (!closing && current) current.push('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing && current) current.push('\n');
        break;
      case 'w:noBreakHyphen':
        if (!closing && current) current.push('-');
        break;
      default:
        break;
    }
  }
  if (current) paragraphs.push(current.join(''));
  return paragraphs.join('\n');
}

/** The text of a .docx: one line per paragraph. */
export async function readDocxText(bytes: Uint8Array): Promise<string> {
  if (!isZip(bytes)) {
    // Word 97-2003 files start with the OLE signature D0 CF 11 E0.
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new DocxError('This is an old Word (.doc) file. Download the transcript again as .docx, or open it in Word and copy the text.');
    }
    throw new DocxError('The file is not a Word document (.docx).');
  }
  const xml = await readZipEntry(bytes, 'word/document.xml');
  if (!xml) throw new DocxError('The file is an archive but not a Word document (no word/document.xml).');
  return documentXmlToText(new TextDecoder().decode(xml));
}
