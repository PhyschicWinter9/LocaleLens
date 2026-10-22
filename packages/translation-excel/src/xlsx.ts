import ExcelJS from "exceljs";
import { strToU8, strFromU8, zipSync } from "fflate";
import { LlError } from "@localelens/core";
import { entryId, type IncomingRow, type PackageManifest, type Values } from "./model.ts";
import { LIMITS, assertSafeXlsx, readZip } from "./safety.ts";

const SHEET = "Translations";
const META = "_localelens";
const CHUNK = 30_000;
const bad = (m: string) => new LlError("IMPORT_INVALID", m);
const HEAD = ["ID", "Workspace", "Namespace", "Key"];
const FILLS = ["FFFFF9E6", "FFE9F3FF", "FFE8F5E9", "FFFCE4EC", "FFEDE7F6", "FFE0F7FA", "FFFFF3E0", "FFF1F8E9"];

/**
 * Build the translator workbook. All translation cells are plain strings with the Text number format, so a value such as
 * `=HYPERLINK(...)` is data, never a formula. The base snapshot travels inside the workbook (hidden sheet) so translators
 * need nothing else.
 */
export async function buildWorkbook(manifest: PackageManifest): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LocaleLens";
  const ws = wb.addWorksheet(SHEET, { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  ws.columns = [
    { header: "ID", width: 14 }, { header: "Workspace", width: 14 }, { header: "Namespace", width: 14 }, { header: "Key", width: 36 },
    ...manifest.locales.map((l) => ({ header: l, width: 40 })),
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.eachCell((cell, i) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i <= 4 ? "FFE5E7EB" : FILLS[(i - 5) % FILLS.length] } };
  });
  for (const e of manifest.entries) {
    const row = ws.addRow([e.id, e.workspaceId, e.namespace, e.key, ...manifest.locales.map((l) => e.values[l] ?? "")]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.numFmt = "@";
      cell.alignment = { vertical: "top", wrapText: true };
    });
    for (let c = 1; c <= 4; c++) row.getCell(c).font = { color: { argb: "FF6B7280" } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 + manifest.locales.length } };

  const meta = wb.addWorksheet(META, { state: "veryHidden" });
  const json = JSON.stringify(manifest);
  for (let i = 0; i * CHUNK < json.length; i++) meta.getCell(i + 1, 1).value = json.slice(i * CHUNK, (i + 1) * CHUNK);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** zip package = translations.xlsx + manifest.json (human-readable copy of the base snapshot). */
export async function buildPackage(manifest: PackageManifest): Promise<Uint8Array> {
  return zipSync({
    "translations.xlsx": await buildWorkbook(manifest),
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "README.txt": strToU8("Edit translations.xlsx only: fill the locale columns. Do not change the ID, Workspace, Namespace or Key columns.\nReturn translations.xlsx to the developer.\n"),
  });
}

function cellText(v: ExcelJS.CellValue, where: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) throw bad(`${where}: date cell; set the column format to Text`);
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) throw bad(`${where}: formulas are not accepted; paste values only`);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text ?? ""); // hyperlink: keep display text, drop the target
    if ("error" in v) throw bad(`${where}: spreadsheet error value`);
  }
  throw bad(`${where}: unsupported cell content`);
}

export interface ParsedWorkbook { manifest: PackageManifest | null; rows: IncomingRow[]; warnings: string[] }

/** Accepts .xlsx or the .zip package. Never trusts structure: all limits enforced before and during parsing. */
export async function parseUpload(bytes: Uint8Array): Promise<ParsedWorkbook> {
  let xlsx = bytes;
  let pkgManifest: PackageManifest | null = null;
  const sniffZip = readZip(bytes, (n) => n === "translations.xlsx" || n === "manifest.json");
  if (sniffZip["translations.xlsx"]) {
    xlsx = sniffZip["translations.xlsx"];
    if (sniffZip["manifest.json"]) { try { pkgManifest = JSON.parse(strFromU8(sniffZip["manifest.json"])); } catch { throw bad("manifest.json is not valid JSON"); } }
  }
  assertSafeXlsx(xlsx);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(xlsx as unknown as ExcelJS.Buffer); } catch { throw bad("The workbook could not be read"); }
  if (wb.worksheets.length > 10) throw bad("Too many sheets");
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw bad(`Sheet "${SHEET}" not found. Use the file exported by LocaleLens.`);

  let manifest = pkgManifest;
  const meta = wb.getWorksheet(META);
  if (meta) {
    let json = "";
    for (let r = 1; r <= meta.rowCount; r++) json += cellText(meta.getCell(r, 1).value, `${META}!A${r}`);
    try { manifest = JSON.parse(json); } catch { throw bad("Embedded manifest is corrupt"); }
  }
  if (manifest && (manifest.format !== "localelens-translation-package" || manifest.version !== 1)) throw bad("Unsupported package version");

  if (ws.rowCount > LIMITS.maxRows + 1) throw bad(`Too many rows (max ${LIMITS.maxRows})`);
  const header = ws.getRow(1);
  const names: string[] = [];
  header.eachCell({ includeEmpty: false }, (cell, i) => { names[i] = cellText(cell.value, `header ${i}`).trim(); });
  for (let i = 0; i < HEAD.length; i++) if (names[i + 1] !== HEAD[i]) throw bad(`Column ${i + 1} must be "${HEAD[i]}" (found "${names[i + 1] ?? ""}")`);
  const localeCols: { col: number; locale: string }[] = [];
  for (let i = 5; i < names.length; i++) if (names[i]) localeCols.push({ col: i, locale: names[i] });
  if (!localeCols.length) throw bad("No locale columns found");
  if (localeCols.length > LIMITS.maxLocales) throw bad("Too many locale columns");
  for (const l of localeCols) if (!/^[A-Za-z][\w-]{0,31}$/.test(l.locale)) throw bad(`Invalid locale header ${JSON.stringify(l.locale.slice(0, 40))}`);

  const rows: IncomingRow[] = [];
  const warnings: string[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (c: number) => cellText(row.getCell(c).value, `${SHEET}!R${r}C${c}`);
    const [id, workspaceId, namespace, key] = [1, 2, 3, 4].map(get).map((s) => s.trim());
    if (!workspaceId && !namespace && !key && !id) continue;
    if (!workspaceId || !namespace || !key) throw bad(`Row ${r}: Workspace, Namespace and Key are required`);
    if (!/^[\w$-]+(\.[\w$-]+)*$/.test(key)) throw bad(`Row ${r}: invalid key ${JSON.stringify(key.slice(0, 60))}`);
    if (!/^[\w-]{1,40}$/.test(workspaceId) || !/^[\w.-]{1,60}$/.test(namespace)) throw bad(`Row ${r}: invalid workspace or namespace`);
    if (id && id !== entryId(workspaceId, namespace, key)) throw bad(`Row ${r}: ID does not match Workspace/Namespace/Key (identity columns were edited)`);
    const values: Values = {};
    for (const { col, locale } of localeCols) {
      const v = get(col);
      if (v.length > LIMITS.maxCellChars) throw bad(`Row ${r}: ${locale} text is longer than ${LIMITS.maxCellChars} characters`);
      values[locale] = v;
      if (/^[=+\-@]/.test(v) && !/^[-+]?\d/.test(v)) warnings.push(`Row ${r} (${key}, ${locale}) starts with a formula character; imported as plain text`);
    }
    rows.push({ id: id || undefined, workspaceId, namespace, key, values, rowNumber: r });
  }
  const seen = new Set<string>();
  for (const r of rows) { const k = entryId(r.workspaceId, r.namespace, r.key); if (seen.has(k)) throw bad(`Row ${r.rowNumber}: duplicate key ${r.key}`); seen.add(k); }
  return { manifest, rows, warnings };
}
