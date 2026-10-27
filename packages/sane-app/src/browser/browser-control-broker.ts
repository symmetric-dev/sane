import type { BrowserControlState as ControlState } from "../../shared/browser-host-contract";
export type { BrowserControlMode } from "../../shared/browser-host-contract";
export type BrowserControlState = ControlState & { pausedByHuman: boolean };
export type BrowserAgentLease = { leaseGeneration: number; signal: AbortSignal };
export type BrowserHumanInputKind = "mousePressed" | "mouseReleased" | "mouseMoved" | "touchStart" | "touchMove" | "touchEnd" | "touchCancel" | "wheel" | "keyDown" | "rawKeyDown" | "char" | "keyUp" | "insertText" | "navigate" | "takeover" | "pause";

export class BrowserControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const deliberate = new Set<BrowserHumanInputKind>(["mousePressed", "touchStart", "wheel", "keyDown", "rawKeyDown", "char", "insertText", "navigate", "takeover", "pause"]);

export class BrowserControlBroker {
  private current: BrowserControlState;
  private controller: AbortController | null = null;
  constructor(readonly workspaceId: string, readonly tabId: string, private readonly onTransition?: (state: BrowserControlState) => void, initialLeaseGeneration = 0) {
    if (!Number.isSafeInteger(initialLeaseGeneration) || initialLeaseGeneration < 0) throw new BrowserControlError(400, "browser-generation", "Browser lease generation must be a nonnegative integer");
    this.current = { mode: "human-owned", controllerAttachmentId: null, agentSessionId: null, leaseGeneration: initialLeaseGeneration, pausedByHuman: false, updatedAt: new Date().toISOString() };
  }
  snapshot(): BrowserControlState { return { ...this.current }; }
  private expected(generation: number) {
    if (!Number.isSafeInteger(generation) || generation !== this.current.leaseGeneration) throw new BrowserControlError(409, "browser-stale-control", "Browser control changed; refresh the control state");
  }
  private running() {
    if (this.current.mode === "stopped") throw new BrowserControlError(409, "browser-tab-stopped", "Browser tab is stopped; restart it explicitly");
  }
  private transition(change: Partial<BrowserControlState>, code = "browser-agent-preempted", nextController: AbortController | null = null): BrowserControlState {
    const generation = this.current.leaseGeneration + 1;
    if (!Number.isSafeInteger(generation)) throw new BrowserControlError(409, "browser-generation-limit", "Browser control generation exhausted");
    const previous = this.controller;
    this.controller = nextController;
    this.current = { ...this.current, ...change, leaseGeneration: generation, updatedAt: new Date().toISOString() };
    previous?.abort(new BrowserControlError(409, code, "Browser agent lease was revoked"));
    this.onTransition?.(this.snapshot());
    return this.snapshot();
  }
  claim(attachmentId: string, expectedGeneration: number): BrowserControlState {
    this.expected(expectedGeneration); this.running();
    if (this.current.controllerAttachmentId !== null) throw new BrowserControlError(409, "browser-controlled", "Another viewer owns browser input; use Take control");
    return this.take(attachmentId, expectedGeneration);
  }
  take(attachmentId: string, expectedGeneration: number): BrowserControlState {
    this.expected(expectedGeneration); this.running();
    if (!attachmentId) throw new BrowserControlError(400, "browser-attachment", "A viewer attachment is required");
    return this.transition({ mode: "human-owned", controllerAttachmentId: attachmentId, agentSessionId: null, pausedByHuman: this.current.pausedByHuman || this.current.mode === "agent-owned" });
  }
  release(attachmentId: string, expectedGeneration: number): BrowserControlState {
    this.expected(expectedGeneration); this.running();
    if (this.current.controllerAttachmentId !== attachmentId) throw new BrowserControlError(403, "browser-viewer", "Only the controlling viewer can release browser input");
    return this.transition({ mode: "human-owned", controllerAttachmentId: null, agentSessionId: null, pausedByHuman: false });
  }
  detachAttachment(attachmentId: string): BrowserControlState {
    if (this.current.controllerAttachmentId !== attachmentId) return this.snapshot();
    if (this.current.mode === "agent-owned") {
      this.current = { ...this.current, controllerAttachmentId: null, updatedAt: new Date().toISOString() };
      this.onTransition?.(this.snapshot());
      return this.snapshot();
    }
    return this.release(attachmentId, this.current.leaseGeneration);
  }
  onHumanInput(attachmentId: string, inputKind: BrowserHumanInputKind, allowUnclaimed = true): BrowserControlState {
    this.running();
    const owner = this.current.controllerAttachmentId;
    if (!attachmentId || owner !== null && owner !== attachmentId || owner === null && !allowUnclaimed) throw new BrowserControlError(403, "browser-viewer", "Claim or take browser control before sending input");
    if (!deliberate.has(inputKind)) {
      if (owner !== attachmentId || this.current.mode === "paused") throw new BrowserControlError(403, "browser-viewer", "Deliberate human input is required to take browser control");
      return this.snapshot();
    }
    if (inputKind === "pause") {
      if (this.current.mode === "paused" && owner === attachmentId) return this.snapshot();
      return this.transition({ mode: "paused", controllerAttachmentId: attachmentId, agentSessionId: null, pausedByHuman: true });
    }
    if (this.current.mode === "human-owned" && owner === attachmentId) return this.snapshot();
    return this.transition({ mode: "human-owned", controllerAttachmentId: attachmentId, agentSessionId: null, pausedByHuman: this.current.pausedByHuman || this.current.mode === "agent-owned" });
  }
  grantAgentControl(sessionId: string): BrowserControlState {
    if (this.current.mode === "stopped") return this.snapshot();
    if (this.current.controllerAttachmentId === null && (this.current.mode !== "agent-owned" || this.current.agentSessionId === sessionId)) {
      return this.transition({ mode: "agent-owned", agentSessionId: sessionId, pausedByHuman: false }, "browser-agent-preempted", new AbortController());
    }
    if (this.current.controllerAttachmentId !== null && (this.current.pausedByHuman || this.current.mode === "paused")) {
      return this.transition({ mode: this.current.mode === "paused" ? "human-owned" : this.current.mode, pausedByHuman: false });
    }
    return this.snapshot();
  }
  acquireAgentLease(sessionId: string, hasControlGrant: boolean): BrowserAgentLease {
    this.running();
    if (this.current.mode === "paused" || this.current.pausedByHuman) throw new BrowserControlError(409, "browser-agent-paused", "Human paused or interrupted the agent; click Resume agent in SANE");
    if (!hasControlGrant) throw new BrowserControlError(403, "browser-grant-required", "An explicit browser Control grant is required");
    if (!sessionId) throw new BrowserControlError(400, "browser-session", "A verified agent session is required");
    if (this.current.mode === "agent-owned") {
      if (this.current.agentSessionId !== sessionId) throw new BrowserControlError(409, "browser-agent-controlled", "Another agent session holds the browser lease");
      return { leaseGeneration: this.current.leaseGeneration, signal: this.controller!.signal };
    }
    const controller = new AbortController(), leaseGeneration = this.current.leaseGeneration + 1;
    this.transition({ mode: "agent-owned", agentSessionId: sessionId, pausedByHuman: false }, "browser-agent-preempted", controller);
    this.assertAgentLease(sessionId, leaseGeneration);
    return { leaseGeneration, signal: controller.signal };
  }
  assertAgentLease(sessionId: string, leaseGeneration: number): void {
    this.running();
    if (this.current.mode !== "agent-owned" || this.current.agentSessionId !== sessionId || this.current.leaseGeneration !== leaseGeneration || !this.controller || this.controller.signal.aborted) throw new BrowserControlError(409, "browser-agent-preempted", "Browser agent lease is stale or was preempted by human input");
  }
  pauseAgent(): BrowserControlState {
    this.running();
    return this.transition({ mode: "paused", pausedByHuman: true, agentSessionId: null }, "browser-agent-paused");
  }
  resumeAgent(sessionId: string, expectedGeneration: number): BrowserAgentLease {
    this.expected(expectedGeneration); this.running();
    if (!sessionId) throw new BrowserControlError(400, "browser-session", "A verified agent session is required");
    const controller = new AbortController(), leaseGeneration = this.current.leaseGeneration + 1;
    this.transition({ mode: "agent-owned", agentSessionId: sessionId, pausedByHuman: false }, "browser-agent-preempted", controller);
    this.assertAgentLease(sessionId, leaseGeneration);
    return { leaseGeneration, signal: controller.signal };
  }
  revokeAgentLease(sessionId?: string): BrowserControlState {
    if (this.current.mode !== "agent-owned" || sessionId !== undefined && this.current.agentSessionId !== sessionId) return this.snapshot();
    return this.pauseAgent();
  }
  markStopped(): BrowserControlState {
    return this.transition({ mode: "stopped", controllerAttachmentId: null, agentSessionId: null, pausedByHuman: false }, "browser-tab-stopped");
  }
}
