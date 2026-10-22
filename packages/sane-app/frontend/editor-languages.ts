import type { Extension } from "@codemirror/state";
import type { LanguageSupport } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

function codeLanguage(name: string): LanguageSupport | null {
  switch (name.toLowerCase().replace(/^\./, "")) {
    case "js": case "mjs": case "cjs": case "javascript": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "ts": case "mts": case "cts": case "typescript": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "json": return json();
    case "css": return css();
    case "html": case "htm": return html();
    case "py": case "python": return python();
    default: return null;
  }
}

/** Use the same syntax support in shared snippets, files, artifacts and diffs.
 * Unknown fence languages remain plain text; no code is evaluated. */
export function editorLanguage(format: string): Extension {
  const name = format.toLowerCase().replace(/^\./, "");
  if (name === "md" || name === "markdown") return markdown({ base: markdownLanguage, codeLanguages: info => codeLanguage(info)?.language ?? null });
  return codeLanguage(name) ?? [];
}
