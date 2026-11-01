import { FiChevronDown, FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { CodeShareSnapshot } from "../shared/code-share-contract";
import { codeShareSnippetPresentation } from "./code-share-presentation";
import { ChatIconButton } from "./chat-ui";

export function SharedCodeNavigation({ snippets, page, select, panelId }: { snippets: readonly CodeShareSnapshot[]; page: number; select: (index: number) => void; panelId: string }) {
  return <nav className="shared-code-pagination" aria-label="Code snippet navigation">
    <ChatIconButton aria-label="Previous snippet" aria-controls={panelId} disabled={page === 0} onClick={() => select(page - 1)}><FiChevronLeft /></ChatIconButton>
    <div className="shared-code-picker">
      <select aria-label="Code snippet" aria-controls={panelId} value={page} onChange={event => select(Number(event.currentTarget.value))}>
        {snippets.map((snippet, index) => {
          const { tabTitle, tooltip } = codeShareSnippetPresentation(snippet);
          // biome-ignore lint/suspicious/noArrayIndexKey: Snapshot pages have immutable order and may contain identical snippets.
          return <option key={index} value={index} title={tooltip}>Snippet {index + 1} of {snippets.length} · {tabTitle}</option>;
        })}
      </select>
      <FiChevronDown aria-hidden="true" />
    </div>
    <ChatIconButton aria-label="Next snippet" aria-controls={panelId} disabled={page === snippets.length - 1} onClick={() => select(page + 1)}><FiChevronRight /></ChatIconButton>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">Snippet {page + 1} of {snippets.length}</span>
  </nav>;
}
