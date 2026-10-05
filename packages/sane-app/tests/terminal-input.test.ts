import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CatalogService } from "../src/catalog";
import { TerminalService, type TerminalSocketData } from "../src/terminal";
import type { TerminalBindingLease } from "../src/terminal-binding";
import type { TerminalClientMessage, TerminalServerMessage } from "../src/terminal-contract";
import { WorkspaceError } from "../src/workspace";

type Resource = TerminalSocketData["attachment"]["resource"];
type Socket = Bun.ServerWebSocket<TerminalSocketData>;
type Probe = { resources: Map<string, Resource> };

/** Real lifecycle, catalog lease and message queue, with only the native shell
 * and PTY replaced. Git discovery still executes so hot-path counts are real. */
async function fixture(run: (f: {
  catalog: CatalogService; service: TerminalService; resource: Resource;
  cwd: string; root: string; sent: TerminalServerMessage[]; writes: number[][];
  counts(): { discoveries: number; leases: number };
  send(message: TerminalClientMessage): Promise<void>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-terminal-input-")));
  const cwd = join(root, "worktree"), data = join(root, "data");
  let service: TerminalService | undefined;
  const terminalDescriptor = Object.getOwnPropertyDescriptor(Bun, "Terminal")!;
  const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!;
  const originalSpawn = Bun.spawn;
  const writes: number[][] = [], sent: TerminalServerMessage[] = [];
  const exited = Promise.withResolvers<number>();
  let spawned = false;
  try {
    await Promise.all([mkdir(cwd), mkdir(data)]);
    const initialized = Bun.spawnSync(["git", "-C", cwd, "init", "-q"]);
    if (initialized.exitCode) throw new Error(initialized.stderr.toString());
    const catalog = new CatalogService(data, () => []), registered = await catalog.register(cwd);
    let discoveries = 0, leases = 0;
    const discover = catalog.discover.bind(catalog), terminalLease = catalog.terminalLease.bind(catalog);
    catalog.discover = async (...args) => { discoveries++; return discover(...args); };
    let acquired: TerminalBindingLease | undefined;
    catalog.terminalLease = async (...args) => { leases++; acquired = await terminalLease(...args); return acquired; };
    Object.defineProperty(Bun, "Terminal", { value: function () {
      return { write(bytes: Uint8Array) { writes.push([...bytes]); return bytes.length; }, resize() {}, close() {} };
    } });
    Object.defineProperty(Bun, "spawn", { value: (...args: Parameters<typeof Bun.spawn>) => {
      const command = args[0];
      if (Array.isArray(command) && command.length === 2 && command[1] === "-i") {
        spawned = true;
        // Never use 0/-1: the service signals process groups during cleanup.
        return { pid: 2147483647, exited: exited.promise, kill() { exited.resolve(0); } };
      }
      return originalSpawn(...args);
    } });
    service = new TerminalService(catalog, () => true);
    const tree = registered.workspace.worktrees.find(t => t.worktreeId === registered.worktreeId)!;
    await service.change(registered.workspaceId, registered.worktreeId, "start", { bindingRevision: tree.bindingRevision }, () => true);
    expect(spawned).toBe(true);
    const resource = (service as unknown as Probe).resources.get(`${registered.workspaceId}/${registered.worktreeId}`)!;
    expect(acquired).toBeDefined(); expect(resource.bindingLease).toBe(acquired!); expect(leases).toBe(1);
    const socketData = await service.prepare(registered.workspaceId, registered.worktreeId, "token");
    const socket = {
      data: socketData, send(raw: string) { sent.push(JSON.parse(raw)); return 1; },
      getBufferedAmount: () => 0, close() {},
    } as unknown as Socket;
    service.websocket.open!(socket); await resource.tail;
    service.websocket.message!(socket, JSON.stringify({ type: "ack", seq: resource.seq }));
    await run({ catalog, service, resource, root, cwd, sent, writes,
      counts: () => ({ discoveries, leases }),
      send: async message => { service!.websocket.message!(socket, JSON.stringify(message)); await resource.tail; },
    });
  } finally {
    exited.resolve(0);
    try { await service?.close(); }
    finally {
      Object.defineProperty(Bun, "Terminal", terminalDescriptor);
      Object.defineProperty(Bun, "spawn", spawnDescriptor);
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("production terminal lifecycle acquires one lease and keystrokes, resize and interrupt do not rediscover Git", async () => {
  await fixture(async ({ send, resource, counts, writes, cwd }) => {
    const before = counts();
    await send({ type: "claim", generation: 0 });
    for (const character of "interactive input") {
      await send({ type: "input", generation: resource.state.generation, data: Buffer.from(character).toString("base64") });
    }
    await writeFile(join(cwd, "ordinary.txt"), "normal worktree activity");
    await send({ type: "resize", generation: resource.state.generation, cols: 100, rows: 30 });
    await send({ type: "interrupt", generation: resource.state.generation });
    expect(counts()).toEqual(before);
    expect(Buffer.from(writes.flat()).toString()).toBe("interactive input\x03");
    expect(resource.state).toMatchObject({ status: "running", cols: 100, rows: 30 });
  });
});

test("input after authoritative revision change is rejected and stops the terminal", async () => {
  await fixture(async ({ send, resource, catalog, sent, writes, counts }) => {
    await send({ type: "claim", generation: 0 });
    const before = counts();
    const tree = (catalog as unknown as { catalog: { workspaces: { worktrees: { bindingRevision: string }[] }[] } }).catalog.workspaces[0]!.worktrees[0]!;
    tree.bindingRevision = crypto.randomUUID();
    await send({ type: "input", generation: resource.state.generation, data: "eA==" });
    expect(writes).toEqual([]); expect(counts()).toEqual(before);
    expect(sent).toContainEqual({ type: "error", code: "binding-invalid", message: "Terminal worktree binding changed" });
    expect(resource.state.status).toBe("closed"); expect(resource.state.controllerId).toBeNull();
  });
});

test("input after filesystem root replacement is rejected without rediscovery", async () => {
  await fixture(async ({ send, resource, cwd, root, writes, counts }) => {
    await send({ type: "claim", generation: 0 });
    const before = counts();
    await rename(cwd, join(root, "old-worktree")); await mkdir(cwd);
    await send({ type: "input", generation: resource.state.generation, data: "eA==" });
    expect(writes).toEqual([]); expect(counts()).toEqual(before);
    expect(resource.state.status).toBe("closed"); expect(resource.state.controllerId).toBeNull();
  });
});

test("catalog-storage lease failure revokes keyboard control and closes the resource", async () => {
  await fixture(async ({ send, resource, writes }) => {
    await send({ type: "claim", generation: 0 });
    resource.bindingLease.validate = async () => { throw new WorkspaceError(503, "catalog-storage", "Storage failed"); };
    await send({ type: "input", generation: resource.state.generation, data: "eA==" });
    expect(writes).toEqual([]); expect(resource.state.status).toBe("closed"); expect(resource.state.controllerId).toBeNull();
  });
});

test("lease acquisition pin mismatch refuses spawn even after lifecycle discovery succeeded", async () => {
  await fixture(async ({ service, resource, catalog }) => {
    let acquired = 0;
    const lease = resource.bindingLease;
    catalog.terminalLease = async () => {
      acquired++;
      return { ...lease, binding: { ...lease.binding, bindingRevision: "different-revision" } };
    };
    await expect(service.change(resource.state.workspaceId, resource.state.worktreeId, "restart", { bindingRevision: resource.state.bindingRevision }, () => true)).rejects.toMatchObject({ code: "terminal-binding" });
    expect(acquired).toBe(1);
    expect((service as unknown as Probe).resources.get(`${resource.state.workspaceId}/${resource.state.worktreeId}`)).toBe(resource);
  });
});
