import { Hono } from "hono"
import { CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE } from "../../../workstreams/src/internal/dashboard-contracts.ts"

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

function renderDashboardClientScript(repoRoot: string): string {
  return [
    `const repoRoot = ${JSON.stringify(repoRoot)}`,
    `const snapshotPath = ${JSON.stringify(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path)}`,
    `const source = new EventSource(${JSON.stringify(DASHBOARD_LIVE_PATH)})`,
    `const stateBanner = document.getElementById("state-banner")`,
    `const dashboard = document.getElementById("dashboard")`,
    `const workstreamTitle = document.getElementById("workstream-title")`,
    `const workstreamMeta = document.getElementById("workstream-meta")`,
    `const connectionStatus = document.getElementById("connection-status")`,
    `const statusBadge = document.getElementById("status-badge")`,
    `const observabilityBadge = document.getElementById("observability-badge")`,
    `const statusSummary = document.getElementById("status-summary")`,
    `const runtimeSummary = document.getElementById("runtime-summary")`,
    `const statusStages = document.getElementById("status-stages")`,
    `const treeBody = document.getElementById("tree-body")`,
    `const treeCount = document.getElementById("tree-count")`,
    `const tmuxSummary = document.getElementById("tmux-summary")`,
    `const tmuxList = document.getElementById("tmux-list")`,
    `const terminalViewSummary = document.getElementById("terminal-view-summary")`,
    `const terminalViewList = document.getElementById("terminal-view-list")`,
    `const terminalViewFrame = document.getElementById("terminal-view-frame")`,
    `const observabilityIssues = document.getElementById("observability-issues")`,
    "const state = { selectedTerminalViewId: null, snapshot: null }",
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
    "  stateBanner.innerHTML = '<div>' + escapeHtml(message) + '</div>' + (details ? '<div class=\"state-actions muted\">' + escapeHtml(details) + '</div>' : '') + (kind === 'error' ? '<div class=\"state-actions\"><button id=\"retry-button\" type=\"button\">Retry</button></div>' : '')",
    "  const retryButton = document.getElementById('retry-button')",
    "  if (retryButton) retryButton.addEventListener('click', () => { void refreshSnapshot('manual retry') })",
    "}",
    "function hideState() { if (stateBanner) stateBanner.hidden = true }",
    "function setConnectionStatus(message) { if (connectionStatus) connectionStatus.textContent = message }",
    "function setBadge(element, status, label) { if (!element) return; element.dataset.status = status; element.textContent = label }",
    "function labelStatus(status) { return String(status).replaceAll('_', ' ') }",
    "function renderMetricCard(title, value, note) {",
    "  return '<div class=\"summary-card\"><div class=\"muted\">' + escapeHtml(title) + '</div><div class=\"summary-value\">' + escapeHtml(value) + '</div>' + (note ? '<div class=\"meta\">' + escapeHtml(note) + '</div>' : '') + '</div>'",
    "}",
    "function renderStageRow(stage) {",
    "  const counts = stage.counts",
    "  return '<div class=\"status-row\"><div class=\"status-row-head\"><span class=\"badge\" data-status=\"' + escapeHtml(stage.status) + '\">' + escapeHtml(labelStatus(stage.status)) + '</span><strong>' + escapeHtml(stage.stage_id) + ' · ' + escapeHtml(stage.title) + '</strong></div><div class=\"status-note\">' + escapeHtml(counts.done + '/' + counts.total + ' done · ' + counts.in_progress + ' active · ' + counts.blocked + ' blocked · ' + counts.pending + ' pending') + '</div></div>'",
    "}",
    "function renderRuntimeEntry(entry) {",
    "  if (entry.kind === 'batch') {",
    "    return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.entry_status) + '\">' + escapeHtml(entry.entry_status) + '</span><strong>Batch ' + escapeHtml(entry.batch_id) + '</strong></div><div class=\"runtime-note\">tasks ' + escapeHtml(labelStatus(entry.task_status)) + ' · runtime ' + escapeHtml(entry.runtime_status) + ' · ' + escapeHtml(entry.summary.thread_summary.running) + ' running / ' + escapeHtml(entry.summary.thread_summary.failed) + ' failed</div></div>'",
    "  }",
    "  if (entry.kind === 'supervision') {",
    "    return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.summary.status) + '\">' + escapeHtml(entry.summary.status) + '</span><strong>Supervision · ' + escapeHtml(entry.target) + '</strong></div><div class=\"runtime-note\">stage ' + escapeHtml(entry.stage_id) + (entry.batch_id ? ' · batch ' + escapeHtml(entry.batch_id) : '') + (entry.task_status ? ' · tasks ' + escapeHtml(labelStatus(entry.task_status)) : '') + '</div></div>'",
    "  }",
    "  return '<div class=\"runtime-entry\"><div class=\"runtime-entry-head\"><span class=\"badge\" data-status=\"' + escapeHtml(entry.summary.status) + '\">' + escapeHtml(entry.summary.status) + '</span><strong>Supervision branch · ' + escapeHtml(entry.target) + '</strong></div><div class=\"runtime-note\">' + escapeHtml(entry.summary.status) + (entry.batch_id ? ' · batch ' + escapeHtml(entry.batch_id) : '') + (entry.task_status ? ' · tasks ' + escapeHtml(labelStatus(entry.task_status)) : '') + '</div></div>'",
    "}",
    "function renderRuntimeSummary(runtime) {",
    "  if (!runtime) return '<div class=\"empty\">No runtime summary is available for this workstream.</div>'",
    "  if (!runtime.entries || runtime.entries.length === 0) return '<div class=\"empty\">Runtime exists but no batch or supervision entries are currently active.</div>'",
    "  return runtime.entries.map((entry) => renderRuntimeEntry(entry)).join('')",
    "}",
    "function renderTreeNode(node, depth) {",
    "  const countLabel = node.taskCount + ' task' + (node.taskCount === 1 ? '' : 's')",
    "  const parts = ['<div class=\"tree-node-head\"><span class=\"badge\" data-status=\"' + escapeHtml(node.status) + '\">' + escapeHtml(node.status) + '</span><strong>' + escapeHtml(node.displayLabel) + '</strong></div>', '<div class=\"tree-meta\">' + escapeHtml(countLabel) + (node.assignedAgent ? ' · @' + escapeHtml(node.assignedAgent) : '') + '</div>']",
    "  if (node.kind === 'batch' && node.runtimeOverlay) parts.push('<div class=\"tree-note\">' + escapeHtml(node.runtimeOverlay.text) + '</div>')",
    "  if (node.kind === 'workstream' && node.runtimeNotice) parts.push('<div class=\"tree-note\">Runtime: ' + escapeHtml(node.runtimeNotice.text) + '</div>')",
    "  const children = []",
    "  if (node.kind === 'workstream') { for (const stage of node.stages) children.push(renderTreeNode(stage, depth + 1)) }",
    "  else if (node.kind === 'stage') { for (const batch of node.batches) children.push(renderTreeNode(batch, depth + 1)) }",
    "  else if (node.kind === 'batch') { for (const thread of node.threads) children.push(renderTreeNode(thread, depth + 1)) }",
    "  else if (node.kind === 'thread') { for (const task of node.tasks) children.push(renderTreeNode(task, depth + 1)) }",
    "  return '<li><div class=\"tree-node\">' + parts.join('') + '</div>' + (children.length > 0 ? '<ul class=\"tree-children\" data-depth=\"' + depth + '\">' + children.join('') + '</ul>' : '') + '</li>'",
    "}",
    "function renderTree(tree) {",
    "  if (!tree || tree.taskCount === 0) return '<div class=\"empty\">No tasks were found in the canonical snapshot.</div>'",
    "  return '<ul class=\"tree-list\">' + renderTreeNode(tree, 1) + '</ul>'",
    "}",
    "function renderObservabilityIssues(observability) {",
    "  const issues = (observability && observability.issues) ? observability.issues : []",
    "  if (issues.length === 0) return '<div class=\"empty\">Observability is ready; no degradation markers were reported.</div>'",
    "  return issues.map((issue) => '<div class=\"issue\"><div class=\"issue-head\"><span class=\"badge\" data-status=\"' + escapeHtml(issue.severity) + '\">' + escapeHtml(issue.code) + '</span><strong>' + escapeHtml(issue.message) + '</strong></div>' + (issue.related_ids && issue.related_ids.length > 0 ? '<div class=\"issue-note\">' + escapeHtml(issue.related_ids.join(', ')) + '</div>' : '') + '</div>').join('')",
    "}",
    "function renderTmuxSessions(observability) {",
    "  const tmux = observability && observability.tmux",
    "  const sessions = tmux && tmux.sessions ? tmux.sessions : []",
    "  if (tmuxSummary) tmuxSummary.textContent = tmux && tmux.availability === 'ready' ? 'tmux observability is ready for the current workstream.' : tmux && tmux.availability === 'degraded' ? 'tmux observability is degraded, but canonical status remains primary.' : 'tmux observability is unavailable; canonical status remains primary.'",
    "  if (!tmuxList) return",
    "  if (sessions.length === 0) { tmuxList.innerHTML = '<li class=\"empty\">No tmux sessions matched this workstream snapshot.</li>'; return }",
    "  tmuxList.innerHTML = sessions.map((session) => {",
    "    const scope = [session.stage_id, session.batch_id, session.thread_id, session.run_id].filter(Boolean).join(' · ')",
    "    const details = [session.session_id, session.state, session.correlation.status, session.pane_count + ' pane' + (session.pane_count === 1 ? '' : 's'), session.window_name || null].filter(Boolean).map(escapeHtml).join(' · ')",
    "    return '<li class=\"tmux-card\"><div class=\"tmux-row\"><div><strong>' + escapeHtml(session.session_name) + '</strong><div class=\"terminal-note\">' + details + '</div>' + (scope ? '<div class=\"terminal-note\">' + escapeHtml(scope) + '</div>' : '') + '</div><span class=\"badge\" data-status=\"' + escapeHtml(session.state) + '\">' + escapeHtml(session.role) + '</span></div></li>'",
    "  }).join('')",
    "}",
    "function renderTerminalViews(observability) {",
    "  const terminalViews = observability && observability.terminal_views",
    "  const views = terminalViews && terminalViews.views ? terminalViews.views : []",
    "  const requestedView = views.find((view) => view.terminal_view_id === state.selectedTerminalViewId) || null",
    "  const availableView = views.find((view) => view.status === 'available') || null",
    "  const selectedView = requestedView || availableView",
    "  const embeddableView = requestedView ? (requestedView.status === 'available' ? requestedView : null) : availableView",
    "  state.selectedTerminalViewId = selectedView ? selectedView.terminal_view_id : null",
    "  if (terminalViewSummary) terminalViewSummary.textContent = terminalViews && terminalViews.availability === 'ready' ? 'Select a ttyd-backed session to embed its read-only terminal.' : terminalViews && terminalViews.availability === 'degraded' ? 'Read-only terminal observability is degraded, but canonical status remains primary.' : 'Read-only terminal observability is unavailable; canonical status remains primary.'",
    "  if (terminalViewList) {",
    "    if (views.length === 0) { terminalViewList.innerHTML = '<li class=\"empty\">No read-only ttyd views are currently available.</li>' } else {",
    "      terminalViewList.innerHTML = views.map((view) => {",
    "        const selected = view.terminal_view_id === state.selectedTerminalViewId",
    "        const notes = view.notes ? '<div class=\"terminal-note\">' + escapeHtml(view.notes) + '</div>' : ''",
    "        return '<li class=\"terminal-card\"><div class=\"terminal-row\"><button type=\"button\" class=\"terminal-button' + (selected ? ' selected' : '') + '\" data-terminal-view-id=\"' + escapeHtml(view.terminal_view_id) + '\"><strong>' + escapeHtml(view.label) + '</strong><div class=\"terminal-note\">' + escapeHtml(view.session_name) + ' · ' + escapeHtml(view.status) + ' · read-only</div></button><a href=\"' + escapeHtml(view.routes.view_path) + '\">open view</a></div><div class=\"terminal-note\">Proxy: <code>' + escapeHtml(view.routes.ttyd_proxy_path) + '</code></div>' + notes + '</li>'",
    "      }).join('')",
    "    }",
    "  }",
    "  if (terminalViewFrame) {",
    "    if (!embeddableView) { terminalViewFrame.innerHTML = views.length === 0 ? '<div style=\"padding: 1rem;\" class=\"empty\">No read-only ttyd views are currently available.</div>' : '<div style=\"padding: 1rem;\" class=\"empty\">No available ttyd terminal is ready to embed. Visible views are degraded or unavailable.</div>' } else { terminalViewFrame.innerHTML = '<iframe src=\"' + escapeHtml(embeddableView.routes.ttyd_proxy_path) + '\" title=\"' + escapeHtml(embeddableView.label) + '\"></iframe>' }",
    "  }",
    "}",
    "if (terminalViewList) {",
    "  terminalViewList.addEventListener('click', (event) => {",
    "    const button = event.target instanceof Element ? event.target.closest('button[data-terminal-view-id]') : null",
    "    if (!button) return",
    "    const terminalViewId = button.getAttribute('data-terminal-view-id')",
    "    if (!terminalViewId) return",
    "    state.selectedTerminalViewId = terminalViewId",
    "    if (state.snapshot) renderTerminalViews(state.snapshot.observability)",
    "  })",
    "}",
    "function renderSnapshot(snapshot, reason) {",
    "  const status = snapshot && snapshot.canonical_state && snapshot.canonical_state.status",
    "  const tree = snapshot && snapshot.canonical_state && snapshot.canonical_state.tree",
    "  const observability = snapshot && snapshot.observability",
    "  const runtime = snapshot && snapshot.canonical_state && snapshot.canonical_state.runtime",
    "  if (!status || !tree) throw new Error('Snapshot payload is missing canonical workstream data.')",
    "  state.snapshot = snapshot",
    "  hideState()",
    "  if (dashboard) dashboard.hidden = false",
    "  if (workstreamTitle) workstreamTitle.textContent = status.stream.id + ' · ' + status.stream.name",
    "  if (workstreamMeta) workstreamMeta.textContent = 'Repo root: ' + repoRoot + ' · canonical source: tasks.json · generated ' + snapshot.generated_at",
    "  setBadge(statusBadge, status.aggregate_status, labelStatus(status.aggregate_status))",
    "  setBadge(observabilityBadge, (observability && observability.availability) ? observability.availability : 'degraded', (observability && observability.availability) ? observability.availability : 'degraded')",
    "  if (statusSummary) statusSummary.innerHTML = [renderMetricCard('Tasks', String(status.counts.total), status.counts.done + ' done · ' + status.counts.in_progress + ' active'), renderMetricCard('Completion', status.completion.percent_done + '%', status.completion.done_tasks + ' done · ' + status.completion.remaining_tasks + ' remaining'), renderMetricCard('Current stream', status.stream.id, status.stream.is_current ? 'marked current' : 'not current'), renderMetricCard('Generated', snapshot.generated_at, reason ? 'last refresh: ' + reason : 'canonical backend snapshot')].join('')",
    "  if (runtimeSummary) runtimeSummary.innerHTML = renderRuntimeSummary(runtime)",
    "  if (statusStages) statusStages.innerHTML = status.stages.length > 0 ? status.stages.map((stage) => renderStageRow(stage)).join('') : '<div class=\"empty\">No stages were found in the canonical snapshot.</div>'",
    "  if (treeCount) treeCount.textContent = tree.taskCount + ' task' + (tree.taskCount === 1 ? '' : 's')",
    "  if (treeBody) treeBody.innerHTML = renderTree(tree)",
    "  if (observabilityIssues) observabilityIssues.innerHTML = renderObservabilityIssues(observability)",
    "  renderTmuxSessions(observability)",
    "  renderTerminalViews(observability)",
    "}",
    "async function refreshSnapshot(reason) {",
    "  setConnectionStatus(reason ? 'Refreshing snapshot (' + reason + ')…' : 'Refreshing snapshot…')",
    "  showState('loading', 'Loading canonical snapshot…')",
    "  try {",
    "    const response = await fetch(snapshotPath, { headers: { accept: 'application/json' } })",
    "    if (!response.ok) throw new Error('Snapshot request failed with ' + response.status)",
    "    const snapshot = await response.json()",
    "    renderSnapshot(snapshot, reason)",
    "    setConnectionStatus('Canonical snapshot loaded')",
    "  } catch (error) {",
    "    const message = error instanceof Error ? error.message : 'Failed to load the canonical snapshot.'",
    "    showState('error', message, 'The dashboard can reconnect once the backend snapshot is available.')",
    "    setConnectionStatus('Snapshot unavailable')",
    "    if (dashboard) dashboard.hidden = true",
    "  }",
    "}",
    "source.onopen = () => { setConnectionStatus('Live updates connected') }",
    "source.addEventListener('snapshot', () => { void refreshSnapshot('live snapshot event') })",
    "source.addEventListener('observability', () => { void refreshSnapshot('live observability event') })",
    "source.addEventListener('heartbeat', () => { setConnectionStatus('Live updates connected') })",
    "source.onerror = () => { setConnectionStatus('Live updates reconnecting…') }",
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
      .masthead, .panel, .state { border: 1px solid #242424; background: #111; }
      .masthead, .panel { padding: 1rem; }
      .masthead { display: grid; gap: 0.35rem; }
      .eyebrow, .muted, .meta, .empty, .state { color: #a7a7a7; }
      h1, h2, p { margin: 0; }
      h1 { font-size: clamp(1.5rem, 2.5vw, 2.2rem); line-height: 1.1; letter-spacing: -0.03em; }
      h2 { font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.12em; color: #d7d7d7; }
      code, pre, .mono { font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace; }
      .layout { display: grid; gap: 1rem; }
      .layout-grid { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr); }
      @media (min-width: 1100px) { .layout-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); align-items: start; } }
      .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.9rem; }
      .summary-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
      .summary-card, .status-row, .tree-node, .runtime-entry, .issue { border: 1px solid #232323; background: #0d0d0d; }
      .summary-card { display: grid; gap: 0.25rem; padding: 0.75rem; }
      .summary-value { font-size: 1.05rem; font-weight: 600; }
      .badge { display: inline-flex; align-items: center; gap: 0.35rem; border: 1px solid #2a2a2a; border-radius: 999px; padding: 0.18rem 0.55rem; font-size: 0.78rem; line-height: 1.1; white-space: nowrap; }
      .badge[data-status="completed"], .badge[data-status="ready"] { color: #b9f6c5; border-color: #23402b; }
      .badge[data-status="in_progress"], .badge[data-status="running"] { color: #b9d9ff; border-color: #243a55; }
      .badge[data-status="blocked"], .badge[data-status="failed"], .badge[data-status="unavailable"], .badge[data-status="error"] { color: #ffb7b7; border-color: #4a2323; }
      .badge[data-status="pending"], .badge[data-status="degraded"], .badge[data-status="stopped"] { color: #ddd; }
      .stack { display: grid; gap: 0.5rem; }
      .status-row { display: grid; gap: 0.4rem; padding: 0.7rem; }
      .status-row-head, .tree-node-head, .issue-head, .runtime-entry-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; }
      .status-stages, .tree-list, .runtime-list, .issue-list { display: grid; gap: 0.5rem; }
      .runtime-entry, .issue { padding: 0.7rem; }
      .tree-root { display: grid; gap: 0.6rem; }
      .tree-list { padding-left: 0; margin: 0; list-style: none; }
      .tree-node { display: grid; gap: 0.5rem; padding: 0.65rem; }
      .tree-children { display: grid; gap: 0.5rem; padding-left: 1rem; margin: 0; list-style: none; }
      .tree-children[data-depth="1"], .tree-children[data-depth="2"] { padding-left: 0.85rem; }
      .tree-children[data-depth="3"] { padding-left: 0.65rem; }
      .tree-meta, .tree-note, .status-note, .runtime-note, .issue-note, .terminal-note { color: #a7a7a7; font-size: 0.86rem; }
      .state { padding: 1rem; }
      .state[data-kind="error"] { color: #ffd3d3; border-color: #4a2323; }
      .state-actions { margin-top: 0.8rem; }
      button { appearance: none; border: 1px solid #2c2c2c; background: #161616; color: #f4f4f4; padding: 0.42rem 0.75rem; border-radius: 0.45rem; font: inherit; }
      button:hover { background: #1d1d1d; }
      .subgrid { display: grid; gap: 0.75rem; }
      .terminal-list, .tmux-list { display: grid; gap: 0.6rem; list-style: none; padding: 0; margin: 0; }
      .terminal-card, .tmux-card { display: grid; gap: 0.45rem; border: 1px solid #232323; background: #0d0d0d; padding: 0.7rem; }
      .terminal-row, .tmux-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.6rem; align-items: baseline; }
      .terminal-frame { border: 1px solid #232323; background: #050505; min-height: 28rem; overflow: hidden; }
      .terminal-frame iframe { border: 0; display: block; width: 100%; height: 28rem; }
      .terminal-button { display: inline-flex; align-items: center; gap: 0.4rem; text-align: left; }
      .terminal-button.selected { border-color: #3f6d99; color: #8ec5ff; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <header class="masthead">
        <p class="eyebrow">Current workstream dashboard</p>
        <h1 id="workstream-title">Loading current workstream…</h1>
        <p id="workstream-meta" class="muted">Canonical source: tasks.json</p>
        <p id="connection-status" class="muted">Connecting to live updates…</p>
      </header>

      <section id="state-banner" class="state" data-kind="loading">Loading canonical snapshot…</section>

      <div id="dashboard" class="layout" hidden>
        <div class="layout-grid">
          <section class="panel" aria-labelledby="status-heading">
            <div class="panel-head">
              <h2 id="status-heading">Status overview</h2>
              <span id="status-badge" class="badge" data-status="pending">pending</span>
            </div>
            <div id="status-summary" class="summary-grid"></div>
            <div id="runtime-summary" class="stack" style="margin-top: 1rem;"></div>
            <div id="status-stages" class="status-stages" style="margin-top: 1rem;"></div>
          </section>

          <section class="panel" aria-labelledby="tree-heading">
            <div class="panel-head">
              <h2 id="tree-heading">Work tree</h2>
              <span id="tree-count" class="muted"></span>
            </div>
            <div id="tree-body" class="tree-root"></div>
          </section>
        </div>

        <section class="panel" aria-labelledby="observability-heading">
          <div class="panel-head">
            <h2 id="observability-heading">Observability notes</h2>
            <span id="observability-badge" class="badge" data-status="degraded">loading</span>
          </div>
          <div id="observability-issues" class="issue-list"></div>
        </section>

        <section class="panel" aria-labelledby="tmux-heading">
          <div class="panel-head">
            <h2 id="tmux-heading">Tmux session metadata</h2>
            <span class="muted">session identity and state</span>
          </div>
          <p id="tmux-summary" class="muted">Loading tmux sessions…</p>
          <ul id="tmux-list" class="tmux-list" style="margin-top: 1rem;">
            <li class="empty">Waiting for snapshot data…</li>
          </ul>
        </section>

        <section class="panel" aria-labelledby="terminal-heading">
          <div class="panel-head">
            <h2 id="terminal-heading">Read-only terminal views</h2>
            <span class="muted">ttyd-backed embeds</span>
          </div>
          <p id="terminal-view-summary" class="muted">Loading terminal views…</p>
          <ul id="terminal-view-list" class="terminal-list" style="margin-top: 1rem;">
            <li class="empty">Waiting for snapshot data…</li>
          </ul>
          <div id="terminal-view-frame" class="terminal-frame" style="margin-top: 1rem;">
            <div style="padding: 1rem;" class="empty">Select an available terminal view to embed the read-only ttyd session.</div>
          </div>
        </section>
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
