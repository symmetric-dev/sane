import { Hono } from "hono"
import {
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE,
  DASHBOARD_TERMINAL_VIEW_SCROLLBACK_ROUTE_PATH_TEMPLATE,
} from "@agenv/workstreams/internal/dashboard-contracts"

import type { DashboardServerConfig } from "../config.ts"
import { DASHBOARD_LIVE_PATH } from "./live.ts"

export const DASHBOARD_HOME_PATH = "/"

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function renderDashboardClientScript(repoRoot: string): string {
  return [
    `const repoRoot = ${JSON.stringify(repoRoot)}`,
    `const snapshotPath = ${JSON.stringify(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path)}`,
    `const source = new EventSource(${JSON.stringify(DASHBOARD_LIVE_PATH)})`,
    `const stateBanner = document.getElementById("state-banner")`,
    `const dashboard = document.getElementById("dashboard")`,
    `const dashboardShell = document.getElementById("dashboard-shell")`,
    `const leftPane = document.getElementById("dashboard-left-pane")`,
    `const centerPane = document.getElementById("dashboard-center-pane")`,
    `const rightPane = document.getElementById("dashboard-right-pane")`,
    `const workstreamTitle = document.getElementById("workstream-title")`,
    `const workstreamMeta = document.getElementById("workstream-meta")`,
    `const connectionStatus = document.getElementById("connection-status")`,
    `const statusBadge = document.getElementById("status-badge")`,
    `const statusSummary = document.getElementById("status-summary")`,
    `const runtimeSummary = document.getElementById("runtime-summary")`,
    `const statusStages = document.getElementById("status-stages")`,
    `const statusPanel = document.getElementById("status-panel")`,
    `const leftSidebarOverviewButton = document.getElementById("left-sidebar-overview-button")`,
    `const leftSidebarTreeButton = document.getElementById("left-sidebar-tree-button")`,
    `const treeBody = document.getElementById("tree-body")`,
    `const treeCount = document.getElementById("tree-count")`,
    `const treeLevelControls = document.getElementById("tree-level-controls")`,
    `const treePanel = document.getElementById("tree-panel")`,
    `const terminalSessionSummary = document.getElementById("terminal-session-summary")`,
    `const terminalSessionList = document.getElementById("terminal-session-list")`,
    `const terminalViewSummary = document.getElementById("terminal-view-summary")`,
    `const terminalViewSelect = document.getElementById("terminal-view-select")`,
    `const terminalViewStatus = document.getElementById("terminal-view-status")`,
    `const terminalViewDetails = document.getElementById("terminal-view-details")`,
    `const terminalViewOpenLink = document.getElementById("terminal-view-open-link")`,
    `const terminalPickerPanel = document.getElementById("terminal-picker-panel")`,
    `const terminalPanel = document.getElementById("terminal-panel")`,
    `const scrollbackMeta = document.getElementById("terminal-scrollback-meta")`,
    `const scrollbackFrame = document.getElementById("terminal-scrollback-frame")`,
    `const scrollbackEditorMount = document.getElementById("terminal-scrollback-editor")`,
    `const scrollbackFallback = document.getElementById("terminal-scrollback-fallback")`,
    `const scrollbackEmpty = document.getElementById("terminal-scrollback-empty")`,
    `const scrollbackControls = document.getElementById("terminal-scrollback-controls")`,
    `const terminalViewFrame = document.getElementById("terminal-view-frame")`,
    `const terminalScrollbackPathTemplate = ${JSON.stringify(DASHBOARD_TERMINAL_VIEW_SCROLLBACK_ROUTE_PATH_TEMPLATE)}`,
    "const monacoLoaderUrl = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js'",
    "const monacoVsPath = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'",
    "const scrollbackEditorFallbackHeightPx = 560",
    "const terminalFrameHeightPx = 336",
    "const state = { selectedTerminalViewId: null, snapshot: null, liveConnectionState: 'connecting', snapshotAvailability: 'loading', scrollback: null, scrollbackLoading: false, scrollbackRenderToken: 0, pendingScrollIntent: null, leftSidebarView: 'overview', treeLevels: { stage: true, batch: true, thread: true } }",
    "let monacoEditor = null",
    "let monacoLoaderPromise = null",
    "const scrollbackPageSize = 1200",
    "const scrollbackLineStepPx = 120",
    "function escapeHtml(value) {",
    "  return String(value)",
    "    .replaceAll('&', '&amp;')",
    "    .replaceAll('<', '&lt;')",
    "    .replaceAll('>', '&gt;')",
    "    .replaceAll('\"', '&quot;')",
    "    .replaceAll(\"'\", '&#39;')",
    "}",
    "function showState(kind, message, details) {",
    "  if (!stateBanner) return",
    "  stateBanner.hidden = false",
    "  stateBanner.dataset.kind = kind",
    "  stateBanner.innerHTML = '<div>' + escapeHtml(message) + '</div>' + (details ? '<div class=\"state-actions muted\">' + escapeHtml(details) + '</div>' : '') + ((kind === 'error' || kind === 'warning') ? '<div class=\"state-actions\"><button id=\"retry-button\" type=\"button\">Retry</button></div>' : '')",
    "  const retryButton = document.getElementById('retry-button')",
    "  if (retryButton) retryButton.addEventListener('click', () => { void refreshSnapshot('manual retry') })",
    "}",
    "function hideState() { if (stateBanner) stateBanner.hidden = true }",
    "function setConnectionStatus(message) { if (connectionStatus) connectionStatus.textContent = message }",
    "function updateConnectionStatus() {",
    "  if (state.snapshotAvailability === 'unavailable') { setConnectionStatus('Snapshot unavailable'); return }",
    "  if (state.liveConnectionState === 'reconnecting') { setConnectionStatus('Live updates reconnecting…'); return }",
    "  if (state.liveConnectionState === 'connected') { setConnectionStatus('Live updates connected'); return }",
    "  setConnectionStatus('Connecting to live updates…')",
    "}",
    "function setLiveConnectionState(nextState) { state.liveConnectionState = nextState; updateConnectionStatus() }",
    "function setSnapshotAvailability(nextState) { state.snapshotAvailability = nextState; updateConnectionStatus() }",
    "function setBadge(element, status, label) { if (!element) return; element.dataset.status = status; element.textContent = label }",
    "function labelStatus(status) { return String(status).replaceAll('_', ' ') }",
    "function setLeftSidebarView(view) {",
    "  if (view !== 'overview' && view !== 'tree') return",
    "  state.leftSidebarView = view",
    "  renderLeftSidebarView()",
    "}",
    "function renderLeftSidebarView() {",
    "  const showingOverview = state.leftSidebarView === 'overview'",
    "  if (statusPanel) statusPanel.hidden = !showingOverview",
    "  if (treePanel) treePanel.hidden = showingOverview",
    "  if (leftSidebarOverviewButton) { leftSidebarOverviewButton.setAttribute('aria-pressed', showingOverview ? 'true' : 'false'); leftSidebarOverviewButton.dataset.active = showingOverview ? 'true' : 'false' }",
    "  if (leftSidebarTreeButton) { leftSidebarTreeButton.setAttribute('aria-pressed', showingOverview ? 'false' : 'true'); leftSidebarTreeButton.dataset.active = showingOverview ? 'false' : 'true' }",
    "}",
    "function titleCaseWorkstreamName(value) {",
    "  const words = String(value || '').replace(/^\\d+[-_ ]+/, '').split(/[-_\\s]+/).filter(Boolean)",
    "  if (words.length === 0) return 'Current Workstream'",
    "  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')",
    "}",
    "function formatWorkstreamTitle(stream) {",
    "  const id = stream && stream.id ? String(stream.id) : ''",
    "  const name = stream && stream.name ? String(stream.name) : id",
    "  const numberMatch = id.match(/^(\\d+)(?:[-_ ].*)?$/)",
    "  const title = titleCaseWorkstreamName(name || id)",
    "  return numberMatch ? title + ' (' + numberMatch[1] + ')' : title",
    "}",
    "function formatDateTime(value) {",
    "  try { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return String(value) }",
    "}",
    "function formatTerminalScope(prefix, stageId, batchId) { const scope = [stageId, batchId].filter(Boolean).join(' '); return scope ? prefix + ' ' + scope : prefix + ' terminal' }",
    "function formatTerminalSessionLabel(session) { return formatTerminalScope(session && session.role === 'implementation_thread' ? 'Implementation' : 'Supervision', session && (session.stage_id || (session.correlation && session.correlation.stage_id)), session && (session.batch_id || (session.correlation && session.correlation.batch_id))) }",
    "function buildTerminalScrollbackPath(terminalViewId, params) {",
    "  const encodedId = encodeURIComponent(terminalViewId)",
    "  const path = terminalScrollbackPathTemplate.replace(':' + 'terminalViewId', encodedId)",
    "  const search = []",
    "  if (params && typeof params.limit === 'number') search.push('limit=' + encodeURIComponent(String(params.limit)))",
    "  if (params && typeof params.offset === 'number') search.push('offset=' + encodeURIComponent(String(params.offset)))",
    "  return search.length > 0 ? path + '?' + search.join('&') : path",
    "}",
    "function getScrollbackViewportHeightPx() {",
    "  const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? Math.round(window.innerHeight * 0.75) : 0",
    "  return Math.max(scrollbackEditorFallbackHeightPx, viewportHeight)",
    "}",
    "function applyTerminalHeights() {",
    "  const scrollbackHeight = getScrollbackViewportHeightPx()",
    "  if (scrollbackFrame && scrollbackFrame.style) scrollbackFrame.style.height = scrollbackHeight + 'px'",
    "  if (scrollbackEditorMount && scrollbackEditorMount.style) scrollbackEditorMount.style.height = scrollbackHeight + 'px'",
    "  if (scrollbackFallback && scrollbackFallback.style) scrollbackFallback.style.height = scrollbackHeight + 'px'",
    "  if (scrollbackEmpty && scrollbackEmpty.style) scrollbackEmpty.style.height = scrollbackHeight + 'px'",
    "  if (terminalViewFrame && terminalViewFrame.style) terminalViewFrame.style.minHeight = terminalFrameHeightPx + 'px'",
    "  const iframe = terminalViewFrame && typeof terminalViewFrame.querySelector === 'function' ? terminalViewFrame.querySelector('iframe') : null",
    "  if (iframe && iframe.style) iframe.style.height = terminalFrameHeightPx + 'px'",
    "  if (monacoEditor && typeof monacoEditor.layout === 'function' && scrollbackEditorMount) monacoEditor.layout({ width: scrollbackEditorMount.clientWidth || 0, height: scrollbackHeight })",
    "}",
    "function setScrollbackControlsDisabled(disabled) {",
    "  if (!scrollbackControls) return",
    "  const buttons = Array.from(scrollbackControls.querySelectorAll('button'))",
    "  for (const button of buttons) button.disabled = disabled",
    "}",
    "function ensureMonacoEditor() {",
    "  if (monacoEditor || !scrollbackEditorMount) return Promise.resolve(monacoEditor)",
    "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve(null)",
    "  const createEditor = () => {",
    "    if (monacoEditor || !scrollbackEditorMount || !globalThis.monaco || !globalThis.monaco.editor) return monacoEditor",
    "    try {",
    "      monacoEditor = globalThis.monaco.editor.create(scrollbackEditorMount, {",
    "        value: '',",
    "        language: 'shell',",
    "        readOnly: true,",
    "        automaticLayout: false,",
    "        minimap: { enabled: false },",
    "        lineNumbers: 'off',",
    "        wordWrap: 'on',",
    "        scrollBeyondLastLine: false,",
    "        renderLineHighlight: 'none',",
    "        overviewRulerLanes: 0,",
    "        glyphMargin: false,",
    "        folding: false,",
    "        fontSize: 12,",
    "        theme: 'vs-dark',",
    "      })",
    "      applyTerminalHeights()",
    "      return monacoEditor",
    "    } catch {",
    "      return null",
    "    }",
    "  }",
    "  if (globalThis.monaco && globalThis.monaco.editor) return Promise.resolve(createEditor())",
    "  if (monacoLoaderPromise) return monacoLoaderPromise",
    "  monacoLoaderPromise = new Promise((resolve) => {",
    "    const finish = () => {",
    "      const amdRequire = globalThis.require",
    "      if (!amdRequire || typeof amdRequire.config !== 'function') { resolve(null); return }",
    "      amdRequire.config({ paths: { vs: monacoVsPath } })",
    "      amdRequire(['vs/editor/editor.main'], () => resolve(createEditor()), () => resolve(null))",
    "    }",
    "    const existing = typeof document.querySelector === 'function' ? document.querySelector('script[data-dashboard-monaco-loader=\"true\"]') : null",
    "    if (existing) {",
    "      if (globalThis.monaco && globalThis.monaco.editor) { resolve(createEditor()); return }",
    "      existing.addEventListener('load', finish, { once: true })",
    "      existing.addEventListener('error', () => resolve(null), { once: true })",
    "      return",
    "    }",
    "    const script = document.createElement('script')",
    "    script.src = monacoLoaderUrl",
    "    script.async = true",
    "    script.dataset.dashboardMonacoLoader = 'true'",
    "    script.addEventListener('load', finish, { once: true })",
    "    script.addEventListener('error', () => resolve(null), { once: true })",
    "    if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(script)",
    "    else resolve(null)",
    "  })",
    "  return monacoLoaderPromise",
    "}",
    "function renderScrollbackText(text, token) {",
    "  const commit = (editor) => {",
    "    if (token !== state.scrollbackRenderToken) return",
    "    if (editor && scrollbackEditorMount && scrollbackFallback && scrollbackEmpty) {",
      "      scrollbackEditorMount.hidden = false",
      "      scrollbackFallback.hidden = true",
      "      scrollbackEmpty.hidden = true",
      "      if (typeof editor.getValue === 'function' && editor.getValue() !== text && typeof editor.setValue === 'function') editor.setValue(text)",
      "      applyTerminalHeights()",
      "      applyPendingScrollIntent(state.scrollback)",
      "      return",
      "    }",
    "    if (scrollbackEditorMount) scrollbackEditorMount.hidden = true",
    "    if (scrollbackFallback) { scrollbackFallback.hidden = false; scrollbackFallback.textContent = text }",
    "    if (scrollbackEmpty) scrollbackEmpty.hidden = true",
    "    applyPendingScrollIntent(state.scrollback)",
    "  }",
    "  ensureMonacoEditor().then((editor) => commit(editor)).catch(() => commit(null))",
    "}",
    "function setFallbackScrollTop(nextTop) { if (scrollbackFallback) scrollbackFallback.scrollTop = Math.max(0, nextTop) }",
    "function scrollScrollbackViewport(direction) {",
    "  if (monacoEditor && typeof monacoEditor.getScrollTop === 'function' && typeof monacoEditor.setScrollTop === 'function') {",
    "    const nextTop = direction === 'up' ? monacoEditor.getScrollTop() - scrollbackLineStepPx : monacoEditor.getScrollTop() + scrollbackLineStepPx",
    "    monacoEditor.setScrollTop(Math.max(0, nextTop))",
    "    return",
    "  }",
    "  if (scrollbackFallback) setFallbackScrollTop((scrollbackFallback.scrollTop || 0) + (direction === 'up' ? -scrollbackLineStepPx : scrollbackLineStepPx))",
    "}",
    "function applyPendingScrollIntent(scrollback) {",
    "  const intent = state.pendingScrollIntent",
    "  state.pendingScrollIntent = null",
    "  if (!intent || !scrollback || scrollback.status !== 'available') return",
    "  if (intent === 'bottom') {",
    "    if (monacoEditor && typeof monacoEditor.getScrollHeight === 'function' && typeof monacoEditor.setScrollTop === 'function') monacoEditor.setScrollTop(monacoEditor.getScrollHeight())",
    "    else if (scrollbackFallback) setFallbackScrollTop(scrollbackFallback.scrollHeight || 0)",
    "  } else if (intent === 'top') {",
    "    if (monacoEditor && typeof monacoEditor.setScrollTop === 'function') monacoEditor.setScrollTop(0)",
    "    else if (scrollbackFallback) setFallbackScrollTop(0)",
    "  }",
    "}",
    "function renderMetricCard(title, value, note) {",
    "  return '<div class=\"summary-card\"><div class=\"muted\">' + escapeHtml(title) + '</div><div class=\"summary-value\">' + escapeHtml(value) + '</div>' + (note ? '<div class=\"meta\">' + escapeHtml(note) + '</div>' : '') + '</div>'",
    "}",
    "function renderStageRow(stage) {",
    "  const counts = stage.counts",
    "  return '<div class=\"status-row\"><div class=\"status-row-head\"><span class=\"badge\" data-status=\"' + escapeHtml(stage.status) + '\">' + escapeHtml(labelStatus(stage.status)) + '</span><strong>' + escapeHtml(stage.stage_id) + ' · ' + escapeHtml(stage.title) + '</strong></div><div class=\"status-note\">' + escapeHtml(counts.done + '/' + counts.total + ' done · ' + counts.in_progress + ' active · ' + counts.blocked + ' blocked · ' + counts.pending + ' pending') + '</div></div>'",
    "}",
    "function renderRuntimeEntry(entry) {",
    "  if (entry.kind === 'batch') {",
    "    return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.entry_status) + '\">' + escapeHtml(entry.entry_status) + '</span><strong>Batch ' + escapeHtml(entry.batch_id) + '</strong></div><div class=\"runtime-note\">items ' + escapeHtml(labelStatus(entry.execution_status)) + ' · runtime ' + escapeHtml(entry.runtime_status) + ' · ' + escapeHtml(entry.summary.thread_summary.running) + ' running / ' + escapeHtml(entry.summary.thread_summary.failed) + ' failed</div></div>'",
    "  }",
    "  if (entry.kind === 'supervision') {",
    "    return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.summary.status) + '\">' + escapeHtml(entry.summary.status) + '</span><strong>Supervision · ' + escapeHtml(entry.target) + '</strong></div><div class=\"runtime-note\">stage ' + escapeHtml(entry.stage_id) + (entry.batch_id ? ' · batch ' + escapeHtml(entry.batch_id) : '') + (entry.execution_status ? ' · items ' + escapeHtml(labelStatus(entry.execution_status)) : '') + '</div></div>'",
    "  }",
    "  return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.summary.status) + '\">' + escapeHtml(entry.summary.status) + '</span><strong>Supervision branch · ' + escapeHtml(entry.target) + '</strong></div><div class=\"runtime-note\">' + escapeHtml(entry.summary.status) + (entry.batch_id ? ' · batch ' + escapeHtml(entry.batch_id) : '') + (entry.execution_status ? ' · items ' + escapeHtml(labelStatus(entry.execution_status)) : '') + '</div></div>'",
    "}",
    "function renderRuntimeSummary(runtime) {",
    "  if (!runtime) return '<div class=\"empty\">No runtime summary is available for this workstream.</div>'",
    "  if (!runtime.entries || runtime.entries.length === 0) return '<div class=\"empty\">Runtime exists but no batch or supervision entries are currently active.</div>'",
    "  return runtime.entries.map((entry) => renderRuntimeEntry(entry)).join('')",
    "}",
    "function renderTreeRow(node, depth) {",
    "  const countLabel = node.itemCount + ' item' + (node.itemCount === 1 ? '' : 's')",
    "  const note = node.kind === 'batch' && node.runtimeOverlay ? node.runtimeOverlay.text : ''",
    "  const assignee = node.assignedAgent ? ' · @' + node.assignedAgent : ''",
    "  return '<li class=\"tree-row\" data-kind=\"' + escapeHtml(node.kind) + '\" style=\"--tree-depth:' + escapeHtml(String(depth)) + '\"><span class=\"tree-kind\">' + escapeHtml(node.kind) + '</span><span class=\"badge\" data-status=\"' + escapeHtml(node.status) + '\">' + escapeHtml(labelStatus(node.status)) + '</span><strong>' + escapeHtml(node.displayLabel) + '</strong><span class=\"tree-meta\">' + escapeHtml(countLabel + assignee) + '</span>' + (note ? '<span class=\"tree-note\">' + escapeHtml(note) + '</span>' : '') + '</li>'",
    "}",
    "function collectTreeRows(node, depth, rows) {",
    "  if (node.kind !== 'workstream' && state.treeLevels[node.kind]) rows.push(renderTreeRow(node, depth))",
    "  if (node.kind === 'workstream') { if (node.runtimeNotice) rows.push('<li class=\"tree-row tree-row-notice\"><span class=\"tree-kind\">runtime</span><span class=\"tree-note\">' + escapeHtml(node.runtimeNotice.text) + '</span></li>'); for (const stage of node.stages) collectTreeRows(stage, 0, rows) }",
    "  else if (node.kind === 'stage') { for (const batch of node.batches) collectTreeRows(batch, 1, rows) }",
    "  else if (node.kind === 'batch') { for (const thread of node.threads) collectTreeRows(thread, 2, rows) }",
    "}",
    "function renderTree(tree) {",
    "  if (!tree || tree.itemCount === 0) return '<div class=\"empty\">No items were found in the canonical snapshot.</div>'",
    "  const rows = []",
    "  collectTreeRows(tree, 0, rows)",
    "  if (rows.length === 0) return '<div class=\"empty\">No selected work tree levels are visible. Enable a level above to show matching rows.</div>'",
    "  return '<ul class=\"tree-list\">' + rows.join('') + '</ul>'",
    "}",
    "function renderTmuxSessions(observability) {",
    "  const tmux = observability && observability.tmux",
    "  const sessions = tmux && tmux.sessions ? tmux.sessions : []",
    "  if (terminalSessionSummary) terminalSessionSummary.textContent = tmux && tmux.availability === 'ready' ? 'Matched terminal sessions for this workstream.' : tmux && tmux.availability === 'degraded' ? 'Some terminal session details are degraded.' : 'No matched terminal session details are available.'",
    "  if (!terminalSessionList) return",
    "  if (sessions.length === 0) { terminalSessionList.innerHTML = '<li class=\"empty\">No matched terminal sessions.</li>'; return }",
    "  terminalSessionList.innerHTML = sessions.map((session) => {",
    "    const scope = [session.stage_id, session.batch_id, session.thread_id, session.run_id].filter(Boolean).join(' · ')",
    "    const details = [session.session_id, session.state, session.correlation.status, session.pane_count + ' pane' + (session.pane_count === 1 ? '' : 's'), session.window_name || null].filter(Boolean).map(escapeHtml).join(' · ')",
    "    return '<li class=\"terminal-session-row\"><div><strong>' + escapeHtml(formatTerminalSessionLabel(session)) + '</strong><div class=\"terminal-note\">session ' + escapeHtml(session.session_name) + '</div><div class=\"terminal-note\">' + details + '</div>' + (scope ? '<div class=\"terminal-note\">' + escapeHtml(scope) + '</div>' : '') + '</div><span class=\"badge\" data-status=\"' + escapeHtml(session.state) + '\">' + escapeHtml(session.role) + '</span></li>'",
    "  }).join('')",
    "}",
    "function renderTerminalViews(observability) {",
    "  const terminalViews = observability && observability.terminal_views",
    "  const views = terminalViews && terminalViews.views ? terminalViews.views : []",
    "  const requestedView = views.find((view) => view.terminal_view_id === state.selectedTerminalViewId) || null",
    "  const firstEmbeddableView = views.find((view) => view.status !== 'unavailable') || null",
    "  const fallbackView = firstEmbeddableView || views[0] || null",
    "  if (state.selectedTerminalViewId && !requestedView) state.selectedTerminalViewId = fallbackView ? fallbackView.terminal_view_id : null",
    "  const selectedView = requestedView || fallbackView",
    "  const embeddableView = selectedView && selectedView.status !== 'unavailable' ? selectedView : null",
    "  if (!state.selectedTerminalViewId && selectedView) state.selectedTerminalViewId = selectedView.terminal_view_id",
    "  if (terminalViewSummary) terminalViewSummary.textContent = terminalViews && terminalViews.availability === 'ready' ? 'Choose a read-only tmux session to inspect from the dashboard.' : terminalViews && terminalViews.availability === 'degraded' ? 'Read-only terminal observability is degraded, but canonical status remains primary.' : 'Read-only terminal observability is unavailable; canonical status remains primary.'",
    "  if (terminalViewSelect) {",
    "    terminalViewSelect.disabled = views.length === 0",
    "    terminalViewSelect.innerHTML = views.length === 0 ? '<option value=\"\">No observable terminal views</option>' : views.map((view) => '<option value=\"' + escapeHtml(view.terminal_view_id) + '\"' + (view.terminal_view_id === state.selectedTerminalViewId ? ' selected' : '') + '>' + escapeHtml(view.label) + '</option>').join('')",
    "    if (state.selectedTerminalViewId) terminalViewSelect.value = state.selectedTerminalViewId",
    "  }",
    "  if (terminalViewStatus) {",
    "    if (!selectedView) { terminalViewStatus.hidden = true; terminalViewStatus.textContent = '' }",
    "    else { terminalViewStatus.hidden = false; terminalViewStatus.dataset.status = selectedView.status; terminalViewStatus.textContent = selectedView.status }",
    "  }",
    "  if (terminalViewDetails) {",
    "    if (!selectedView) terminalViewDetails.innerHTML = ''",
    "    else terminalViewDetails.innerHTML = '<div><strong>' + escapeHtml(selectedView.label) + '</strong></div><div class=\"terminal-note\">' + escapeHtml(selectedView.role) + ' · session ' + escapeHtml(selectedView.session_name) + ' · read-only</div>' + (selectedView.notes ? '<div class=\"terminal-note\">' + escapeHtml(selectedView.notes) + '</div>' : '')",
    "  }",
    "  if (terminalViewOpenLink) {",
    "    if (!selectedView) { terminalViewOpenLink.hidden = true; terminalViewOpenLink.removeAttribute('href') }",
    "    else { terminalViewOpenLink.hidden = false; terminalViewOpenLink.setAttribute('href', selectedView.routes.view_path) }",
    "  }",
    "  const showScrollbackFallback = Boolean(state.selectedTerminalViewId) && !embeddableView",
    "  if (terminalViewFrame) {",
    "    if (!state.selectedTerminalViewId && !selectedView) { terminalViewFrame.hidden = false; terminalViewFrame.innerHTML = '<div style=\"padding: 1rem;\" class=\"empty\">Select a terminal view to inspect the read-only terminal surface.</div>' }",
    "    else if (embeddableView) { terminalViewFrame.hidden = false; terminalViewFrame.innerHTML = '<iframe src=\"' + escapeHtml(embeddableView.routes.ttyd_proxy_path) + '\" title=\"' + escapeHtml(embeddableView.label) + '\"></iframe>' }",
    "    else { terminalViewFrame.hidden = true; terminalViewFrame.innerHTML = '' }",
    "  }",
    "  if (scrollbackControls) scrollbackControls.hidden = !showScrollbackFallback",
    "  if (scrollbackMeta) scrollbackMeta.hidden = !showScrollbackFallback",
    "  if (scrollbackFrame) scrollbackFrame.hidden = !showScrollbackFallback",
    "  applyTerminalHeights()",
    "}",
    "function renderScrollback(scrollback) {",
    "  state.scrollback = scrollback || null",
    "  state.scrollbackRenderToken += 1",
    "  const renderToken = state.scrollbackRenderToken",
    "  setScrollbackControlsDisabled(state.scrollbackLoading || !state.selectedTerminalViewId)",
    "  if (scrollbackMeta) {",
    "    if (!state.selectedTerminalViewId) scrollbackMeta.textContent = ''",
    "    else if (scrollback && scrollback.status === 'available') scrollbackMeta.textContent = 'Lines ' + (scrollback.offset + 1) + '–' + scrollback.end_offset + ' of ' + scrollback.total_lines + (scrollback.pane_title ? ' · pane ' + scrollback.pane_title : '') + (state.scrollbackLoading ? ' · updating…' : '')",
    "    else if (state.scrollbackLoading) scrollbackMeta.textContent = 'Loading scrollback…'",
    "    else scrollbackMeta.textContent = scrollback && scrollback.notes ? scrollback.notes : ''",
    "  }",
    "  if (scrollbackFrame) scrollbackFrame.setAttribute('aria-busy', state.scrollbackLoading ? 'true' : 'false')",
    "  if (!scrollbackEditorMount || !scrollbackFallback || !scrollbackEmpty) return",
    "  if (!state.selectedTerminalViewId) { scrollbackEditorMount.hidden = true; scrollbackFallback.hidden = true; scrollbackEmpty.hidden = false; scrollbackEmpty.textContent = 'Select a terminal view to inspect tmux scrollback.'; return }",
    "  if (state.scrollbackLoading && state.scrollback && state.scrollback.status === 'available') return",
    "  if (!scrollback || scrollback.status !== 'available') { scrollbackEditorMount.hidden = true; scrollbackFallback.hidden = true; scrollbackEmpty.hidden = false; scrollbackEmpty.textContent = scrollback && scrollback.notes ? scrollback.notes : 'No tmux history is currently available for this view.'; return }",
    "  renderScrollbackText(scrollback.lines.join('\\n'), renderToken)",
    "}",
    "async function refreshScrollback(reason, options) {",
    "  if (!state.selectedTerminalViewId) { renderScrollback(null); return }",
    "  state.scrollbackLoading = true",
    "  renderScrollback(state.scrollback)",
    "  try {",
    "    const response = await fetch(buildTerminalScrollbackPath(state.selectedTerminalViewId, { limit: scrollbackPageSize, ...(options && typeof options.offset === 'number' ? { offset: options.offset } : {}) }), { headers: { accept: 'application/json' } })",
    "    const scrollback = await response.json()",
    "    state.scrollbackLoading = false",
    "    renderScrollback(scrollback)",
    "  } catch (error) {",
    "    state.scrollbackLoading = false",
    "    renderScrollback({ terminal_view_id: state.selectedTerminalViewId, session_name: '', captured_at: new Date().toISOString(), read_only: true, status: 'unavailable', total_lines: 0, offset: 0, limit: scrollbackPageSize, end_offset: 0, is_at_top: true, is_at_bottom: true, lines: [], notes: error instanceof Error ? error.message : 'Failed to load tmux scrollback.' })",
    "  }",
    "}",
    "function getNextScrollbackOffset(action) {",
    "  const scrollback = state.scrollback",
    "  if (!scrollback || scrollback.status !== 'available') return undefined",
    "  const maxOffset = Math.max(0, scrollback.total_lines - scrollback.limit)",
    "  if (action === 'page-up') return Math.max(0, scrollback.offset - scrollback.limit)",
    "  if (action === 'page-down') return Math.min(maxOffset, scrollback.offset + scrollback.limit)",
    "  if (action === 'bottom') return maxOffset",
    "  return undefined",
    "}",
    "if (treeLevelControls) {",
    "  treeLevelControls.addEventListener('change', (event) => {",
    "    const input = event.target instanceof Element ? event.target.closest('input[data-tree-level]') : null",
    "    if (!input) return",
    "    const level = input.getAttribute('data-tree-level')",
    "    if (!level || !(level in state.treeLevels)) return",
    "    state.treeLevels[level] = Boolean(input.checked)",
    "    const tree = state.snapshot && state.snapshot.canonical_state && state.snapshot.canonical_state.tree",
    "    if (treeBody && tree) treeBody.innerHTML = renderTree(tree)",
    "  })",
    "}",
    "if (leftSidebarOverviewButton) leftSidebarOverviewButton.addEventListener('click', () => { setLeftSidebarView('overview') })",
    "if (leftSidebarTreeButton) leftSidebarTreeButton.addEventListener('click', () => { setLeftSidebarView('tree') })",
    "if (terminalViewSelect) {",
    "  terminalViewSelect.addEventListener('change', () => {",
    "    const terminalViewId = terminalViewSelect.value || ''",
    "    state.selectedTerminalViewId = terminalViewId.length > 0 ? terminalViewId : null",
    "    if (state.snapshot) renderTerminalViews(state.snapshot.observability)",
    "    state.pendingScrollIntent = 'bottom'",
    "    void refreshScrollback('selection change')",
    "  })",
    "}",
    "if (scrollbackControls) {",
    "  scrollbackControls.addEventListener('click', (event) => {",
    "    const button = event.target instanceof Element ? event.target.closest('button[data-scroll-action]') : null",
    "    if (!button) return",
    "    const action = button.getAttribute('data-scroll-action')",
    "    if (!action) return",
    "    if (action === 'up' || action === 'down') { scrollScrollbackViewport(action); return }",
    "    const nextOffset = getNextScrollbackOffset(action)",
    "    if (typeof nextOffset !== 'number') return",
    "    state.pendingScrollIntent = action === 'page-up' ? 'top' : 'bottom'",
    "    void refreshScrollback(action, { offset: nextOffset })",
    "  })",
    "}",
    "function renderSnapshot(snapshot, reason) {",
    "  const status = snapshot && snapshot.canonical_state && snapshot.canonical_state.status",
    "  const tree = snapshot && snapshot.canonical_state && snapshot.canonical_state.tree",
    "  const observability = snapshot && snapshot.observability",
    "  const runtime = snapshot && snapshot.canonical_state && snapshot.canonical_state.runtime",
    "  if (!status || !tree) throw new Error('Snapshot payload is missing canonical workstream data.')",
    "  state.snapshot = snapshot",
    "  setSnapshotAvailability('ready')",
    "  hideState()",
    "  if (dashboard) dashboard.hidden = false",
    "  if (workstreamTitle) workstreamTitle.textContent = formatWorkstreamTitle(status.stream)",
    "  if (workstreamMeta) workstreamMeta.textContent = 'structured runtime · generated ' + formatDateTime(snapshot.generated_at)",
    "  setBadge(statusBadge, status.aggregate_status, labelStatus(status.aggregate_status))",
    "  if (statusSummary) statusSummary.innerHTML = [renderMetricCard('Items', String(status.counts.total), status.counts.done + ' done · ' + status.counts.in_progress + ' active'), renderMetricCard('Completion', status.completion.percent_done + '%', status.completion.done_items + ' done · ' + status.completion.remaining_items + ' remaining'), renderMetricCard('Workstream', formatWorkstreamTitle(status.stream), status.stream.is_current ? 'current' : 'not current'), renderMetricCard('Generated', formatDateTime(snapshot.generated_at), reason ? 'last refresh: ' + reason : 'canonical snapshot')].join('')",
    "  if (runtimeSummary) runtimeSummary.innerHTML = renderRuntimeSummary(runtime)",
    "  if (statusStages) statusStages.innerHTML = status.stages.length > 0 ? status.stages.map((stage) => renderStageRow(stage)).join('') : '<div class=\"empty\">No stages were found in the canonical snapshot.</div>'",
    "  if (treeCount) treeCount.textContent = tree.itemCount + ' item' + (tree.itemCount === 1 ? '' : 's')",
    "  if (treeBody) treeBody.innerHTML = renderTree(tree)",
    "  renderLeftSidebarView()",
    "  renderTmuxSessions(observability)",
    "  renderTerminalViews(observability)",
    "  if (!state.scrollback) state.pendingScrollIntent = 'bottom'",
    "  void refreshScrollback(reason)",
    "}",
    "async function refreshSnapshot(reason) {",
    "  setConnectionStatus(reason ? 'Refreshing snapshot (' + reason + ')…' : 'Refreshing snapshot…')",
    "  showState('loading', 'Loading canonical snapshot…')",
    "  try {",
    "    const response = await fetch(snapshotPath, { headers: { accept: 'application/json' } })",
    "    if (!response.ok) throw new Error('Snapshot request failed with ' + response.status)",
    "    const snapshot = await response.json()",
    "    renderSnapshot(snapshot, reason)",
    "    updateConnectionStatus()",
    "  } catch (error) {",
    "    const message = error instanceof Error ? error.message : 'Failed to load the canonical snapshot.'",
    "    const hasSnapshot = Boolean(state.snapshot)",
    "    setSnapshotAvailability('unavailable')",
    "    showState(hasSnapshot ? 'warning' : 'error', message, hasSnapshot ? 'The last successful canonical snapshot remains visible while the backend recovers.' : 'The dashboard can reconnect once the backend snapshot is available.')",
    "    if (!hasSnapshot && dashboard) dashboard.hidden = true",
    "  }",
    "}",
    "source.onopen = () => { setLiveConnectionState('connected') }",
    "source.addEventListener('snapshot', () => { void refreshSnapshot('live snapshot event') })",
    "source.addEventListener('observability', () => { void refreshSnapshot('live observability event') })",
    "source.addEventListener('heartbeat', () => { setLiveConnectionState('connected') })",
    "source.addEventListener('error', (event) => {",
    "  if (!(event instanceof MessageEvent)) return",
    "  let payload = null",
    "  try { payload = JSON.parse(event.data) } catch { payload = null }",
    "  const message = payload && typeof payload.message === 'string' ? payload.message : 'Snapshot unavailable from the backend.'",
    "  const details = payload && payload.retryable === false ? 'The dashboard will keep retrying for a fresh canonical snapshot.' : 'The dashboard will keep retrying and reconnect when the snapshot returns.'",
    "  setSnapshotAvailability('unavailable')",
    "  showState(state.snapshot ? 'warning' : 'error', message, details)",
    "  if (!state.snapshot && dashboard) dashboard.hidden = true",
    "})",
    "source.onerror = () => { if (state.snapshotAvailability !== 'unavailable') setLiveConnectionState('reconnecting') }",
    "if (typeof addEventListener === 'function') addEventListener('resize', () => { applyTerminalHeights() })",
    "applyTerminalHeights()",
    "void refreshSnapshot('initial load')",
  ].join("\n")
}

function renderDashboardShell(config: DashboardServerConfig): string {
  const repoRoot = escapeHtml(config.repoRoot)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workstream Dashboard</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b0b0b; color: #f4f4f4; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #0b0b0b; color: #f4f4f4; }
      main { display: grid; gap: 1rem; margin: 0 auto; max-width: 88rem; padding: 1.5rem; }
      .masthead, .panel, .state { background: #111; }
      .panel, .state { border: 1px solid #242424; }
      .masthead, .panel { padding: 1rem; }
      .masthead { display: grid; gap: 0.35rem; }
      .eyebrow, .muted, .meta, .empty, .state { color: #a7a7a7; }
      h1, h2, p { margin: 0; }
      h1 { font-size: clamp(1.5rem, 2.5vw, 2.2rem); line-height: 1.1; letter-spacing: -0.03em; }
      h2 { font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.12em; color: #d7d7d7; }
      code, pre, .mono { font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace; }
      .layout { display: grid; gap: 1rem; }
      .dashboard-shell { display: grid; gap: 1rem; grid-template-columns: minmax(18rem, 0.92fr) minmax(0, 1.45fr) minmax(18rem, 0.92fr); align-items: start; }
      .shell-pane { display: grid; gap: 1rem; align-content: start; }
      .shell-pane-center { grid-template-rows: auto 1fr; }
      .shell-pane-left, .shell-pane-right { position: relative; }
      @media (max-width: 1200px) { .dashboard-shell { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .shell-pane-right { grid-column: 1 / -1; } }
      @media (max-width: 800px) { .dashboard-shell { grid-template-columns: minmax(0, 1fr); } }
      .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.9rem; }
      .summary-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
      .summary-card, .status-row, .runtime-entry, .issue { border: 1px solid #232323; background: #0d0d0d; }
      .summary-card { display: grid; gap: 0.25rem; padding: 0.75rem; }
      .summary-value { font-size: 1.05rem; font-weight: 600; }
      .badge { display: inline-flex; align-items: center; gap: 0.35rem; border: 1px solid #2a2a2a; border-radius: 999px; padding: 0.18rem 0.55rem; font-size: 0.78rem; line-height: 1.1; white-space: nowrap; }
      .badge[data-status="completed"], .badge[data-status="ready"] { color: #b9f6c5; border-color: #23402b; }
      .badge[data-status="in_progress"], .badge[data-status="running"] { color: #b9d9ff; border-color: #243a55; }
      .badge[data-status="blocked"], .badge[data-status="failed"], .badge[data-status="unavailable"], .badge[data-status="error"] { color: #ffb7b7; border-color: #4a2323; }
      .badge[data-status="pending"], .badge[data-status="degraded"], .badge[data-status="stopped"] { color: #ddd; }
      .stack { display: grid; gap: 0.5rem; }
      .left-sidebar-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .left-sidebar-nav button[data-active="true"] { background: #243a55; border-color: #37577c; color: #d9ecff; }
      .status-row { display: grid; gap: 0.4rem; padding: 0.7rem; }
      .status-row-head, .issue-head, .runtime-entry-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; }
      .status-stages, .tree-list, .runtime-list, .issue-list { display: grid; gap: 0.5rem; }
      .runtime-entry, .issue { padding: 0.7rem; }
      .tree-root { display: grid; gap: 0.6rem; }
      .tree-list { padding-left: 0; margin: 0; list-style: none; gap: 0; border-top: 1px solid #232323; }
      .tree-row { display: grid; grid-template-columns: 4.4rem max-content minmax(12rem, 1fr) max-content; align-items: baseline; gap: 0.55rem; padding: 0.55rem 0; padding-left: calc(var(--tree-depth, 0) * 1.35rem); border-bottom: 1px solid #1b1b1b; }
      .tree-row-notice { grid-template-columns: 4.4rem 1fr; padding-left: 0; }
      .tree-kind { color: #777; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.11em; }
      .tree-level-controls { display: flex; flex-wrap: wrap; gap: 0.45rem; }
      .tree-level-controls label { display: inline-flex; align-items: center; gap: 0.35rem; color: #d7d7d7; border: 1px solid #252525; border-radius: 999px; padding: 0.25rem 0.6rem; background: #101010; }
      .tree-level-controls input { accent-color: #8ec5ff; }
      .tree-meta, .tree-note, .status-note, .runtime-note, .issue-note, .terminal-note { color: #a7a7a7; font-size: 0.86rem; }
      @media (max-width: 800px) { .tree-row { grid-template-columns: 1fr; padding-left: 0; } }
      .state { padding: 1rem; }
      .state[data-kind="warning"] { color: #fff0c7; border-color: #5a4a23; }
      .state[data-kind="error"] { color: #ffd3d3; border-color: #4a2323; }
      .state-actions { margin-top: 0.8rem; }
      button { appearance: none; border: 1px solid #2c2c2c; background: #161616; color: #f4f4f4; padding: 0.42rem 0.75rem; border-radius: 0.45rem; font: inherit; }
      button:hover { background: #1d1d1d; }
      .subgrid { display: grid; gap: 0.75rem; }
      .terminal-session-list { display: grid; gap: 0; list-style: none; padding: 0; margin: 0; border-top: 1px solid #232323; }
      .terminal-session-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.6rem; align-items: baseline; padding: 0.55rem 0; border-bottom: 1px solid #1b1b1b; }
      .terminal-selector-card { display: grid; gap: 0.6rem; padding: 0; }
      .terminal-selector-row, .selector-details-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.6rem; align-items: center; }
      .terminal-selector-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
      .terminal-select { width: min(100%, 34rem); border: 1px solid #2c2c2c; background: #161616; color: #f4f4f4; padding: 0.55rem 0.75rem; border-radius: 0.45rem; font: inherit; }
      .terminal-link { color: #8ec5ff; text-decoration: none; }
      .terminal-link:hover { text-decoration: underline; }
      .terminal-frame, .terminal-scrollback-frame { border: 1px solid #232323; background: #050505; min-height: 21rem; overflow: hidden; }
      .terminal-frame iframe { border: 0; display: block; width: 100%; height: 21rem; }
      .panel-shell { display: grid; gap: 1rem; }
      .panel-shell > .panel { min-height: 0; }
      .terminal-scrollback-frame { position: relative; overflow: hidden; }
      .terminal-scrollback-editor { width: 100%; height: 560px; }
      .terminal-scrollback-pre, .terminal-scrollback-empty { margin: 0; min-height: 560px; height: 560px; padding: 1rem; white-space: pre-wrap; word-break: break-word; overflow: auto; }
      .terminal-scrollback-empty { display: flex; align-items: center; }
      .terminal-controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <header class="masthead">
        <p class="eyebrow">Current workstream</p>
        <h1 id="workstream-title">Loading current workstream…</h1>
        <p id="workstream-meta" class="muted">structured runtime</p>
        <p id="connection-status" class="muted">Connecting to live updates…</p>
      </header>

      <section id="state-banner" class="state" data-kind="loading">Loading canonical snapshot…</section>

      <div id="dashboard" class="layout dashboard-shell" hidden>
        <aside id="dashboard-left-pane" class="shell-pane shell-pane-left" aria-label="Status and work tree">
          <nav id="left-sidebar-nav" class="panel left-sidebar-nav" aria-label="Left sidebar views">
            <button id="left-sidebar-overview-button" type="button" aria-pressed="true" data-active="true">Overview</button>
            <button id="left-sidebar-tree-button" type="button" aria-pressed="false" data-active="false">Tree</button>
          </nav>
          <section id="status-panel" class="panel" aria-labelledby="status-heading">
            <div class="panel-head">
              <h2 id="status-heading">Status overview</h2>
              <span id="status-badge" class="badge" data-status="pending">pending</span>
            </div>
            <div id="status-summary" class="summary-grid"></div>
            <div id="runtime-summary" class="stack" style="margin-top: 1rem;"></div>
            <div id="status-stages" class="status-stages" style="margin-top: 1rem;"></div>
          </section>

          <section id="tree-panel" class="panel" aria-labelledby="tree-heading" hidden>
            <div class="panel-head">
              <h2 id="tree-heading">Work tree</h2>
              <span id="tree-count" class="muted"></span>
            </div>
            <div id="tree-level-controls" class="tree-level-controls" aria-label="Work tree visible levels">
              <label><input type="checkbox" data-tree-level="stage" checked /> Stage level</label>
              <label><input type="checkbox" data-tree-level="batch" checked /> Batch level</label>
              <label><input type="checkbox" data-tree-level="thread" checked /> Thread level</label>
            </div>
            <div id="tree-body" class="tree-root"></div>
          </section>
        </aside>

        <section id="dashboard-center-pane" class="shell-pane shell-pane-center" aria-label="Terminal focus">
          <section id="terminal-panel" class="panel panel-shell" aria-labelledby="terminal-heading">
            <div class="panel-head">
              <h2 id="terminal-heading">Read-only terminal</h2>
              <span class="muted">ttyd-backed embed</span>
            </div>
            <div class="subgrid">
              <div id="terminal-view-frame" class="terminal-frame">
                <div style="padding: 1rem;" class="empty">Select an observable terminal view to embed the read-only ttyd session.</div>
              </div>
              <div class="terminal-selector-row">
                <div id="terminal-scrollback-controls" class="terminal-controls">
                  <button type="button" data-scroll-action="up">Up</button>
                  <button type="button" data-scroll-action="down">Down</button>
                  <button type="button" data-scroll-action="page-up">Page up</button>
                  <button type="button" data-scroll-action="page-down">Page down</button>
                  <button type="button" data-scroll-action="bottom">Bottom</button>
                </div>
                <span id="terminal-scrollback-meta" class="muted"></span>
              </div>
              <div id="terminal-scrollback-frame" class="terminal-scrollback-frame">
                <div id="terminal-scrollback-editor" class="terminal-scrollback-editor" hidden></div>
                <pre id="terminal-scrollback-fallback" class="terminal-scrollback-pre" hidden></pre>
                <div id="terminal-scrollback-empty" class="terminal-scrollback-empty empty">Select a terminal view to inspect tmux scrollback.</div>
              </div>
            </div>
          </section>
        </section>

        <aside id="dashboard-right-pane" class="shell-pane shell-pane-right" aria-label="Terminal session picker">
          <section id="terminal-picker-panel" class="panel" aria-labelledby="terminal-picker-heading">
            <div class="panel-head">
              <h2 id="terminal-picker-heading">Terminal session picker</h2>
              <span class="muted">readonly selection</span>
            </div>
            <p id="terminal-view-summary" class="muted">Loading terminal views…</p>
            <div class="terminal-selector-card">
              <div class="terminal-selector-row">
                <select id="terminal-view-select" class="terminal-select" aria-label="Select a terminal view">
                  <option>Waiting for snapshot data…</option>
                </select>
                <div class="terminal-selector-actions">
                  <span id="terminal-view-status" class="badge" data-status="pending" hidden>pending</span>
                  <a id="terminal-view-open-link" class="terminal-link" href="#" hidden>Open standalone view</a>
                </div>
              </div>
              <div id="terminal-view-details" class="stack">
                <div class="empty">Select a terminal view to inspect its status and actions.</div>
              </div>
            </div>
            <details style="margin-top: 1rem;">
              <summary>Matched terminal sessions</summary>
              <p id="terminal-session-summary" class="muted" style="margin-top: 0.75rem;">Loading session details…</p>
              <ul id="terminal-session-list" class="terminal-session-list" style="margin-top: 0.75rem;">
                <li class="empty">Waiting for snapshot data…</li>
              </ul>
            </details>
          </section>
        </aside>
      </div>
    </main>

    <script type="module">
${renderDashboardClientScript(repoRoot)
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n")}
    </script>
  </body>
</html>`
}

export function createUiRoutes(config: DashboardServerConfig): Hono {
  const app = new Hono()

  app.get(DASHBOARD_HOME_PATH, () => {
    return new Response(renderDashboardShell(config), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  })

  return app
}
