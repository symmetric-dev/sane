/** Browser-safe public repository-domain contracts. No native or filesystem imports. */
import type { WorkstreamType } from "./workstream-type.ts"
import type { Lifecycle } from "./lifecycle.ts"
export type * from "./lifecycle.ts"
export { SUPPORTED_WORKSTREAM_TYPES, isSupportedWorkstreamType } from "./workstream-type.ts"
export type { WorkstreamType } from "./workstream-type.ts"
export type Harness = "cc" | "oc"
export interface ConversationRef { harness: Harness; authorityId: string; nativeId: string }
export type HandoffStatus = "queued" | "acceptance_unknown" | "accepted" | "running" | "completed" | "failed"
export interface HandoffInput { requestId: string; to: Phase; message: string; target?: ConversationRef; createNew?: boolean; harness?: Harness; checkout?: string }
export interface HandoffRecipient { ownerId: string; sessionId: string; ref: ConversationRef | null; harness: Harness; authorityId: string; checkout: CheckoutPin }
export interface Handoff { id: string; repositoryId: string; sender: ConversationRef; workstreamId: string; input: HandoffInput; recipient: HandoffRecipient; status: HandoffStatus; revision: number; attemptId: string | null; nativeCommandId: string | null; runId: string | null; evidence: string | null; createdAt: string; updatedAt: string }
export type NativeSourceDescriptor = { version: 1; harness: "cc"; kind: "local-profile"; profileRoot: string } | { version: 1; harness: "oc"; kind: "local-registration"; registrationFile: string }
export interface NativeAuthority { descriptor: NativeSourceDescriptor; authorityId: string }
export type Phase = "design" | "engineering" | "planning" | "execution" | "research" | `research:${string}`
export interface CheckoutPin { path: string; commonDir: string; gitDir: string; device: number; inode: number; commonDevice: number; commonInode: number; gitDevice: number; gitInode: number }
export interface RepositoryDiscovery { primaryCheckout: string; commonDir: string; stateRoot: string; databasePath: string; primaryPin: CheckoutPin; invocationCheckout: CheckoutPin }
export interface RepositoryContext extends RepositoryDiscovery { repositoryId: string; schemaVersion: 1 }
export type StoreAvailability = { state: "ready"; context: RepositoryContext } | { state: "uninitialized" | "unsupported" | "corrupt" | "unavailable" | "stale-binding"; code: DomainErrorCode; message: string; path: string }
export type MutationActor = { kind: "local" | "human" | "system" } | { kind: "native"; repositoryId: string; ref: ConversationRef }
export interface MutationContext { actor: MutationActor; correlationId: string; expectedRevision?: number }
export interface Workstream { repositoryId: string; id: string; title: string; type: WorkstreamType; defaultCheckout: CheckoutPin | null; createdAt: string; updatedAt: string; revision: number; lifecycle: Lifecycle }
export interface Conversation { id: string; repositoryId: string; ref: ConversationRef; executionCheckout: CheckoutPin; parent: ConversationRef | null; workstreamId: string | null; createdAt: string }
export interface PhaseAssignment { id: string; membershipId: string; ref: ConversationRef; workstreamId: string; phase: Phase; startedAt: string; endedAt: string | null }
export interface WorkstreamStatus { workstream: Workstream; conversations: Conversation[]; activePhases: PhaseAssignment[]; phaseHistory: PhaseAssignment[] }
export interface InvocationContext { repositoryId: string; conversation: Conversation; workstream: Workstream | null; executionCheckout: string; primaryCheckout: string; artifactsRoot: string | null }
export interface RegisterConversationInput { ref: ConversationRef; executionCheckout: string; parent?: ConversationRef | null }
export interface CreateWorkstreamInput { id: string; title: string; type: WorkstreamType; defaultCheckout?: string | null }
export interface AuditEvent { id: number; correlationId: string; actor: MutationActor; operation: string; workstreamId: string | null; entityId: string | null; details: Record<string, unknown>; timestamp: string }
export interface ResearchIndex { registered: { topic: string; reportPath: string; contentHash: string; createdAt: string; updatedAt: string; missing: boolean; modified: boolean }[]; unregistered: string[]; warnings: string[] }
export interface ApprovalEvidence { id: string; workstreamId: string; phase: "design" | "engineering" | "planning" | "execution"; userReference: string; hashVersion: number; snapshotHash: string; createdAt: string; actorEventId: number; gitCommit: string | null; files: { path: string; hash: string }[] }
export type DomainErrorCode = "INVALID_INPUT" | "NOT_INITIALIZED" | "ALREADY_INITIALIZED" | "UNSUPPORTED_SCHEMA" | "INCOMPLETE_INITIALIZATION" | "CORRUPT_STORE" | "UNAVAILABLE" | "INVALID_CONTEXT" | "STALE_BINDING" | "NOT_FOUND" | "CONFLICT" | "BUSY" | "INVALID_CHECKOUT" | "AMBIGUOUS_TARGET" | "INVALID_ARTIFACT" | "STORAGE_ERROR" | "FEATURE_UNAVAILABLE" | "NATIVE_CONTEXT_UNAVAILABLE" | "SOURCE_UNAVAILABLE"
