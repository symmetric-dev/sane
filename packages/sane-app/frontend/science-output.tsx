import { useMemo, useState } from "react";
import type { MarimoCell, MarimoOutput } from "../../sane-science/src/marimo-contracts";
import { ShellDialog } from "./shell-dialog";
import "./science-output.css";

export interface ScienceBlockDTO {
  id: string;
  title: string;
  cell: MarimoCell;
  /** Supplied by the owner; idle alone does not prove execution succeeded. */
  execution?: "succeeded" | "failed" | "unknown" | "not-requested";
  /** Previous output can remain visible while code is edited or run. */
  outputStale?: boolean;
}

export interface ScienceBlockCardProps {
  block: ScienceBlockDTO;
  busy?: boolean;
  actionError?: string;
  onEdit?: (block: ScienceBlockDTO) => void;
  onRun?: (block: ScienceBlockDTO) => void;
  onShare?: (block: ScienceBlockDTO) => void;
}

type TableValue = string | number | boolean | null;
export interface ScienceTableData {
  columns: string[];
  rows: Record<string, TableValue>[];
  totalRows: number;
}

type Display =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "table"; table: ScienceTableData }
  | { kind: "unsupported"; message: string; fallback?: string };

const MAX_TEXT = 100_000;
const MAX_IMAGE = 16_000_000;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 50;
const BUNDLE = "application/vnd.marimo+mimebundle";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageSource(mimetype: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_IMAGE) return null;
  const prefix = `data:${mimetype};base64,`;
  const encoded = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  // Only inline raster bytes: never remote URLs, SVG, HTML, or arbitrary data URLs.
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const header = atob(encoded.slice(0, 16));
    const valid = mimetype === "image/png"
      ? header.startsWith("\x89PNG\r\n\x1a\n")
      : header.startsWith("\xff\xd8\xff");
    return valid ? prefix + encoded : null;
  } catch {
    return null;
  }
}

function decodeAttribute(value: string): string {
  // Decode only the entities needed by Marimo's serialized JSON attributes.
  // No HTML is parsed into a DOM, mounted, or evaluated.
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };
    const known = named[entity.toLowerCase()];
    if (known !== undefined) return known;
    const hex = entity[2]?.toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  });
}

function attributes(source: string): Map<string, string> | null {
  const result = new Map<string, string>();
  const pattern = /\s+([a-z][a-z0-9-]*)=(?:'([^']*)'|"([^"]*)")/gy;
  let position = 0;
  while (position < source.length) {
    if (!source.slice(position).trim()) break;
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match || result.has(match[1])) return null;
    result.set(match[1], decodeAttribute(match[2] ?? match[3] ?? ""));
    position = pattern.lastIndex;
  }
  return result;
}

/** Marimo 0.25.1 live DataFrame output: UI wrapper > table, data-data is JSON of a JSON string. */
function staticMarimoTable(html: string): ScienceTableData | null {
  if (html.length > 2_000_000) return null;
  const match = /^\s*<marimo-ui-element([^<>]*)>\s*<marimo-table([^<>]*)>\s*<\/marimo-table>\s*<\/marimo-ui-element>\s*$/.exec(html);
  if (!match || !attributes(match[1])) return null;
  const attrs = attributes(match[2]);
  if (!attrs || attrs.get("data-lazy") !== "false") return null;
  try {
    const encoded: unknown = JSON.parse(attrs.get("data-data") ?? "null");
    if (typeof encoded !== "string") return null;
    const rows: unknown = JSON.parse(encoded);
    const fields: unknown = JSON.parse(attrs.get("data-field-types") ?? "null");
    const hidden: unknown = JSON.parse(attrs.get("data-hidden-columns") ?? "null");
    const headers: unknown = JSON.parse(attrs.get("data-row-headers") ?? "null");
    // Index/hidden-column semantics need their own supported adapter.
    if (!Array.isArray(hidden) || hidden.length || !Array.isArray(headers) || headers.length) return null;
    if (!Array.isArray(rows) || !Array.isArray(fields) || !fields.length || fields.length > MAX_TABLE_COLUMNS) return null;
    const columns: string[] = [];
    for (const field of fields) {
      if (!Array.isArray(field) || typeof field[0] !== "string" || columns.includes(field[0])) return null;
      columns.push(field[0]);
    }
    if (Number(attrs.get("data-total-columns")) !== columns.length) return null;
    const totalRows = Number(attrs.get("data-total-rows"));
    if (!Number.isSafeInteger(totalRows) || totalRows < rows.length) return null;
    const visible: Record<string, TableValue>[] = [];
    for (const row of rows) {
      if (!record(row) || Object.keys(row).length !== columns.length) return null;
      for (const column of columns) {
        if (!Object.hasOwn(row, column)) return null;
        const value = row[column];
        if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) return null;
      }
      if (visible.length < MAX_TABLE_ROWS) visible.push(row as Record<string, TableValue>);
    }
    return { columns, rows: visible, totalRows };
  } catch {
    return null;
  }
}

function representation(mimetype: string, data: unknown): Display | null {
  if (mimetype === "text/plain" && typeof data === "string") return { kind: "text", text: data };
  if (mimetype === "image/png" || mimetype === "image/jpeg") {
    const src = imageSource(mimetype, data);
    if (src) return { kind: "image", src };
  }
  if (mimetype === "text/html" && typeof data === "string") {
    const table = staticMarimoTable(data);
    if (table) return { kind: "table", table };
  }
  return null;
}

function displayOutput(output: MarimoOutput): Display {
  if (output.mimetype === BUNDLE) {
    try {
      const bundle: unknown = typeof output.data === "string" ? JSON.parse(output.data) : output.data;
      if (record(bundle)) {
        for (const mime of ["image/png", "image/jpeg", "text/html"]) {
          const display = representation(mime, bundle[mime]);
          if (display) return display;
        }
        const fallback = typeof bundle["text/plain"] === "string" ? bundle["text/plain"] : undefined;
        if (Object.keys(bundle).every(mime => mime === "text/plain") && fallback !== undefined) return { kind: "text", text: fallback };
        return { kind: "unsupported", message: "This rich or interactive output is not supported in native blocks.", fallback };
      }
    } catch { /* Malformed bundle is presented as unsupported, never as markup. */ }
    return { kind: "unsupported", message: "The Marimo output bundle could not be read." };
  }
  return representation(output.mimetype, output.data) ?? {
    kind: "unsupported",
    message: `Unsupported output (${output.mimetype}). Interactive widgets and arbitrary HTML are not rendered.`,
    fallback: typeof output.data === "string" ? output.data : JSON.stringify(output.data, null, 2),
  };
}

export function ScienceTextOutput({ text, channel }: { text: string; channel?: string }) {
  return <div className={`science-text-output${channel === "stderr" || channel?.endsWith(" error") ? " science-output-stderr" : ""}`}>
    {channel && channel !== "stdout" && <div className="science-output-label">{channel}</div>}
    <pre>{text.slice(0, MAX_TEXT)}</pre>
    {text.length > MAX_TEXT && <p className="science-output-note">Output truncated to {MAX_TEXT.toLocaleString()} characters.</p>}
  </div>;
}

function RasterImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="science-output-note">The image could not be decoded.</p>
    : <img className="science-output-image" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export function ScienceTableOutput({ table }: { table: ScienceTableData }) {
  const rows = table.rows.slice(0, MAX_TABLE_ROWS);
  return <div className="science-table-output">
    <p className="science-output-note">{rows.length.toLocaleString()} of {table.totalRows.toLocaleString()} rows</p>
    <div className="science-table-scroll" tabIndex={0} role="region" aria-label="Science table">
      <table><caption className="science-output-sr-only">Science output table</caption>
        <thead><tr>{table.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{table.columns.map(column => <td key={column}>{row[column] === null ? <span className="science-output-note">null</span> : String(row[column]).slice(0, 2_000)}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {rows.some(row => table.columns.some(column => String(row[column]).length > 2_000)) && <p className="science-output-note">Long cell values are truncated to 2,000 characters.</p>}
  </div>;
}

export function ScienceOutput({ output, imageAlt = "Science output plot" }: { output: MarimoOutput; imageAlt?: string }) {
  const display = useMemo(() => displayOutput(output), [output]);
  if (display.kind === "text") return display.text ? <ScienceTextOutput text={display.text} channel={output.channel === "output" ? undefined : output.channel} /> : null;
  if (display.kind === "image") return <RasterImage key={display.src} src={display.src} alt={imageAlt} />;
  if (display.kind === "table") return <ScienceTableOutput table={display.table} />;
  return <div className="science-output-unsupported">
    <p>{display.message}</p>
    {display.fallback && <details><summary>Text fallback</summary><ScienceTextOutput text={display.fallback} /></details>}
  </div>;
}

export function ScienceBlockCard({ block, busy = false, actionError, onEdit, onRun, onShare }: ScienceBlockCardProps) {
  const [info, setInfo] = useState(false);
  const { cell } = block;
  const running = busy || cell.status === "running" || cell.status === "queued";
  const hasOutput = cell.consoleOutputs.length > 0 || cell.output !== null;
  return <section className="science-block-card" aria-label={block.title} aria-busy={running}>
    <header className="science-block-header">
      <h3>{block.title}</h3>
      {running && <span className="science-block-status" role="status">Running…</span>}
      <div className="science-block-actions">
        {onEdit && <button type="button" disabled={running} onClick={() => onEdit(block)}>Edit</button>}
        {onRun && <button type="button" disabled={running} onClick={() => onRun(block)}>Run</button>}
        {onShare && <button type="button" disabled={running} onClick={() => onShare(block)}>Share</button>}
        <button type="button" onClick={() => setInfo(true)}>Info</button>
      </div>
    </header>
    <pre className="science-block-source"><code>{cell.code || "# Empty cell"}</code></pre>
    {block.execution === "failed" && <p className="science-block-error" role="status">Run failed.</p>}
    {block.execution === "unknown" && <p className="science-block-error" role="status">Run outcome unconfirmed.</p>}
    {(block.outputStale || cell.status === "stale") && <p className="science-output-note">Output may be from an earlier run.</p>}
    <div className="science-block-output">
      {cell.consoleOutputs.map((output, index) => <ScienceOutput key={`${output.timestamp}-${index}`} output={output} />)}
      {cell.output && <ScienceOutput output={cell.output} imageAlt={`${block.title} — image output`} />}
      {!hasOutput && !cell.errors.length && <p className="science-output-note">{running ? "Waiting for output…" : "No output captured."}</p>}
      {cell.errors.map((error, index) => <ScienceTextOutput key={index} text={error.message} channel={`${error.kind} error`} />)}
    </div>
    {actionError && <p className="science-block-error" role="alert">{actionError}</p>}
    {info && <ShellDialog title="Python output info" close={() => setInfo(false)}><div className="science-output-info"><p>Output is a runtime observation; execution provenance is not asserted. Shared snapshots contain source and supported text only; images and interactive output are omitted.</p><pre>{JSON.stringify(block, null, 2)}</pre></div></ShellDialog>}
  </section>;
}
