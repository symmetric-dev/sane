import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainError, normalizeNativeSource } from "sane-core/server";
import * as server from "sane-core/server";
import type { CheckoutPin, ConversationRef, NativeSourceDescriptor } from "sane-core/contracts";
import type { Admission } from "./app-store";
import type { Session } from "./history";
import { HandoffService } from "./handoff";

// Offline admission of assertRecipientReady's session-harness comparison.
// Known identities use a temp source leaf so normalizeNativeSource can recompute
// the same authority; no bridge, router, Chromium, or native CLI.

const temporaryRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const createdDirectories: string[] = [];
const sessionId = "sess-recipient";
const nativeId = "native-recipient";
const repositoryId = "repo-1";
const ownerId = "store-1";

afterEach(() => {
  for (const root of createdDirectories.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(realpathSync(temporaryRoot), "handoff-ready-"));
  createdDirectories.push(root);
  return realpathSync(root);
}

function pin(path: string): CheckoutPin {
  return { path, commonDir: path, gitDir: join(path, ".git"), device: 1, inode: 1, commonDevice: 1, commonInode: 1, gitDevice: 1, gitInode: 1 };
}

function readyAdmission(source: Admission["source"], checkout: CheckoutPin): Admission {
  return {
    version: 1,
    requestId: "req-1",
    sessionId,
    operation: "create",
    state: "ready",
    source,
    binding: {
      workspaceId: "ws-1",
      worktreeId: "wt-1",
      bindingRevision: "bind-1",
      executionCheckout: checkout.path,
      checkoutPin: checkout,
      domain: { mode: "repository", repositoryId, primaryCheckout: checkout.path },
    },
    parent: null,
    nativeId,
    createdAt: "2026-10-27T00:00:00.000Z",
    error: null,
  };
}

function readySession(harness: Session["harness"], authorityId: string, cwd: string): Session {
  return { sessionId, harness, nativeSessionId: nativeId, authorityId, cwd, lastStatus: "unknown", lastRunId: null };
}

function makeService(admission: Admission, session: Session) {
  const admissions = { get: (id: string) => id === admission.sessionId ? admission : undefined, list: () => [admission] } as unknown as ConstructorParameters<typeof HandoffService>[0];
  const catalog = {} as ConstructorParameters<typeof HandoffService>[1];
  const router = { forWorkspace: async () => { throw new Error("unused"); } } as unknown as ConstructorParameters<typeof HandoffService>[2];
  const sources = {} as ConstructorParameters<typeof HandoffService>[3];
  const sessions = () => [session];
  return new HandoffService(admissions, catalog, router, sources, sessions, () => {}, ownerId, async () => {
    throw new Error("unused");
  });
}

function assertReady(ref: ConversationRef, source: Admission["source"], checkout: CheckoutPin, harness: Session["harness"]) {
  const service = makeService(readyAdmission(source, checkout), readySession(harness, ref.authorityId, checkout.path));
  service.assertRecipientReady({
    repositoryId,
    recipient: { ownerId, sessionId, ref, harness: ref.harness, authorityId: ref.authorityId, checkout },
  });
}

describe.serial("assertRecipientReady session harness", () => {
  test("cc ref and claude-code session with exact ready identity does not throw", () => {
    const root = fixtureRoot();
    const profile = join(root, "profile");
    mkdirSync(profile);
    const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile });
    const checkout = pin(root);
    assertReady({ harness: "cc", authorityId: source.authorityId, nativeId }, source, checkout, "claude-code");
  });

  test("oc ref and opencode session with exact ready identity does not throw", () => {
    const root = fixtureRoot();
    const registration = join(root, "registration.json");
    writeFileSync(registration, "generated registration fixture");
    const source = normalizeNativeSource({ version: 1, harness: "oc", kind: "local-registration", registrationFile: registration });
    const checkout = pin(root);
    assertReady({ harness: "oc", authorityId: source.authorityId, nativeId }, source, checkout, "opencode");
  });

  test("known oc ref against a claude-code session still throws the identity DomainError", () => {
    const root = fixtureRoot();
    const registration = join(root, "registration.json");
    writeFileSync(registration, "generated registration fixture");
    const source = normalizeNativeSource({ version: 1, harness: "oc", kind: "local-registration", registrationFile: registration });
    const checkout = pin(root);
    let error: unknown;
    try {
      assertReady({ harness: "oc", authorityId: source.authorityId, nativeId }, source, checkout, "claude-code");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toBe("Queued recipient session identity or checkout changed.");
  });

  test("unknown ref harness is refused and is not accepted as claude-code", () => {
    const checkout = pin("/offline/forged-checkout");
    const authorityId = "sane-native-v1:gx:" + "ab".repeat(32);
    const descriptor = { version: 1, harness: "gx", kind: "local-profile", profileRoot: "/offline/forged-profile" } as NativeSourceDescriptor;
    const source = { descriptor, authorityId };
    const ref = { harness: "gx", authorityId, nativeId } as ConversationRef;
    // Same unknown value on the forged descriptor lets same() pass. The codec
    // itself rejects "gx", so return that authority and prove the comparison refuses it.
    const spy = spyOn(server, "normalizeNativeSource").mockImplementation(() => source);
    let error: unknown;
    try {
      assertReady(ref, source, checkout, "claude-code");
    } catch (caught) {
      error = caught;
    } finally {
      spy.mockRestore();
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Unknown native harness");
    expect(error).not.toBeInstanceOf(DomainError);
  });
});
