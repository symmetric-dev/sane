// @ts-nocheck
import { tool } from "@opencode-ai/plugin";
import { randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const WORKSTREAM_TOOL_VERSION = "2026-04-14-supervision-tmux-fix-v1";
const DEFAULT_BRANCH_TOOL_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS = 1000;
const DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS = 5000;
const DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_TMUX_SESSION_SUFFIX_LENGTH = 6;
const DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS = 3000;
const DEFAULT_TMUX_LAUNCH_VALIDATION_POLL_INTERVAL_MS = 100;

interface WorkstreamsToolRuntime {
  getResolvedStream: (index: any, streamId?: string) => { id: string };
  loadIndex: (repoRoot: string) => any;
  buildRootAgentBranchSession: (args: any) => any;
  createRootAgentBranchSessionId: (role: string) => string;
  resolveCurrentBranchSupervisionContext: (args: {
    repoRoot: string;
    streamId?: string;
    sessionId?: string;
  }) => any;
  findRootAgentBranchSessionForLaunchSessionId: (args: {
    repoRoot: string;
    streamId: string;
    sessionId: string;
  }) => any;
  waitForRootAgentBranchNativeSessionId: (args: {
    repoRoot: string;
    streamId: string;
    branchSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<string | undefined>;
  waitForRootAgentBranchTerminalSession: (args: {
    repoRoot: string;
    streamId: string;
    branchSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<any>;
  loadSupervisorState: (repoRoot: string, streamId: string) => any;
  upsertBranchSessionLocked: (
    repoRoot: string,
    streamId: string,
    branchSession: any,
  ) => Promise<any>;
  refreshRootAgentCheckpointPointer: (args: any) => Promise<any>;
  getRootAgentCheckpointSessionForkEligibility: (args: any) => {
    valid: boolean;
    canForkCurrentSession: boolean;
    reason?: string;
    resolvedMessageId?: string;
    resolvedMessageIndex?: number;
    latestMessageIndex?: number;
  };
  parseSynthesisJsonl: (content: string) => {
    text: string;
    logs: string[];
    success: boolean;
  };
  exportSession: (sessionId: string) => Promise<any>;
  extractLastCompletedAssistantText: (sessionExport: any) => string;
}

interface WorkstreamsRuntimeResolutionOptions {
  resolveWorkCommandPath?: () => string;
}

interface WorkstreamsRuntimeLoadOptions extends WorkstreamsRuntimeResolutionOptions {
  cache?: boolean;
}

export interface WorkstreamsToolRuntimeInfo {
  toolVersion: string;
  toolFilePath?: string;
  workCommandPath?: string;
  resolvedWorkCommandPath?: string;
  resolvedRuntimeModulePath?: string;
  workstreamsPackageRoot?: string;
  workstreamsPackageVersion?: string;
  capabilities: {
    fakeUserPrompt: boolean;
    metadataOnlyCheckpoints: boolean;
    messageBoundaryFork: boolean;
    breakpointTags: boolean;
    autoResolvedBranchSupervisionContext: boolean;
  };
  errors?: {
    workCommandPath?: string;
    resolvedRuntimeModulePath?: string;
    workstreamsPackageVersion?: string;
  };
}

interface ForkedSessionArgs {
  sessionId: string;
  repoRoot: string;
  title: string;
  prompt: string;
  checkpointMessageId?: string;
  forkMode?: "message" | "latest_session_fork";
  tmuxSessionName?: string;
  onNativeSessionId?: (nativeSessionId: string) => Promise<void> | void;
}

interface RootCheckpointPointer {
  rootSessionId?: string;
  checkpointMessageId?: string;
  checkpointMessageIndex?: number;
  checkpointCreatedAt: string;
  breakpointSelection?: {
    strategy: "explicit_tag" | "previous_user_before_launch";
    configuredTags: string[];
    matchedTag?: string;
    launchMessageId?: string;
    launchMessageIndex?: number;
    rationale: string;
  };
}

type BranchScopeLevel = "batch" | "stage";

type BranchLaunchScope =
  | {
      level: "batch";
      stageId: string;
      batchId: string;
    }
  | {
      level: "stage";
      stageId: string;
    };

interface ForkedSessionResult {
  code: number;
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
  tmuxSessionName?: string;
  tmuxMetadata?: SupervisionTmuxLaunchMetadata;
}

interface SupervisionTmuxLaunchMetadata {
  sessionName: string;
  attachCommand: string;
  launchDirectory: string;
  wrapperPath: string;
  readyMarkerPath: string;
  commandPath: string;
  metadataPath: string;
}

type SupervisionTerminalStatus = "completed" | "stopped" | "failed";

const ACTIVE_SUPERVISION_BRANCH_STATUSES = new Set(["pending", "running", "stopped"]);

interface CheckpointSessionForkEligibility {
  valid: boolean;
  canForkCurrentSession: boolean;
  reason?: string;
  resolvedMessageId?: string;
  resolvedMessageIndex?: number;
  latestMessageIndex?: number;
}

export interface MessageBoundaryForkTransport {
  startServer: typeof startOpencodeServer;
  requestJson: typeof requestOpencodeJson;
  runCommand: typeof runCommand;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatWorkstreamTmuxPrefix(streamId: string): string {
  const match = streamId.match(/^(\d{1,})/);
  if (match?.[1]) {
    return match[1].padStart(3, "0");
  }

  return "000";
}

function createSupervisionTmuxSessionName(streamId: string): string {
  return `${formatWorkstreamTmuxPrefix(streamId)}-supervision-${randomBytes(
    Math.max(3, Math.ceil(DEFAULT_TMUX_SESSION_SUFFIX_LENGTH / 2)),
  )
    .toString("hex")
    .slice(0, DEFAULT_TMUX_SESSION_SUFFIX_LENGTH)}`;
}

function tmuxSessionExists(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function getTmuxSinglePaneState(sessionName: string): {
  dead: boolean;
  exitStatus?: number;
} | undefined {
  const result = spawnSync(
    "tmux",
    ["list-panes", "-t", sessionName, "-F", "#{pane_dead}:#{pane_exit_status}"],
    { encoding: "utf-8" },
  );

  if (result.status !== 0) {
    return undefined;
  }

  const [paneLine] = (result.stdout ?? "").trim().split("\n");
  if (!paneLine) {
    return undefined;
  }

  const [dead, exitStatus] = paneLine.split(":");
  const parsed = Number(exitStatus);
  return {
    dead: dead === "1",
    ...(Number.isFinite(parsed) ? { exitStatus: parsed } : {}),
  };
}

function getTmuxSinglePaneExitStatus(sessionName: string): number | undefined {
  const paneState = getTmuxSinglePaneState(sessionName);
  if (!paneState?.dead) {
    return undefined;
  }

  return paneState.exitStatus ?? 1;
}

function captureTmuxPaneOutput(sessionName: string): string {
  const result = spawnSync("tmux", ["capture-pane", "-p", "-t", sessionName], {
    encoding: "utf-8",
  });

  return result.status === 0 ? result.stdout ?? "" : "";
}

function createSupervisionTmuxLaunchMetadata(args: {
  tmuxSessionName: string;
  repoRoot: string;
  commandArgs: string[];
}): SupervisionTmuxLaunchMetadata {
  const launchDirectory = mkdtempSync(join(tmpdir(), "workstream-supervision-"));
  const wrapperPath = join(launchDirectory, "launch-supervision.sh");
  const readyMarkerPath = join(launchDirectory, "launch.ready");
  const commandPath = join(launchDirectory, "opencode-command.sh");
  const metadataPath = join(launchDirectory, "launch-metadata.json");
  const attachCommand = `tmux attach -t ${args.tmuxSessionName}`;
  const command = ["opencode", ...args.commandArgs].map(shellQuote).join(" ");

  writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\n' ${shellQuote(command)} > ${shellQuote(commandPath)}`,
      `date -u +"%Y-%m-%dT%H:%M:%SZ" > ${shellQuote(readyMarkerPath)}`,
      `exec ${command}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(wrapperPath, 0o755);

  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        sessionName: args.tmuxSessionName,
        attachCommand,
        repoRoot: args.repoRoot,
        launchDirectory,
        wrapperPath,
        readyMarkerPath,
        commandPath,
        command,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    sessionName: args.tmuxSessionName,
    attachCommand,
    launchDirectory,
    wrapperPath,
    readyMarkerPath,
    commandPath,
    metadataPath,
  };
}

async function validateSupervisionTmuxLaunch(metadata: SupervisionTmuxLaunchMetadata) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS) {
    const sessionExists = tmuxSessionExists(metadata.sessionName);
    const paneState = sessionExists
      ? getTmuxSinglePaneState(metadata.sessionName)
      : undefined;
    const paneAlive = sessionExists && !!paneState && !paneState.dead;
    const readyMarkerWritten = existsSync(metadata.readyMarkerPath);

    if (sessionExists && paneAlive && readyMarkerWritten) {
      return;
    }

    if (paneState?.dead) {
      const paneOutput = captureTmuxPaneOutput(metadata.sessionName).trim();
      throw new Error(
        [
          `Supervision tmux launch validation failed for ${metadata.sessionName}: pane exited before the launch handshake completed${typeof paneState.exitStatus === "number" ? ` (exit ${paneState.exitStatus})` : ""}.`,
          `Attach with \`${metadata.attachCommand}\` to inspect it.`,
          `Ready marker: ${metadata.readyMarkerPath}`,
          `Recorded command: ${metadata.commandPath}`,
          `Wrapper script: ${metadata.wrapperPath}`,
          `Launch metadata: ${metadata.metadataPath}`,
          ...(paneOutput ? [`Captured tmux pane output:\n${paneOutput}`] : []),
        ].join("\n"),
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DEFAULT_TMUX_LAUNCH_VALIDATION_POLL_INTERVAL_MS),
    );
  }

  const sessionExists = tmuxSessionExists(metadata.sessionName);
  const paneState = sessionExists
    ? getTmuxSinglePaneState(metadata.sessionName)
    : undefined;
  throw new Error(
    [
      `Supervision tmux launch validation failed for ${metadata.sessionName} within ${DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS}ms.`,
      `sessionExists=${sessionExists ? "yes" : "no"}`,
      `paneAlive=${paneState && !paneState.dead ? "yes" : "no"}`,
      `readyMarkerWritten=${existsSync(metadata.readyMarkerPath) ? "yes" : "no"}`,
      `Attach with \`${metadata.attachCommand}\` to inspect it.`,
      `Ready marker: ${metadata.readyMarkerPath}`,
      `Recorded command: ${metadata.commandPath}`,
      `Wrapper script: ${metadata.wrapperPath}`,
      `Launch metadata: ${metadata.metadataPath}`,
    ].join("\n"),
  );
}

function formatSupervisionTmuxObservability(metadata: SupervisionTmuxLaunchMetadata): string {
  return [
    "Tmux observability:",
    `- Session: ${metadata.sessionName}`,
    `- Attach: ${metadata.attachCommand}`,
    `- Launch directory: ${metadata.launchDirectory}`,
    `- Wrapper script: ${metadata.wrapperPath}`,
    `- Ready marker: ${metadata.readyMarkerPath}`,
    `- Recorded command: ${metadata.commandPath}`,
    `- Launch metadata: ${metadata.metadataPath}`,
  ].join("\n");
}

function appendSupervisionTmuxObservability(
  text: string,
  metadata?: SupervisionTmuxLaunchMetadata,
): string {
  if (!metadata) {
    return text;
  }

  return `${text}\n\n${formatSupervisionTmuxObservability(metadata)}`;
}

async function waitForTmuxSessionExit(
  sessionName: string,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const exitStatus = getTmuxSinglePaneExitStatus(sessionName);
    if (typeof exitStatus === "number") {
      return exitStatus;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
    );
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for supervision session "${sessionName}" to finish. Attach with \`tmux attach -t ${sessionName}\` to inspect it.`,
  );
}

function parseBreakpointTagsArg(rawValue?: string): string[] | undefined {
  if (typeof rawValue !== "string") {
    return undefined;
  }

  const normalized = new Set<string>();

  for (const candidate of rawValue.split(/[\n,]/)) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return normalized.size > 0 ? [...normalized] : undefined;
}

function normalizeOptionalLaunchString(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildSupervisionPrompt(args: {
  scope?: BranchLaunchScope;
  batch?: string;
}): string {
  const batchTarget = args.batch
    ? `batch ${args.batch}`
    : "the next resumable batch";
  const scopeLabel = describeScopeLabel(args.scope, args.batch);
  const scopeInstructions = buildScopeInstructionBlock(args.scope, args.batch);
  const initialSuperviseCommand =
    args.scope?.level === "stage"
      ? "Start by inspecting persisted stage state and running `work supervise --batch \"<next batch in this stage>\"` for the next incomplete or resumable batch in that stage."
      : args.scope?.level === "batch" || args.batch
        ? `Start by running \`work supervise --batch "${args.scope?.batchId ?? args.batch}"\`.`
        : "Start by running `work supervise`.";
  const nextStepsInstruction =
    args.scope?.level === "stage"
      ? "In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation stage."
      : "In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation batch.";

  return [
    args.scope?.level === "stage"
      ? `Please supervise ${scopeLabel} for this workstream, one batch at a time until the stage is done or you must yield by policy.`
      : `Please supervise ${batchTarget} for this workstream.`,
    "Use the supervising-workstreams skill.",
    ...scopeInstructions,
    "",
    initialSuperviseCommand,
    "Reuse plain `work supervise` when the current batch is already resumable; only add `--batch` when you need to pick the next bounded batch inside your scope.",
    "Then follow the supervising-workstreams skill, using persisted workstream state to decide whether to rerun the current batch, continue within the same scope, run a fix subagent, or yield by policy.",
    "",
    "When you yield back, return a semi-structured final report with these headings exactly:",
    "## Accomplished",
    "## Issues Found",
    "## Fixes Applied",
    "## What is Next",
    "",
    `${nextStepsInstruction} If a section has nothing to report, write "None."`,
  ].join("\n");
}

function parseBreakpointModeArg(
  rawValue?: string,
): "prefer_tagged" | "previous_user" | undefined {
  if (!rawValue) {
    return undefined;
  }

  if (rawValue === "prefer_tagged" || rawValue === "previous_user") {
    return rawValue;
  }

  throw new Error(
    `Invalid breakpointMode \"${rawValue}\". Expected \"prefer_tagged\" or \"previous_user\".`,
  );
}

function describeScopeLabel(scope: BranchLaunchScope | undefined, batch?: string): string {
  return scope?.level === "stage"
    ? `stage ${scope.stageId}`
    : `batch ${scope?.batchId ?? batch ?? "(next resumable batch)"}`;
}

function buildScopeInstructionBlock(
  scope: BranchLaunchScope | undefined,
  batch?: string,
): string[] {
  const scopeLabel = describeScopeLabel(scope, batch);

  if (scope?.level === "stage") {
    return [
      `Stay inside ${scopeLabel}; do not drift into later stages even if the broader workstream has more incomplete batches.`,
      `Before each supervise pass, inspect the persisted state of ${scopeLabel} and identify the next incomplete or resumable batch within that stage.`,
      "work supervise itself is still a single-batch primitive.",
      `After each review/fix cycle, inspect persisted workstream and supervisor state again to decide whether the same batch must resume, another batch in ${scopeLabel} remains, or ${scopeLabel} is complete.`,
      `Yield as soon as ${scopeLabel} is complete or policy says to stop.`,
    ];
  }

  return [
    "Keep this branch focused on one bounded batch supervision pass.",
    `Yield as soon as ${scopeLabel} is done or policy says to stop.`,
  ];
}

function inferStageIdFromBatchId(batchId?: string): string | undefined {
  if (!batchId) {
    return undefined;
  }

  const [stageId, batchSuffix] = batchId.split(".");
  return stageId && batchSuffix && stageId.length > 0 && batchSuffix.length > 0
    ? stageId
    : undefined;
}

function resolveLegacyLaunchTarget(args: {
  scope?: string;
  stage?: string;
  batch?: string;
  target?: string;
}): string | undefined {
  const normalizedTarget = normalizeOptionalLaunchString(args.target);
  if (normalizedTarget) {
    return normalizedTarget;
  }

  const normalizedStage = normalizeOptionalLaunchString(args.stage);
  if (args.scope === "stage" && normalizedStage) {
    return normalizedStage;
  }

  return normalizeOptionalLaunchString(args.batch);
}

function resolveLaunchScope(args: {
  scope?: string;
  target?: string;
}): BranchLaunchScope | undefined {
  const requestedScope = normalizeOptionalLaunchString(args.scope);
  const target = normalizeOptionalLaunchString(args.target);

  if (requestedScope === "stage") {
    const stageId = target;
    if (!stageId) {
      throw new Error(
        "Stage scope requires --target with a stage id (for example: 10).",
      );
    }

    return {
      level: "stage",
      stageId,
    };
  }

  if (requestedScope && requestedScope !== "batch") {
    throw new Error(
      `Invalid supervision scope \"${requestedScope}\". Expected \"stage\" or \"batch\".`,
    );
  }

  if (!target) {
    return undefined;
  }

  const stageId = inferStageIdFromBatchId(target);
  if (!stageId) {
    throw new Error(
      `Batch scope requires a stage-qualified batch id (received \"${target}\").`,
    );
  }

  return {
    level: "batch",
    stageId,
    batchId: target,
  };
}

async function startOpencodeServer(repoRoot: string): Promise<{
  url: string;
  close: () => void;
}> {
  const child = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Timeout waiting for opencode server to start.\n${output}`.trim(),
        ),
      );
    }, DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS);

    const finalizeError = (message: string) => {
      clearTimeout(timeout);
      reject(new Error(output.trim() ? `${message}\n${output}` : message));
    };

    const onChunk = (chunk: Buffer | string) => {
      output += chunk.toString();
      const lines = output.split("\n");

      for (const line of lines) {
        const match = line.match(
          /opencode server listening on\s+(https?:\/\/[^\s]+)/,
        );
        if (!match) {
          continue;
        }

        clearTimeout(timeout);
        resolve(match[1]);
        return;
      }
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (error) =>
      finalizeError(
        `Failed to start opencode server: ${error?.message || error}`,
      ),
    );
    child.on("exit", (code) =>
      finalizeError(
        `Opencode server exited before becoming ready (code ${code ?? 1}).`,
      ),
    );
  });

  return {
    url,
    close: () => {
      child.kill();
    },
  };
}

async function requestOpencodeJson(args: {
  url: string;
  method: "POST" | "PATCH";
  path: string;
  body?: any;
}): Promise<any> {
  const response = await fetch(`${args.url}${args.path}`, {
    method: args.method,
    headers: {
      "Content-Type": "application/json",
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });

  const text = await response.text();
  const data = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })()
    : undefined;

  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message || data?.error || JSON.stringify(data);
    throw new Error(
      `${args.method} ${args.path} failed (${response.status}): ${message}`,
    );
  }

  return data;
}

async function prepareMessageBoundaryForkLaunch(
  args: Omit<ForkedSessionArgs, "forkMode" | "tmuxSessionName"> & {
    checkpointMessageId: string;
  },
  transport: Pick<
    MessageBoundaryForkTransport,
    "startServer" | "requestJson"
  > = {
    startServer: startOpencodeServer,
    requestJson: requestOpencodeJson,
  },
): Promise<{ nativeSessionId: string; commandArgs: string[] }> {
  const server = await transport.startServer(args.repoRoot);

  try {
    const forkedSession = await transport.requestJson({
      url: server.url,
      method: "POST",
      path: `/session/${encodeURIComponent(args.sessionId)}/fork?directory=${encodeURIComponent(args.repoRoot)}`,
      body: { messageID: args.checkpointMessageId },
    });

    const nativeSessionId = forkedSession?.id;
    if (
      typeof nativeSessionId !== "string" ||
      nativeSessionId.trim().length === 0
    ) {
      throw new Error("Fork response did not include a child session ID.");
    }

    await transport.requestJson({
      url: server.url,
      method: "PATCH",
      path: `/session/${encodeURIComponent(nativeSessionId)}?directory=${encodeURIComponent(args.repoRoot)}`,
      body: { title: args.title },
    });

    if (args.onNativeSessionId) {
      await args.onNativeSessionId(nativeSessionId);
    }

    return {
      nativeSessionId,
      commandArgs: [
        "run",
        "--session",
        nativeSessionId,
        "--dir",
        args.repoRoot,
        "--format",
        "json",
        args.prompt,
      ],
    };
  } finally {
    server.close();
  }
}

async function runForkedSessionInTmux(
  args: Omit<ForkedSessionArgs, "forkMode"> & {
    forkMode?: "message" | "latest_session_fork";
    tmuxSessionName: string;
  },
  helpers: {
    findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle;
  } = {
    findNativeSessionIdByTitle,
  },
): Promise<ForkedSessionResult> {
  const preparedLaunch = args.checkpointMessageId
    ? await prepareMessageBoundaryForkLaunch({
        sessionId: args.sessionId,
        repoRoot: args.repoRoot,
        title: args.title,
        prompt: args.prompt,
        checkpointMessageId: args.checkpointMessageId,
        onNativeSessionId: args.onNativeSessionId,
      })
    : {
        commandArgs: [
          "run",
          "--session",
          args.sessionId,
          "--fork",
          "--dir",
          args.repoRoot,
          "--title",
          args.title,
          "--format",
          "json",
          args.prompt,
        ],
      };

  const tmuxMetadata = createSupervisionTmuxLaunchMetadata({
    tmuxSessionName: args.tmuxSessionName,
    repoRoot: args.repoRoot,
    commandArgs: preparedLaunch.commandArgs,
  });

  const createResult = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      args.tmuxSessionName,
      "-n",
      "supervision",
      tmuxMetadata.wrapperPath,
    ],
    {
      cwd: args.repoRoot,
      env: process.env,
      encoding: "utf-8",
    },
  );

  if (createResult.status !== 0) {
    throw new Error(
      (createResult.stderr || createResult.stdout || "Failed to create supervision tmux session.").trim(),
    );
  }

  spawnSync("tmux", ["set-option", "-t", args.tmuxSessionName, "remain-on-exit", "on"], {
    encoding: "utf-8",
  });

  await validateSupervisionTmuxLaunch(tmuxMetadata);

  let nativeSessionId = preparedLaunch.nativeSessionId;
  let pollError: unknown;
  let stopped = false;
  let pollPromise: Promise<void> | undefined;

  if (!nativeSessionId && args.onNativeSessionId) {
    pollPromise = (async () => {
      while (!stopped && !nativeSessionId) {
        try {
          const foundSessionId = await helpers.findNativeSessionIdByTitle(
            args.repoRoot,
            args.title,
          );
          if (foundSessionId) {
            nativeSessionId = foundSessionId;
            await args.onNativeSessionId(foundSessionId);
            return;
          }
        } catch (error) {
          pollError = error;
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
        );
      }
    })();
  }

  try {
    const code = await waitForTmuxSessionExit(
      args.tmuxSessionName,
      DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    );
    stopped = true;
    await pollPromise;

    if (pollError) {
      throw pollError;
    }

    if (!nativeSessionId) {
      nativeSessionId = await helpers.findNativeSessionIdByTitle(
        args.repoRoot,
        args.title,
      );
    }

    return {
      code,
      stdout: captureTmuxPaneOutput(args.tmuxSessionName),
      stderr: "",
      ...(nativeSessionId ? { nativeSessionId } : {}),
      tmuxSessionName: args.tmuxSessionName,
      tmuxMetadata,
    };
  } finally {
    stopped = true;
  }
}

async function runMessageBoundaryForkLaunch(
  args: Omit<ForkedSessionArgs, "forkMode"> & { checkpointMessageId: string },
  transport: MessageBoundaryForkTransport = {
    startServer: startOpencodeServer,
    requestJson: requestOpencodeJson,
    runCommand,
  },
): Promise<ForkedSessionResult> {
  const preparedLaunch = await prepareMessageBoundaryForkLaunch(args, transport);

    const runResult = await transport.runCommand(
      "opencode",
      preparedLaunch.commandArgs,
      args.repoRoot,
      DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    );

    return {
      ...runResult,
      nativeSessionId: preparedLaunch.nativeSessionId,
    };
}

function resolveWorkCommandPath(): string {
  const result = spawnSync("which", ["work"], {
    encoding: "utf-8",
  });

  const resolvedPath = result.stdout?.trim();
  if (!resolvedPath) {
    throw new Error("Could not resolve active 'work' binary from PATH");
  }

  return resolvedPath;
}

function getToolFilePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
}

function findWorkstreamsPackageRoot(binaryPath: string): string {
  let currentDir = dirname(realpathSync(binaryPath));

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, "utf-8"),
        ) as {
          name?: string;
        };
        if (packageJson.name === "@agenv/workstreams") {
          return currentDir;
        }
      } catch {
        // Ignore unreadable package metadata while walking upward.
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(
    `Could not find @agenv/workstreams package root from active work binary: ${binaryPath}`,
  );
}

function readWorkstreamsPackageVersion(
  packageRoot: string,
): string | undefined {
  const packageJsonPath = join(packageRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version?: string;
  };

  return typeof packageJson.version === "string" &&
    packageJson.version.trim().length > 0
    ? packageJson.version
    : undefined;
}

function resolveWorkstreamsRuntimeModulePath(
  options: WorkstreamsRuntimeResolutionOptions = {},
): string {
  const workCommandPath = (
    options.resolveWorkCommandPath ?? resolveWorkCommandPath
  )();
  const resolvedBinaryPath = realpathSync(workCommandPath);
  const packageRoot = findWorkstreamsPackageRoot(resolvedBinaryPath);
  const preferDistRuntime = resolvedBinaryPath.includes(
    `${join("dist", "bin")}`,
  );

  const candidates = preferDistRuntime
    ? [
        join(packageRoot, "dist", "src", "tool-runtime.js"),
        join(packageRoot, "src", "tool-runtime.ts"),
      ]
    : [
        join(packageRoot, "src", "tool-runtime.ts"),
        join(packageRoot, "dist", "src", "tool-runtime.js"),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate workstream tool runtime next to active work binary. Checked: ${candidates.join(", ")}`,
  );
}

let cachedWorkstreamsToolRuntimePromise:
  | Promise<WorkstreamsToolRuntime>
  | undefined;

async function loadWorkstreamsToolRuntime(
  options: WorkstreamsRuntimeLoadOptions = {},
): Promise<WorkstreamsToolRuntime> {
  const loadRuntime = async () => {
    const modulePath = resolveWorkstreamsRuntimeModulePath(options);
    return (await import(
      pathToFileURL(modulePath).href
    )) as WorkstreamsToolRuntime;
  };

  if (options.cache === false) {
    return loadRuntime();
  }

  cachedWorkstreamsToolRuntimePromise ??= loadRuntime();
  return cachedWorkstreamsToolRuntimePromise;
}

function getWorkstreamsToolRuntimeInfo(
  options: WorkstreamsRuntimeResolutionOptions = {},
): WorkstreamsToolRuntimeInfo {
  const info: WorkstreamsToolRuntimeInfo = {
    toolVersion: WORKSTREAM_TOOL_VERSION,
    toolFilePath: getToolFilePath(),
    capabilities: {
      fakeUserPrompt: true,
      metadataOnlyCheckpoints: true,
      messageBoundaryFork: true,
      breakpointTags: true,
      breakpointModes: true,
      autoResolvedBranchSupervisionContext: true,
    },
  };

  try {
    info.workCommandPath = (
      options.resolveWorkCommandPath ?? resolveWorkCommandPath
    )();
    info.resolvedWorkCommandPath = realpathSync(info.workCommandPath);
    info.workstreamsPackageRoot = findWorkstreamsPackageRoot(
      info.resolvedWorkCommandPath,
    );

    try {
      info.workstreamsPackageVersion = readWorkstreamsPackageVersion(
        info.workstreamsPackageRoot,
      );
    } catch (error: any) {
      info.errors = {
        ...info.errors,
        workstreamsPackageVersion: error?.message || String(error),
      };
    }

    try {
      info.resolvedRuntimeModulePath = resolveWorkstreamsRuntimeModulePath({
        resolveWorkCommandPath: () => info.workCommandPath!,
      });
    } catch (error: any) {
      info.errors = {
        ...info.errors,
        resolvedRuntimeModulePath: error?.message || String(error),
      };
    }
  } catch (error: any) {
    info.errors = {
      ...info.errors,
      workCommandPath: error?.message || String(error),
    };
  }

  return info;
}

function formatWorkstreamsToolRuntimeInfo(
  info: WorkstreamsToolRuntimeInfo,
): string {
  return JSON.stringify(info, null, 2);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalizeResolve = (value: {
      code: number;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const finalizeReject = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill();
      finalizeReject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for command "${command}" to finish.`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) =>
      finalizeReject(error instanceof Error ? error : new Error(String(error))),
    );
    child.on("close", (code) => {
      finalizeResolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function findNativeSessionIdByTitle(
  repoRoot: string,
  title: string,
): Promise<string | undefined> {
  const result = await runCommand(
    "opencode",
    ["session", "list", "--max-count", "50", "--format", "json"],
    repoRoot,
    DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS,
  );

  if (result.code !== 0) {
    return undefined;
  }

  try {
    const sessions = JSON.parse(result.stdout) as Array<{
      id: string;
      title: string;
    }>;
    return sessions.find((session) => session.title === title)?.id;
  } catch {
    return undefined;
  }
}

export interface LaunchSupervisionBranchDeps {
  getRepoRoot: () => string;
  getResolvedStreamId: (
    repoRoot: string,
    streamId?: string,
  ) => string | Promise<string>;
  findBranchSessionForLaunchSessionId: (
    repoRoot: string,
    streamId: string,
    sessionId: string,
  ) => any | Promise<any>;
  findBranchSessionByNativeSessionId: (
    repoRoot: string,
    streamId: string,
    nativeSessionId: string,
  ) => any | Promise<any>;
  createBranchSessionId: () => string | Promise<string>;
  buildBranchSession: (args: any) => any | Promise<any>;
  persistBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSession: any,
  ) => any | Promise<any>;
  loadStoredBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSessionId: string,
  ) => any | Promise<any>;
  findActiveMatchingSupervisionBranch: (args: {
    repoRoot: string;
    streamId: string;
    rootSessionId: string;
    scope?: BranchLaunchScope;
  }) => any | Promise<any>;
  waitForBranchNativeSessionId: (args: {
    repoRoot: string;
    streamId: string;
    branchSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<string | undefined>;
  waitForTerminalBranchSession: (args: {
    repoRoot: string;
    streamId: string;
    branchSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<any>;
  createSupervisionTmuxSessionName: (
    streamId: string,
  ) => string | Promise<string>;
  tmuxSessionExists: (sessionName: string) => boolean | Promise<boolean>;
  runForkedSession: (args: ForkedSessionArgs) => Promise<ForkedSessionResult>;
  runCommand: typeof runCommand;
  findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle;
  parseOutput: (
    content: string,
  ) =>
    | { text: string; logs: string[]; success: boolean }
    | Promise<{ text: string; logs: string[]; success: boolean }>;
  exportSessionTranscript: (sessionId: string) => Promise<any>;
  refreshCheckpointPointer: (args: {
    repoRoot: string;
    streamId: string;
    rootSessionId: string;
    sessionExport: any;
    checkpointCreatedAt: string;
    breakpointTags?: readonly string[];
    breakpointMode?: "prefer_tagged" | "previous_user";
  }) => Promise<RootCheckpointPointer>;
  getCheckpointSessionForkEligibility: (args: {
    pointer: RootCheckpointPointer;
    sessionExport: any;
  }) =>
    | CheckpointSessionForkEligibility
    | Promise<CheckpointSessionForkEligibility>;
  extractFinalBranchReport: (sessionExport: any) => string | Promise<string>;
  now: () => string;
}

interface FinalizeWorkstreamSupervisionResolution {
  streamId: string;
  current: {
    rootSessionId: string;
    branchSessionId: string;
    nativeSessionId?: string;
    checkpointMessageId?: string;
    checkpointMessageIndex?: number;
    checkpointCreatedAt?: string;
    breakpointSelection?: RootCheckpointPointer["breakpointSelection"];
    checkpointSessionId?: string;
    parentSessionId?: string;
    scope?: BranchLaunchScope;
    supervisionProgress?: {
      currentBatchId?: string;
    };
  };
  branchSession: any;
  resolutionSource: "current_supervision_context" | "persisted_session_fallback";
}

export interface FinalizeWorkstreamSupervisionDeps {
  getRepoRoot: () => string;
  resolveFinalizableSupervision: (args: {
    repoRoot: string;
    sessionId: string;
    streamId?: string;
  }) => Promise<FinalizeWorkstreamSupervisionResolution | undefined>;
  buildBranchSession: (args: any) => any | Promise<any>;
  persistBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSession: any,
  ) => any | Promise<any>;
  now: () => string;
}

function getDefaultLaunchSupervisionBranchDeps(): LaunchSupervisionBranchDeps {
  const runtime = loadWorkstreamsToolRuntime();

  return {
    getRepoRoot: () => process.cwd(),
    getResolvedStreamId: async (repoRoot, streamId) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.getResolvedStream(
        resolvedRuntime.loadIndex(repoRoot),
        streamId,
      ).id;
    },
    findBranchSessionForLaunchSessionId: async (
      repoRoot,
      streamId,
      sessionId,
    ) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.findRootAgentBranchSessionForLaunchSessionId({
        repoRoot,
        streamId,
        sessionId,
      });
    },
    findBranchSessionByNativeSessionId: async (
      repoRoot,
      streamId,
      nativeSessionId,
    ) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find(
          (branch: any) => branch.nativeSessionId === nativeSessionId,
        );
    },
    createBranchSessionId: async () => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.createRootAgentBranchSessionId("supervision");
    },
    buildBranchSession: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.buildRootAgentBranchSession(args);
    },
    persistBranchSession: async (repoRoot, streamId, branchSession) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.upsertBranchSessionLocked(
        repoRoot,
        streamId,
        branchSession,
      );
    },
    refreshCheckpointPointer: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.refreshRootAgentCheckpointPointer(args);
    },
    getCheckpointSessionForkEligibility: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.getRootAgentCheckpointSessionForkEligibility(args);
    },
    loadStoredBranchSession: async (repoRoot, streamId, branchSessionId) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find(
          (branch) => branch.branchSessionId === branchSessionId,
        );
    },
    findActiveMatchingSupervisionBranch: async ({
      repoRoot,
      streamId,
      rootSessionId,
      scope,
    }) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find(
          (branch: any) =>
            branch.branchRole === "supervision" &&
            branch.rootSessionId === rootSessionId &&
            isActiveSupervisionBranchStatus(branch.status) &&
            hasActiveSupervisionSessionHandle(branch) &&
            doLaunchScopesMatch(branch.scope, scope),
        );
    },
    waitForBranchNativeSessionId: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.waitForRootAgentBranchNativeSessionId(args);
    },
    waitForTerminalBranchSession: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.waitForRootAgentBranchTerminalSession(args);
    },
    createSupervisionTmuxSessionName,
    tmuxSessionExists,
    runForkedSession: async ({
      sessionId,
      repoRoot,
      title,
      prompt,
      checkpointMessageId,
      forkMode,
      tmuxSessionName,
      onNativeSessionId,
    }) => {
      if (tmuxSessionName) {
        return runForkedSessionInTmux({
          sessionId,
          repoRoot,
          title,
          prompt,
          checkpointMessageId,
          forkMode,
          tmuxSessionName,
          onNativeSessionId,
        });
      }

      if (forkMode === "message") {
        if (!checkpointMessageId) {
          throw new Error(
            "Message-boundary fork requires checkpointMessageId.",
          );
        }

        return runMessageBoundaryForkLaunch({
          sessionId,
          repoRoot,
          title,
          prompt,
          checkpointMessageId,
          onNativeSessionId,
        });
      }

      const child = spawn(
        "opencode",
        [
          "run",
          "--session",
          sessionId,
          "--fork",
          "--dir",
          repoRoot,
          "--title",
          title,
          "--format",
          "json",
          prompt,
        ],
        {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      let nativeSessionId: string | undefined;
      let stopped = false;
      let pollError: unknown;
      let pollPromise: Promise<void> | undefined;
      let settled = false;

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      if (onNativeSessionId) {
        pollPromise = (async () => {
          while (!stopped && !nativeSessionId) {
            try {
              const foundSessionId = await findNativeSessionIdByTitle(
                repoRoot,
                title,
              );
              if (foundSessionId) {
                nativeSessionId = foundSessionId;
                await onNativeSessionId(foundSessionId);
                return;
              }
            } catch (error) {
              pollError = error;
              return;
            }

            await new Promise((resolve) =>
              setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
            );
          }
        })();
      }

      const result = await new Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const finalizeResolve = (value: {
          code: number;
          stdout: string;
          stderr: string;
        }) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeoutHandle);
          resolve(value);
        };

        const finalizeReject = (error: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeoutHandle);
          reject(error);
        };

        const timeoutHandle = setTimeout(() => {
          stopped = true;
          child.kill();
          finalizeReject(
            new Error(
              `Timed out after ${DEFAULT_BRANCH_TOOL_TIMEOUT_MS}ms waiting for supervision branch session "${title}" to finish.`,
            ),
          );
        }, DEFAULT_BRANCH_TOOL_TIMEOUT_MS);

        child.on("error", (error) =>
          finalizeReject(error instanceof Error ? error : new Error(String(error))),
        );
        child.on("close", (code) => {
          stopped = true;
          finalizeResolve({ code: code ?? 1, stdout, stderr });
        });
      });

      await pollPromise;

      if (pollError) {
        throw pollError;
      }

      if (!nativeSessionId) {
        nativeSessionId = await findNativeSessionIdByTitle(repoRoot, title);
      }

      return {
        ...result,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      };
    },
    runCommand,
    findNativeSessionIdByTitle,
    parseOutput: async (content) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.parseSynthesisJsonl(content);
    },
    exportSessionTranscript: async (sessionId) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.exportSession(sessionId);
    },
    extractFinalBranchReport: async (sessionExport) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.extractLastCompletedAssistantText(sessionExport);
    },
    now: () => new Date().toISOString(),
  };
}

function listCandidateStreamIds(
  runtime: WorkstreamsToolRuntime,
  repoRoot: string,
  streamId?: string,
): string[] {
  if (streamId) {
    return [runtime.getResolvedStream(runtime.loadIndex(repoRoot), streamId).id];
  }

  const index = runtime.loadIndex(repoRoot);
  return Array.from(
    new Set([
      ...(index.current_stream ? [index.current_stream] : []),
      ...index.streams.map((stream: { id: string }) => stream.id),
    ]),
  );
}

function buildPersistedSupervisionFallback(args: {
  streamId: string;
  branchSession: any;
}): FinalizeWorkstreamSupervisionResolution | undefined {
  const branchSession = args.branchSession;
  if (
    !branchSession ||
    branchSession.branchRole !== "supervision" ||
    typeof branchSession.rootSessionId !== "string" ||
    typeof branchSession.branchSessionId !== "string"
  ) {
    return undefined;
  }

  return {
    streamId: args.streamId,
    current: {
      rootSessionId: branchSession.rootSessionId,
      branchSessionId: branchSession.branchSessionId,
      ...(branchSession.nativeSessionId
        ? { nativeSessionId: branchSession.nativeSessionId }
        : {}),
      ...(branchSession.checkpointMessageId
        ? { checkpointMessageId: branchSession.checkpointMessageId }
        : {}),
      ...(typeof branchSession.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: branchSession.checkpointMessageIndex }
        : {}),
      ...(branchSession.checkpointCreatedAt
        ? { checkpointCreatedAt: branchSession.checkpointCreatedAt }
        : {}),
      ...(branchSession.breakpointSelection
        ? { breakpointSelection: branchSession.breakpointSelection }
        : {}),
      ...(branchSession.checkpointSessionId
        ? { checkpointSessionId: branchSession.checkpointSessionId }
        : {}),
      ...(branchSession.parentSessionId
        ? { parentSessionId: branchSession.parentSessionId }
        : {}),
      ...(branchSession.scope ? { scope: branchSession.scope } : {}),
      ...(branchSession.supervisionProgress
        ? { supervisionProgress: branchSession.supervisionProgress }
        : {}),
    },
    branchSession,
    resolutionSource: "persisted_session_fallback",
  };
}

function getDefaultFinalizeWorkstreamSupervisionDeps(): FinalizeWorkstreamSupervisionDeps {
  const runtime = loadWorkstreamsToolRuntime();

  return {
    getRepoRoot: () => process.cwd(),
    resolveFinalizableSupervision: async ({ repoRoot, sessionId, streamId }) => {
      const resolvedRuntime = await runtime;
      const resolvedCurrent =
        resolvedRuntime.resolveCurrentBranchSupervisionContext?.({
          repoRoot,
          streamId,
          sessionId,
        });

      if (resolvedCurrent?.current?.branchSessionId && resolvedCurrent?.streamId) {
        const branchSession = resolvedRuntime
          .loadSupervisorState(repoRoot, resolvedCurrent.streamId)
          ?.branch_sessions.find(
            (branch: any) =>
              branch.branchSessionId === resolvedCurrent.current.branchSessionId,
          );

        if (branchSession) {
          return {
            streamId: resolvedCurrent.streamId,
            current: resolvedCurrent.current,
            branchSession,
            resolutionSource: "current_supervision_context",
          } satisfies FinalizeWorkstreamSupervisionResolution;
        }
      }

      for (const candidateStreamId of listCandidateStreamIds(
        resolvedRuntime,
        repoRoot,
        streamId,
      )) {
        const branchSession = resolvedRuntime
          .loadSupervisorState(repoRoot, candidateStreamId)
          ?.branch_sessions.find(
            (branch: any) =>
              branch.branchRole === "supervision" &&
              branch.nativeSessionId === sessionId,
          );
        const fallback = buildPersistedSupervisionFallback({
          streamId: candidateStreamId,
          branchSession,
        });

        if (fallback) {
          return fallback;
        }
      }

      return undefined;
    },
    buildBranchSession: async (args) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.buildRootAgentBranchSession(args);
    },
    persistBranchSession: async (repoRoot, streamId, branchSession) => {
      const resolvedRuntime = await runtime;
      return resolvedRuntime.upsertBranchSessionLocked(
        repoRoot,
        streamId,
        branchSession,
      );
    },
    now: () => new Date().toISOString(),
  };
}

function isTerminalSupervisionStatus(
  status: string | undefined,
): status is SupervisionTerminalStatus {
  return status === "completed" || status === "stopped" || status === "failed";
}

function buildFinalizationNotes(args: {
  existingNotes?: string;
  notes?: string;
  summary?: string;
  reportText?: string;
}): string | undefined {
  const incomingSections = [
    args.notes?.trim(),
    args.summary?.trim() ? `Summary:\n${args.summary.trim()}` : undefined,
    args.reportText?.trim() ? `Final report:\n${args.reportText.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const incomingText = incomingSections.join("\n\n").trim();
  const existingNotes = args.existingNotes?.trim();

  if (!incomingText) {
    return existingNotes || undefined;
  }

  if (!existingNotes) {
    return incomingText;
  }

  if (existingNotes.includes(incomingText)) {
    return existingNotes;
  }

  if (incomingText.includes(existingNotes)) {
    return incomingText;
  }

  return `${existingNotes}\n\n${incomingText}`;
}

async function executeFinalizeWorkstreamSupervision(
  args: {
    status: SupervisionTerminalStatus;
    streamId?: string;
    notes?: string;
    summary?: string;
    reportText?: string;
  },
  context: { sessionID?: string },
  deps: FinalizeWorkstreamSupervisionDeps =
    getDefaultFinalizeWorkstreamSupervisionDeps(),
): Promise<string> {
  const sessionId = context.sessionID;
  if (!sessionId) {
    return "Error: Could not determine current supervision session ID";
  }

  const repoRoot = deps.getRepoRoot();
  const resolved = await deps.resolveFinalizableSupervision({
    repoRoot,
    sessionId,
    streamId: args.streamId,
  });

  if (!resolved) {
    return "Error: Could not find persisted workstream supervision state for the current session.";
  }

  const existing = resolved.branchSession;
  const requestedStatus = args.status;
  const status = isTerminalSupervisionStatus(existing?.status)
    ? existing.status
    : requestedStatus;
  const updatedAt = deps.now();
  const completedAt = existing?.completedAt ?? updatedAt;
  const notes = buildFinalizationNotes({
    existingNotes: existing?.notes,
    notes: args.notes,
    summary: args.summary,
    reportText: args.reportText,
  });
  const batchId =
    existing?.batchId ?? resolved.current?.supervisionProgress?.currentBatchId;

  await deps.persistBranchSession(
    repoRoot,
    resolved.streamId,
    await deps.buildBranchSession({
      context: {
        rootSessionId: resolved.current.rootSessionId,
        branchSessionId: resolved.current.branchSessionId,
        ...(resolved.current.checkpointMessageId
          ? { checkpointMessageId: resolved.current.checkpointMessageId }
          : {}),
        ...(typeof resolved.current.checkpointMessageIndex === "number"
          ? { checkpointMessageIndex: resolved.current.checkpointMessageIndex }
          : {}),
        ...(resolved.current.checkpointCreatedAt
          ? { checkpointCreatedAt: resolved.current.checkpointCreatedAt }
          : {}),
        ...(resolved.current.breakpointSelection
          ? { breakpointSelection: resolved.current.breakpointSelection }
          : {}),
        ...(resolved.current.checkpointSessionId
          ? { checkpointSessionId: resolved.current.checkpointSessionId }
          : {}),
        ...(resolved.current.parentSessionId
          ? { parentSessionId: resolved.current.parentSessionId }
          : {}),
        ...(resolved.current.nativeSessionId
          ? { nativeSessionId: resolved.current.nativeSessionId }
          : {}),
        ...(existing?.source ? { source: existing.source } : {}),
        ...(existing?.scope ?? resolved.current.scope
          ? { scope: existing?.scope ?? resolved.current.scope }
          : {}),
      },
      branchRole: "supervision",
      status,
      startedAt: existing?.startedAt ?? updatedAt,
      updatedAt,
      completedAt,
      runId: existing?.runId,
      ...(batchId ? { batchId } : {}),
      ...(existing?.supervisionProgress
        ? { supervisionProgress: existing.supervisionProgress }
        : resolved.current.supervisionProgress
          ? { supervisionProgress: resolved.current.supervisionProgress }
          : {}),
      ...(notes ? { notes } : {}),
    }),
  );

  const alreadyFinalized =
    isTerminalSupervisionStatus(existing?.status) && existing?.status === status;
  const resolutionDetail =
    resolved.resolutionSource === "persisted_session_fallback"
      ? " Persisted session fallback was used."
      : "";
  const unchangedStatusDetail =
    isTerminalSupervisionStatus(existing?.status) && existing?.status !== requestedStatus
      ? ` Existing terminal status ${existing.status} was preserved.`
      : "";

  return alreadyFinalized
    ? `Workstream supervision was already finalized as ${status} for ${resolved.streamId}.${unchangedStatusDetail}${resolutionDetail}`
    : `Marked workstream supervision as ${status} for ${resolved.streamId}.${unchangedStatusDetail}${resolutionDetail}`;
}

async function resolveCompletedBranchNativeSessionId(args: {
  deps: LaunchSupervisionBranchDeps;
  repoRoot: string;
  streamId: string;
  branchSessionId: string;
  title: string;
  nativeSessionId?: string;
}): Promise<string | undefined> {
  if (args.nativeSessionId) {
    return args.nativeSessionId;
  }

  const storedNativeSessionId = await args.deps.waitForBranchNativeSessionId({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  });

  if (storedNativeSessionId) {
    return storedNativeSessionId;
  }

  return args.deps.findNativeSessionIdByTitle(args.repoRoot, args.title);
}

async function collectCompletedBranchArtifacts(args: {
  deps: LaunchSupervisionBranchDeps;
  repoRoot: string;
  streamId: string;
  branchSessionId: string;
  title: string;
  nativeSessionId?: string;
}): Promise<{
  nativeSessionId?: string;
  terminalBranch?: any;
  transcript?: any;
  reportText: string;
  transcriptError?: string;
}> {
  const nativeSessionId = await resolveCompletedBranchNativeSessionId(args);
  const terminalBranch = await args.deps.waitForTerminalBranchSession({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  });

  if (!nativeSessionId) {
    return {
      terminalBranch,
      reportText: "",
    };
  }

  try {
    const transcript = await args.deps.exportSessionTranscript(nativeSessionId);
    return {
      nativeSessionId,
      terminalBranch,
      transcript,
      reportText: (await args.deps.extractFinalBranchReport(transcript)).trim(),
    };
  } catch (error: any) {
    return {
      nativeSessionId,
      terminalBranch,
      reportText: "",
      transcriptError: error?.message || String(error),
    };
  }
}

function formatCheckpointPointer(pointer: RootCheckpointPointer): string {
  if (pointer.checkpointMessageId) {
    return `message ${pointer.checkpointMessageId}`;
  }

  if (typeof pointer.checkpointMessageIndex === "number") {
    return `message-index ${pointer.checkpointMessageIndex}`;
  }

  return "unknown-pointer";
}

function formatBreakpointSelection(
  selection: RootCheckpointPointer["breakpointSelection"],
): string | undefined {
  if (!selection) {
    return undefined;
  }

  if (
    typeof selection.rationale === "string" &&
    selection.rationale.trim().length > 0
  ) {
    return selection.rationale.trim();
  }

  if (selection.strategy === "explicit_tag") {
    return selection.matchedTag
      ? `Selected the tagged user message because it matched configured breakpoint tag "${selection.matchedTag}".`
      : "Selected the tagged user message because it matched a configured breakpoint tag.";
  }

  return "Selected the previous user message before branch launch because no configured breakpoint tag was found.";
}

function buildCheckpointCaptureNotes(
  pointer: RootCheckpointPointer,
  scope: BranchLaunchScope,
  batch?: string,
): string {
  const selectionText = formatBreakpointSelection(pointer.breakpointSelection);
  const scopeLabel = describeScopeLabel(scope, batch);

  return [
    `Checkpoint pointer ${formatCheckpointPointer(pointer)} captured; launching Root Agent supervision branch for ${scopeLabel}.`,
    ...(selectionText ? [`Breakpoint selection: ${selectionText}`] : []),
  ].join("\n");
}

function getCheckpointPointerFromBranchSession(
  branch: any,
): RootCheckpointPointer | undefined {
  if (!branch || !branch.checkpointCreatedAt) {
    return undefined;
  }

  if (
    typeof branch.checkpointMessageId === "string" &&
    branch.checkpointMessageId.trim().length > 0
  ) {
    return {
      checkpointMessageId: branch.checkpointMessageId,
      ...(typeof branch.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: branch.checkpointMessageIndex }
        : {}),
      checkpointCreatedAt: branch.checkpointCreatedAt,
      ...(branch.breakpointSelection
        ? { breakpointSelection: branch.breakpointSelection }
        : {}),
    };
  }

  if (typeof branch.checkpointMessageIndex === "number") {
    return {
      checkpointMessageIndex: branch.checkpointMessageIndex,
      checkpointCreatedAt: branch.checkpointCreatedAt,
      ...(branch.breakpointSelection
        ? { breakpointSelection: branch.breakpointSelection }
        : {}),
    };
  }

  return undefined;
}

function formatCheckpointLaunchFallbackError(args: {
  checkpointPointer: RootCheckpointPointer;
  eligibility: CheckpointSessionForkEligibility;
  cause?: unknown;
}): Error {
  const pointerLabel = formatCheckpointPointer(args.checkpointPointer);
  const detail = args.cause
    ? ` Native fork error: ${args.cause instanceof Error ? args.cause.message : String(args.cause)}`
    : "";

  if (!args.checkpointPointer.checkpointMessageId) {
    return new Error(
      `Cannot launch supervision branch from checkpoint pointer ${pointerLabel}: the selected boundary has no stable message ID, so native fork-from-message is unavailable.${
        args.eligibility.canForkCurrentSession
          ? ""
          : ` Plain session --fork would start from the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex ?? "unknown"}).`
      }${detail}`,
    );
  }

  return new Error(
    `Native fork-from-message could not launch from checkpoint pointer ${pointerLabel}.${
      args.eligibility.canForkCurrentSession
        ? " Falling back to plain session --fork is only safe when the selected boundary is already the live session tip."
        : ` Plain session --fork would inherit the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex ?? "unknown"}).`
    }${detail}`,
  );
}

function formatBranchCompletionMessage(args: {
  branchSessionId: string;
  checkpointPointer?: RootCheckpointPointer;
  nativeSessionId?: string;
  tmuxSessionName?: string;
  observedPersistedStatus?: string;
  status: "completed" | "stopped" | "failed";
  summary: string;
  reportText: string;
  transcript?: any;
  transcriptError?: string;
}): string {
  const transcriptLabel = args.transcript
    ? `Transcript export captured (${Array.isArray(args.transcript.messages) ? args.transcript.messages.length : 0} messages).`
    : args.nativeSessionId
      ? `Transcript export unavailable: ${args.transcriptError ?? "unknown export error"}`
      : "Transcript export unavailable: native branch session ID was not resolved.";

  const sections = [
    `Supervision branch ${args.branchSessionId}${args.nativeSessionId ? ` (native session ${args.nativeSessionId})` : ""} ${args.status}${args.checkpointPointer ? ` from checkpoint pointer ${formatCheckpointPointer(args.checkpointPointer)}` : ""}.`,
    ...(args.checkpointPointer?.breakpointSelection
      ? [
          `Breakpoint selection: ${formatBreakpointSelection(args.checkpointPointer.breakpointSelection)}`,
        ]
      : []),
    `Persisted branch status: ${args.status}.`,
    ...(args.tmuxSessionName
      ? [
          `Tmux session: ${args.tmuxSessionName}. Attach with \`tmux attach -t ${args.tmuxSessionName}\` to inspect it.`,
        ]
      : []),
    transcriptLabel,
  ];

  if (
    args.observedPersistedStatus &&
    args.observedPersistedStatus !== args.status
  ) {
    sections.push(
      `Pre-final persisted branch status: ${args.observedPersistedStatus} (for example, supervise-pass handoff recorded before parent-side finalization).`,
    );
  }

  if (args.reportText) {
    sections.push(`Extracted final branch report:\n${args.reportText}`);
  }

  if (args.summary && args.summary !== args.reportText) {
    sections.push(`Branch run summary:\n${args.summary}`);
  }

  return sections.join("\n\n");
}

function getTerminalBranchStatus(
  storedStatus: string | undefined,
  runCode: number,
): "completed" | "stopped" | "failed" {
  if (
    storedStatus === "completed" ||
    storedStatus === "stopped" ||
    storedStatus === "failed"
  ) {
    return storedStatus;
  }

  return runCode === 0 ? "completed" : "failed";
}

function isActiveSupervisionBranchStatus(status: string | undefined): boolean {
  return typeof status === "string" && ACTIVE_SUPERVISION_BRANCH_STATUSES.has(status);
}

function hasActiveSupervisionSessionHandle(branch: {
  nativeSessionId?: string;
  tmuxSessionName?: string;
}): boolean {
  return (
    (typeof branch.nativeSessionId === "string" && branch.nativeSessionId.trim().length > 0) ||
    (typeof branch.tmuxSessionName === "string" && branch.tmuxSessionName.trim().length > 0)
  );
}

function doLaunchScopesMatch(
  left: BranchLaunchScope | undefined,
  right: BranchLaunchScope | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right || left.level !== right.level) {
    return false;
  }

  if (left.level === "stage" && right.level === "stage") {
    return left.stageId === right.stageId;
  }

  return left.stageId === right.stageId && left.batchId === right.batchId;
}

function formatExistingSupervisionLaunchMessage(args: {
  streamId: string;
  branch: {
    branchSessionId?: string;
    status?: string;
    tmuxSessionName?: string;
  };
  scope?: BranchLaunchScope;
  batch?: string;
}): string {
  const scopeLabel = describeScopeLabel(args.scope, args.batch);
  const branchLabel = args.branch.branchSessionId ?? "(unknown branch session)";
  const statusLabel = args.branch.status ?? "unknown";

  return [
    `Refusing duplicate supervision launch for ${scopeLabel} in ${args.streamId}.`,
    `Active nonterminal supervision branch already exists: ${branchLabel} (${statusLabel}).`,
    ...(args.branch.tmuxSessionName
      ? [
          `Attach with \`tmux attach -t ${args.branch.tmuxSessionName}\` to inspect the existing supervision session.`,
        ]
      : ["Existing supervision session has no persisted tmux attach instructions."]),
    "Preserving the existing active supervision scope is safer than launching a second overlapping branch.",
  ].join("\n");
}

async function persistSupervisionBranchState(args: {
  deps: LaunchSupervisionBranchDeps;
  repoRoot: string;
  streamId: string;
  rootSessionId: string;
  branchSessionId: string;
  parentSessionId?: string;
  checkpointMessageId?: string;
  checkpointMessageIndex?: number;
  checkpointCreatedAt?: string;
  breakpointSelection?: RootCheckpointPointer["breakpointSelection"];
  checkpointSessionId?: string;
  nativeSessionId?: string;
  tmuxSessionName?: string;
  status: "pending" | "running" | "completed" | "stopped" | "failed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  batchId?: string;
  runId?: string;
  notes: string;
  scope?: BranchLaunchScope;
}): Promise<void> {
  await args.deps.persistBranchSession(
    args.repoRoot,
    args.streamId,
    await args.deps.buildBranchSession({
      context: {
        rootSessionId: args.rootSessionId,
        branchSessionId: args.branchSessionId,
        ...(args.checkpointMessageId
          ? { checkpointMessageId: args.checkpointMessageId }
          : {}),
        ...(typeof args.checkpointMessageIndex === "number"
          ? { checkpointMessageIndex: args.checkpointMessageIndex }
          : {}),
        ...(args.checkpointCreatedAt
          ? { checkpointCreatedAt: args.checkpointCreatedAt }
          : {}),
        ...(args.breakpointSelection
          ? { breakpointSelection: args.breakpointSelection }
          : {}),
        ...(args.checkpointSessionId
          ? { checkpointSessionId: args.checkpointSessionId }
          : {}),
        parentSessionId: args.parentSessionId ?? args.rootSessionId,
        ...(args.nativeSessionId
          ? { nativeSessionId: args.nativeSessionId }
          : {}),
        source: args.nativeSessionId ? "native_fork" : "repo_local_fallback",
        ...(args.scope ? { scope: args.scope } : {}),
      },
      branchRole: "supervision",
      status: args.status,
      startedAt: args.startedAt,
      updatedAt: args.updatedAt,
      completedAt: args.completedAt,
      tmuxSessionName: args.tmuxSessionName,
      runId: args.runId,
      batchId: args.batchId,
      notes: args.notes,
    }),
  );
}

async function executeLaunchSupervisionBranch(
  args: {
    streamId?: string;
    scope?: string;
    target?: string;
    stage?: string;
    batch?: string;
    breakpointTags?: string;
    breakpointMode?: string;
    noServer?: boolean;
    silent?: boolean;
  },
  context: { sessionID?: string },
  deps: LaunchSupervisionBranchDeps = getDefaultLaunchSupervisionBranchDeps(),
): Promise<string> {
  const rootSessionId = context.sessionID;

  if (!rootSessionId) {
    return "Error: Could not determine current Root Agent session ID";
  }

  const repoRoot = deps.getRepoRoot();
  const normalizedStreamId = normalizeOptionalLaunchString(args.streamId);
  const normalizedTarget = resolveLegacyLaunchTarget(args);
  const breakpointTags = parseBreakpointTagsArg(args.breakpointTags);
  const breakpointMode = parseBreakpointModeArg(args.breakpointMode);
  const streamId = await deps.getResolvedStreamId(repoRoot, normalizedStreamId);
  const launchScope = resolveLaunchScope({
    scope: args.scope,
    target: normalizedTarget,
  });
  const resolvedBatchTarget = launchScope?.level === "batch" ? launchScope.batchId : undefined;

  const parentBranch = await deps.findBranchSessionForLaunchSessionId(
    repoRoot,
    streamId,
    rootSessionId,
  );

  if (parentBranch) {
    const parentBranchLabel = parentBranch.branchSessionId ?? rootSessionId;
    return [
      "Error: Supervision branches cannot launch additional supervision branches.",
      `Current session is already branch ${parentBranchLabel}.`,
      "Current guard is intentionally one-level only and triggers when the current native session is already recorded as a branch session.",
      "Yield back to the Root Agent so it can inspect persisted branch state and decide the next action.",
    ].join("\n");
  }

  const activeMatchingBranch = await deps.findActiveMatchingSupervisionBranch({
    repoRoot,
    streamId,
    rootSessionId,
    scope: launchScope,
  });

  if (activeMatchingBranch) {
    return formatExistingSupervisionLaunchMessage({
      streamId,
      branch: activeMatchingBranch,
      scope: launchScope,
      batch: resolvedBatchTarget,
    });
  }

  const branchSessionId = await deps.createBranchSessionId();
  const title = `root-supervision-${streamId}-${branchSessionId}`;
  const startedAt = deps.now();
  const existingBranch = await deps.loadStoredBranchSession(
    repoRoot,
    streamId,
    branchSessionId,
  );
  const tmuxSessionName =
    existingBranch?.tmuxSessionName ??
    (await deps.createSupervisionTmuxSessionName(streamId));

  if (await deps.tmuxSessionExists(tmuxSessionName)) {
    return [
      `Supervision session ${tmuxSessionName} is already running for ${streamId}.`,
      `Attach with \`tmux attach -t ${tmuxSessionName}\` to observe it.`,
      "Refusing to launch another supervision session for the same branch metadata.",
    ].join("\n");
  }

  await persistSupervisionBranchState({
    deps,
    repoRoot,
    streamId,
    rootSessionId,
    branchSessionId,
    status: "pending",
    startedAt,
      updatedAt: startedAt,
      tmuxSessionName,
      batchId: resolvedBatchTarget,
      scope: launchScope,
    notes: `Capturing checkpoint pointer metadata for ${describeScopeLabel(launchScope, resolvedBatchTarget)}; branch is not active yet.`,
  });

  let checkpointPointer: RootCheckpointPointer | undefined;

  try {
    const checkpointCreatedAt = deps.now();
    const rootSessionExport = await deps.exportSessionTranscript(rootSessionId);
    checkpointPointer = await deps.refreshCheckpointPointer({
      repoRoot,
      streamId,
      rootSessionId,
      sessionExport: rootSessionExport,
      checkpointCreatedAt,
      ...(breakpointTags ? { breakpointTags } : {}),
      ...(breakpointMode ? { breakpointMode } : {}),
    });

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt,
      breakpointSelection: checkpointPointer.breakpointSelection,
      status: "pending",
      startedAt,
      updatedAt: deps.now(),
      tmuxSessionName,
      batchId: resolvedBatchTarget,
      scope: launchScope,
      notes: buildCheckpointCaptureNotes(checkpointPointer, launchScope, resolvedBatchTarget),
    });

    const checkpointForkEligibility =
      await deps.getCheckpointSessionForkEligibility({
        pointer: checkpointPointer,
        sessionExport: rootSessionExport,
      });

    if (!checkpointForkEligibility.valid) {
      throw new Error(
        `Checkpoint pointer ${formatCheckpointPointer(checkpointPointer)} no longer resolves against the current root transcript (${checkpointForkEligibility.reason ?? "unknown validation failure"}).`,
      );
    }

    const supervisionPrompt = buildSupervisionPrompt({
      scope: launchScope,
      batch: resolvedBatchTarget,
    });
    const persistNativeSessionId = async (nativeSessionId: string) => {
      const updatedAt = deps.now();
      const storedBranch = await deps.loadStoredBranchSession(
        repoRoot,
        streamId,
        branchSessionId,
      );

      await persistSupervisionBranchState({
        deps,
        repoRoot,
        streamId,
        rootSessionId,
        branchSessionId,
        parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
        checkpointMessageId:
          storedBranch?.checkpointMessageId ??
          checkpointPointer.checkpointMessageId,
        checkpointMessageIndex:
          storedBranch?.checkpointMessageIndex ??
          checkpointPointer.checkpointMessageIndex,
        checkpointCreatedAt:
          storedBranch?.checkpointCreatedAt ??
          checkpointPointer.checkpointCreatedAt,
        breakpointSelection:
          storedBranch?.breakpointSelection ??
          checkpointPointer.breakpointSelection,
        nativeSessionId,
        status: storedBranch?.status === "running" ? "running" : "pending",
        startedAt: storedBranch?.startedAt ?? startedAt,
        updatedAt,
        tmuxSessionName: storedBranch?.tmuxSessionName ?? tmuxSessionName,
        runId: storedBranch?.runId,
        batchId: storedBranch?.batchId ?? resolvedBatchTarget,
        scope: storedBranch?.scope ?? launchScope,
        notes:
          storedBranch?.notes ??
          buildCheckpointCaptureNotes(checkpointPointer, launchScope, resolvedBatchTarget),
      });
    };

    let runResult: ForkedSessionResult;

    if (!checkpointPointer.checkpointMessageId) {
      if (!checkpointForkEligibility.canForkCurrentSession) {
        throw formatCheckpointLaunchFallbackError({
          checkpointPointer,
          eligibility: checkpointForkEligibility,
        });
      }

      runResult = await deps.runForkedSession({
        sessionId: rootSessionId,
        repoRoot,
        title,
        prompt: supervisionPrompt,
        forkMode: "latest_session_fork",
        tmuxSessionName,
        onNativeSessionId: persistNativeSessionId,
      });
    } else {
      try {
        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          checkpointMessageId: checkpointPointer.checkpointMessageId,
          forkMode: "message",
          tmuxSessionName,
          onNativeSessionId: persistNativeSessionId,
        });
      } catch (error) {
        if (!checkpointForkEligibility.canForkCurrentSession) {
          throw formatCheckpointLaunchFallbackError({
            checkpointPointer,
            eligibility: checkpointForkEligibility,
            cause: error,
          });
        }

        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          forkMode: "latest_session_fork",
          tmuxSessionName,
          onNativeSessionId: persistNativeSessionId,
        });
      }
    }

    const parsed = await deps.parseOutput(runResult.stdout);
    const fallbackSummary =
      parsed.text.trim() ||
      runResult.stderr.trim() ||
      "(branch session produced no summary)";
    const {
      nativeSessionId,
      terminalBranch,
      transcript,
      reportText,
      transcriptError,
    } = await collectCompletedBranchArtifacts({
      deps,
      repoRoot,
      streamId,
      branchSessionId,
      title,
      nativeSessionId: runResult.nativeSessionId,
    });
    const storedBranch =
      terminalBranch ??
      (await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId));
    const completedAt = deps.now();
    const status = getTerminalBranchStatus(
      storedBranch?.status,
      runResult.code,
    );
    const summary = reportText || fallbackSummary;
    const storedCheckpointPointer =
      getCheckpointPointerFromBranchSession(storedBranch);

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
      checkpointMessageId:
        storedBranch?.checkpointMessageId ??
        checkpointPointer.checkpointMessageId,
      checkpointMessageIndex:
        storedBranch?.checkpointMessageIndex ??
        checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt:
        storedBranch?.checkpointCreatedAt ??
        storedCheckpointPointer?.checkpointCreatedAt ??
        checkpointPointer.checkpointCreatedAt,
      breakpointSelection:
        storedBranch?.breakpointSelection ??
        storedCheckpointPointer?.breakpointSelection ??
        checkpointPointer.breakpointSelection,
      nativeSessionId,
      status,
      startedAt: storedBranch?.startedAt ?? startedAt,
      updatedAt: completedAt,
      completedAt,
      tmuxSessionName: storedBranch?.tmuxSessionName ?? runResult.tmuxSessionName ?? tmuxSessionName,
        runId: storedBranch?.runId,
        batchId: storedBranch?.batchId ?? resolvedBatchTarget,
        scope: storedBranch?.scope ?? launchScope,
      notes: appendSupervisionTmuxObservability(
        storedBranch?.status === "running"
          ? `Parent/root finalized branch after supervise-pass handoff.\n\n${summary}`
          : summary,
        runResult.tmuxMetadata,
      ),
    });

    return formatBranchCompletionMessage({
      branchSessionId,
      checkpointPointer: storedCheckpointPointer ?? checkpointPointer,
      nativeSessionId,
      tmuxSessionName:
        storedBranch?.tmuxSessionName ?? runResult.tmuxSessionName ?? tmuxSessionName,
      observedPersistedStatus: storedBranch?.status,
      status,
      summary,
      reportText,
      transcript,
      transcriptError,
    });
  } catch (error: any) {
    const failedAt = deps.now();

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer?.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer?.checkpointMessageIndex,
      checkpointCreatedAt: checkpointPointer?.checkpointCreatedAt,
      breakpointSelection: checkpointPointer?.breakpointSelection,
      status: "failed",
      startedAt,
      updatedAt: failedAt,
      completedAt: failedAt,
      tmuxSessionName,
      batchId: resolvedBatchTarget,
      scope: launchScope,
      notes: `Failed to launch Root Agent supervision branch: ${error?.message || error}`,
    });

    return `Supervision branch ${branchSessionId} failed to launch.\n\n${error?.message || error}`;
  }
}

/**
 * Link the current session to a workstream as its planning session.
 *
 * Usage: After creating a workstream with `work create`, use this tool
 * to link the current opencode session as the planning session.
 */
export const link_planning_session = tool({
  description:
    "Link the current opencode session to a workstream as its planning session. Use this after creating a workstream to enable resuming this conversation later with 'work plan'.",
  args: {
    streamId: tool.schema
      .string()
      .describe(
        "The workstream ID or name (e.g., '012-my-feature' or 'my-feature'). If omitted, uses the current workstream.",
      )
      .optional(),
  },
  async execute(args, context) {
    const sessionId = context.sessionID;

    if (!sessionId) {
      return "Error: Could not determine current session ID";
    }

    // Build the command
    const cmdArgs = ["plan", "--set", sessionId];
    if (args.streamId) {
      cmdArgs.push("--stream", args.streamId);
    }

    try {
      const result = await Bun.$`work ${cmdArgs}`.text();
      return result.trim();
    } catch (error: any) {
      return `Error linking session: ${error.message || error}`;
    }
  },
});

/**
 * Get information about the current workstream.
 */
export const current_workstream = tool({
  description:
    "Get information about the current workstream, including its ID, name, and planning session status.",
  args: {},
  async execute() {
    try {
      const result = await Bun.$`work current`.text();
      return result.trim();
    } catch (error: any) {
      return `Error getting current workstream: ${error.message || error}`;
    }
  },
});

export const finalize_workstream_supervision = Object.assign(
  tool({
    description:
      "Mark the current workstream supervision session as completed, stopped, or failed and persist optional notes before the final report.",
    args: {
      status: tool.schema
        .string()
        .describe(
          "Terminal supervision status: 'completed', 'stopped', or 'failed'.",
        ),
      streamId: tool.schema
        .string()
        .describe(
          "Optional workstream ID or name. Usually omitted because the current supervision context is inferred automatically.",
        )
        .optional(),
      notes: tool.schema
        .string()
        .describe("Optional supervision notes to persist.")
        .optional(),
      summary: tool.schema
        .string()
        .describe("Optional short supervision summary to persist.")
        .optional(),
      reportText: tool.schema
        .string()
        .describe("Optional final report text to persist before sending it to the user.")
        .optional(),
    },
    async execute(args, context) {
      return executeFinalizeWorkstreamSupervision(
        args as {
          status: SupervisionTerminalStatus;
          streamId?: string;
          notes?: string;
          summary?: string;
          reportText?: string;
        },
        context,
      );
    },
  }),
  {
    __test: {
      executeFinalizeWorkstreamSupervision,
      buildFinalizationNotes,
    },
  },
);

/**
 * Get diagnostic information about the loaded workstream tool/runtime.
 */
export const tool_runtime_info = Object.assign(
  tool({
    description:
      "Report the loaded workstream tool version, runtime resolution paths, and branch-work capability flags for debugging stale tool loads.",
    args: {},
    async execute() {
      return formatWorkstreamsToolRuntimeInfo(getWorkstreamsToolRuntimeInfo());
    },
  }),
  {
    __test: {
      WORKSTREAM_TOOL_VERSION,
      getWorkstreamsToolRuntimeInfo,
      formatWorkstreamsToolRuntimeInfo,
      loadWorkstreamsToolRuntime,
      resolveWorkstreamsRuntimeModulePath,
    },
  },
);

export const launch_supervision_branch = Object.assign(
  tool({
    description:
      "Fork the current Root Agent session into a supervision child session, record durable workstream lineage metadata, and return the branch handoff summary.",
    args: {
      streamId: tool.schema
        .string()
        .describe(
          "The workstream ID or name. If omitted, uses the current workstream.",
        )
        .optional(),
      scope: tool.schema
        .string()
        .describe(
          "Supervision scope: 'batch' for a single explicit batch target or 'stage' for a stage loop that derives the next resumable batch from persisted state.",
        ),
      target: tool.schema
        .string()
        .describe(
          "Scope target. Use a stage id like '10' when scope='stage', or a stage-qualified batch id like '10.01' when scope='batch'.",
        ),
      noServer: tool.schema
        .boolean()
        .describe("Skip starting opencode serve for the headless batch launch.")
        .optional(),
      silent: tool.schema
        .boolean()
        .describe("Disable notification sounds during batch execution.")
        .optional(),
    },
    async execute(args, context) {
      return executeLaunchSupervisionBranch(args, context);
    },
  }),
  {
    __test: {
      executeLaunchSupervisionBranch,
      runMessageBoundaryForkLaunch,
      runForkedSessionInTmux,
    },
  },
);
