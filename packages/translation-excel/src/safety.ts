import { unzipSync } from "fflate";
import { LlError } from "@localelens/core";

export const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxZipEntries: 400,
  maxUncompressedBytes: 120 * 1024 * 1024,
  maxRatio: 250,
  maxRows: 100_000,
  maxCellChars: 10_000,
  maxLocales: 60,
};

const bad = (msg: string) => new LlError("IMPORT_INVALID", msg);

/** Entry names inside any archive we open: no traversal, no absolute paths, no backslashes, no drive letters. */
export function assertSafeEntryName(name: string) {
  if (name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..") || name.includes("\0"))
    throw bad(`Unsafe path in archive: ${JSON.stringify(name.slice(0, 80))}`);
}

/** Inflate-bomb / traversal guard. Returns the entries requested by `want` (everything else is never decompressed). */
export function readZip(bytes: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  if (bytes.length > LIMITS.maxFileBytes) throw bad(`File too large (> ${LIMITS.maxFileBytes / 1024 / 1024} MB)`);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw bad("Not a zip/xlsx file");
  let count = 0, total = 0;
  try {
    return unzipSync(bytes, {
      filter(f) {
        if (++count > LIMITS.maxZipEntries) throw bad("Archive has too many entries");
        assertSafeEntryName(f.name);
        total += f.originalSize;
        if (total > LIMITS.maxUncompressedBytes) throw bad("Archive expands to too much data (possible zip bomb)");
        if (f.size > 0 && f.originalSize / f.size > LIMITS.maxRatio && f.originalSize > 1_000_000) throw bad("Suspicious compression ratio (possible zip bomb)");
        return want(f.name);
      },
    });
  } catch (e) {
    if (e instanceof LlError) throw e;
    throw bad("Corrupt archive");
  }
}

/** Validate an .xlsx container *before* handing it to the spreadsheet parser. Also rejects macro-enabled workbooks. */
export function assertSafeXlsx(bytes: Uint8Array) {
  const files = readZip(bytes, (n) => n === "[Content_Types].xml" || n === "xl/workbook.xml" || n.endsWith("vbaProject.bin"));
  if (!files["[Content_Types].xml"] || !files["xl/workbook.xml"]) throw bad("Not a valid .xlsx workbook");
  if (Object.keys(files).some((n) => n.endsWith("vbaProject.bin"))) throw bad("Macro-enabled workbooks are rejected");
}
