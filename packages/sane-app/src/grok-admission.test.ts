import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AdmissionService } from "./admission";
import { initializeAppStore, publishGrokSourcePin } from "./app-store";
import { CatalogService } from "./catalog";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
const routers: RepositoryRouter[] = [];

afterEach(async () => {
  for (const router of routers.splice(0)) await router.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(repository: boolean) {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-admission-")));
  roots.push(root);
  const data = join(root, "app");
  const cwd = join(root, "workspace");
  const profile = join(root, "claude");
  const registration = join(root, "opencode");
  const home = join(root, "grok-home");
  for (const dir of [data, cwd, profile, registration, home]) mkdirSync(dir);
  if (repository) execFileSync("git", ["init", "--quiet", cwd], { stdio: "pipe" });
  const initial = initializeAppStore(data, {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: profile },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(registration, "service.json") },
  });
  const sources = publishGrokSourcePin(data, home);
  const catalog = new CatalogService(data, () => []);
  await catalog.load();
  const registered = await catalog.register(cwd);
  const router = new RepositoryRouter(catalog, sources);
  routers.push(router);
  const service = new AdmissionService(data, initial.admissions, sources, catalog, router);
  const authority = sources.gk;
  if (!authority?.authorityId) throw new Error("Fixture Grok authority was not resolved");
  const workspace = await catalog.get(registered.workspaceId);
  return { data, cwd, catalog, router, service, authority, workspace, workspaceId: registered.workspaceId, worktreeId: registered.worktreeId };
}

test("repository workspace refuses Grok create before admissions.json changes", async () => {
  const f = await fixture(true);
  expect(f.workspace.kind).toBe("repository");
  const admissionsPath = join(f.data, "admissions.json");
  const sourcesPath = join(f.data, "sources.json");
  const beforeAdmissions = readFileSync(admissionsPath, "utf8");
  const beforeSources = readFileSync(sourcesPath, "utf8");
  let routerCalls = 0;
  const routerRefused = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.inspect = routerRefused;
  f.router.forAdmission = routerRefused;
  f.router.initialize = routerRefused;
  f.router.forWorkspace = routerRefused;
  let catalogCalls = 0;
  const refreshRefused = async () => { catalogCalls += 1; throw new Error("catalog refresh must not be called"); };
  f.catalog.get = refreshRefused;
  f.catalog.list = refreshRefused;
  f.catalog.binding = refreshRefused;
  f.service.register = async () => { routerCalls += 1; throw new Error("register must not be called"); };
  f.service.begin = async () => { throw new Error("begin must not be called"); };
  f.service.createNative = async () => { throw new Error("createNative must not be called"); };
  f.service.ready = () => { throw new Error("ready must not be called"); };
  f.service.enroll = async () => { throw new Error("enroll must not be called"); };

  const refused = await f.service.beginGrokCreate({
    sessionId: crypto.randomUUID(),
    nativeId: crypto.randomUUID(),
    cwd: f.cwd,
    workspaceId: f.workspaceId,
    worktreeId: f.worktreeId,
    authorityId: f.authority.authorityId,
    parent: null,
  }).then(() => { throw new Error("repository workspace must refuse"); }, error => error);

  expect(refused).toBeInstanceOf(WorkstreamAdapterError);
  expect(refused).toMatchObject({ status: 409, code: "grok-repository-refused" });
  expect(readFileSync(admissionsPath, "utf8")).toBe(beforeAdmissions);
  expect(readFileSync(sourcesPath, "utf8")).toBe(beforeSources);
  expect(routerCalls).toBe(0);
  expect(catalogCalls).toBe(0);
  expect(f.service.list()).toEqual([]);
  expect(existsSync(join(f.cwd, ".sane"))).toBe(false);
});

test("app-only workspace still persists a create-only identity_known admission with parent null", async () => {
  const f = await fixture(false);
  expect(f.workspace.kind).toBe("directory");
  const sessionId = crypto.randomUUID();
  const nativeId = crypto.randomUUID();
  const created = await f.service.beginGrokCreate({
    sessionId, nativeId, cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId, parent: null,
  });
  expect(created).toMatchObject({
    operation: "create",
    state: "identity_known",
    sessionId,
    nativeId,
    parent: null,
    binding: { checkoutPin: null, domain: { mode: "app-only" } },
  });
  const published = JSON.parse(readFileSync(join(f.data, "admissions.json"), "utf8"));
  expect(published.version).toBe(2);
  expect(published.admissions).toHaveLength(1);
  expect(published.admissions[0]).toMatchObject({ operation: "create", state: "identity_known", parent: null, nativeId });
  const beforeGet = readFileSync(join(f.data, "admissions.json"));
  expect(f.service.getGrokCreate(sessionId)).toEqual(created);
  const retrieved = f.service.getGrokCreate(sessionId)!;
  retrieved.nativeId = crypto.randomUUID();
  retrieved.source.descriptor.homeRoot = join(TEMP, "not-the-configured-home");
  retrieved.binding.executionCheckout = join(TEMP, "not-the-selected-workspace");
  expect(f.service.getGrokCreate(sessionId)).toEqual(created);
  expect(f.service.getGrokCreate(crypto.randomUUID())).toBeUndefined();
  expect(readFileSync(join(f.data, "admissions.json"))).toEqual(beforeGet);
});

test("configured Grok source getter returns a detached pin even when its home is unavailable", async () => {
  const f = await fixture(false);
  const sourcesPath = join(f.data, "sources.json");
  const admissionsPath = join(f.data, "admissions.json");
  const sourcesBefore = readFileSync(sourcesPath);
  const admissionsBefore = readFileSync(admissionsPath);
  rmSync(f.authority.descriptor.homeRoot, { recursive: true });
  const pin = f.service.getGrokSourcePin();
  expect(pin).toEqual(f.authority);
  expect(pin).not.toBe(f.authority);
  pin!.authorityId = null;
  pin!.descriptor.homeRoot = join(TEMP, "not-the-configured-home");
  expect(f.service.getGrokSourcePin()).toEqual(f.authority);
  expect(readFileSync(sourcesPath)).toEqual(sourcesBefore);
  expect(readFileSync(admissionsPath)).toEqual(admissionsBefore);
});

test("duplicate create checks current records after awaited catalog binding", async () => {
  const f = await fixture(false);
  const input = { sessionId: crypto.randomUUID(), nativeId: crypto.randomUUID(), cwd: f.cwd,
    workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId, parent: null };
  const results = await Promise.allSettled([f.service.beginGrokCreate(input), f.service.beginGrokCreate(input)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "admission-exists" });
  expect(f.service.list()).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.data, "admissions.json"), "utf8")).admissions).toHaveLength(1);
});
