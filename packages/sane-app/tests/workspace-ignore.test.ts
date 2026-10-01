import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { countIgnoreRules, validateIgnoreSnapshot, WORKSPACE_IGNORE_MAX_RULE_LENGTH } from "../src/workspace-ignore";

const modulePath = fileURLToPath(new URL("../src/workspace-ignore.ts", import.meta.url));
const childPath = fileURLToPath(new URL("../src/workspace-ignore-evaluator.ts", import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Every evaluator regression lives in an externally killable harness. Even a
 * regression moving an adversarial regexp onto its event loop cannot hang the
 * Bun test runner or defeat the outer watchdog. No synchronous matcher oracle. */
async function harness(body: string, cwd?: string, milliseconds = 6000): Promise<void> {
  const control = await mkdtemp(join(tmpdir(), "sane-ignore-harness-")); roots.push(control);
  const registry = join(control, "workers.json");
  await writeFile(registry, "[]");
  const source = `import assert from "node:assert/strict";
    import {existsSync,writeFileSync,renameSync} from "node:fs";
    import { WorkspaceIgnoreEvaluator } from ${JSON.stringify(modulePath)};
    const harnessNativeSpawn=Bun.spawn, harnessWorkers=new Map();
    const recordWorkers=()=>{
      writeFileSync(${JSON.stringify(registry + ".next")},JSON.stringify([...harnessWorkers.keys()]));
      renameSync(${JSON.stringify(registry + ".next")},${JSON.stringify(registry)});
    };
    const killWorker=worker=>{try{process.kill(-worker.pid,"SIGKILL");}catch{}try{worker.kill("SIGKILL");}catch{}};
    Bun.spawn=(...args)=>{
      const worker=harnessNativeSpawn(...args);
      harnessWorkers.set(worker.pid,worker);recordWorkers();
      void worker.exited.then(()=>{harnessWorkers.delete(worker.pid);recordWorkers();});
      return worker;
    };
    async function assertReaped(worker, expectedSignal) {
      // Bun 1.4.2 may retain exitCode=null after SIGKILL. Instead prove that
      // exited was already settled when the evaluator returned, without an
      // unbounded await that could hide a broken production stop()/reap().
      let settled=false;
      void worker.exited.then(()=>{settled=true;});
      await Promise.resolve();
      assert.ok(settled,"evaluator returned before worker.exited settled");
      await worker.exited;
      if(expectedSignal) assert.equal(worker.signalCode,expectedSignal);
      assert.throws(()=>process.kill(worker.pid,0),{code:"ESRCH"},"worker PID still exists after evaluator returned");
    }
    try {
      ${body}
      console.log("ignore-harness-ok");
    } finally {
      // Assertion failures also reclaim live detached workers. The external
      // watchdog independently uses the registry if this event loop is stuck.
      const remaining=[...harnessWorkers.values()];
      for(const worker of remaining)killWorker(worker);
      await Promise.all(remaining.map(worker=>worker.exited));
      Bun.spawn=harnessNativeSpawn;
    }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", source], {
    cwd: cwd ?? fileURLToPath(new URL("..", import.meta.url)),
    env: { LANG: "C", LC_ALL: "C" }, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const kill = () => {
    // Stop the harness first so it cannot keep spawning workers while cleanup
    // reads the live-PID registry. Evaluator workers own separate process groups.
    try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {}
    let pids: unknown;
    try { pids = JSON.parse(readFileSync(registry, "utf8")); } catch { return; }
    if (!Array.isArray(pids)) return;
    for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {}
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => { kill(); reject(new Error("Ignore harness exceeded external watchdog")); }, milliseconds); });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 64 * 1024) { kill(); throw new Error("Harness output limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString();
  };
  try {
    const [code, stdout, stderr] = await Promise.race([Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]), watchdog]);
    expect(stderr).toBe(""); expect(code).toBe(0); expect(stdout).toBe("ignore-harness-ok\n");
  } finally { if (timer !== undefined) clearTimeout(timer); kill(); await child.exited; }
}

test("rule accounting preserves tabs, escaped comments, BOM and ASCII-space grammar", () => {
  expect(countIgnoreRules("\n#comment\n \n\uFEFF   \n\t\n\\#literal\n\\!literal\n #pattern\n\uFEFF#conservative\n")).toBe(5);
  expect(countIgnoreRules(Array(2001).fill("\t").join("\n"))).toBe(2001);
  expect(() => validateIgnoreSnapshot(Array(2001).fill("\t").join("\n"))).toThrow();
  expect(validateIgnoreSnapshot(Array(2000).fill("\t").join("\r\n"))).toEqual({ rules: 2000 });
  expect(validateIgnoreSnapshot("x".repeat(WORKSPACE_IGNORE_MAX_RULE_LENGTH))).toEqual({ rules: 1 });
  expect(() => validateIgnoreSnapshot("x".repeat(WORKSPACE_IGNORE_MAX_RULE_LENGTH + 1))).toThrow();
  expect(() => validateIgnoreSnapshot("#".repeat(512 * 1024 + 1))).toThrow();
});

test("outer/inner snapshots preserve directory, escaped, anchored and negated ignore semantics", async () => {
  await harness(`
    const e = new WorkspaceIgnoreEvaluator({ deadline: Date.now() + 4000 });
    try {
      await e.register("", "*.log\\n!keep.log\\ncache/\\n\\\\#literal\\n\\\\!literal\\n/root-only\\n");
      await e.register("src", "!drop.log\\nprivate.txt\\n!private.txt\\n");
      await e.register("src/deep", "drop.log\\n");
      assert.deepEqual(await e.test([""], [
        {path:"drop.log", directory:false}, {path:"keep.log", directory:false},
        {path:"cache", directory:true}, {path:"cache", directory:false},
        {path:"#literal", directory:false}, {path:"!literal", directory:false},
        {path:"root-only", directory:false}, {path:"src/root-only", directory:false},
        {path:"UPPER.LOG", directory:false}, {path:"line\\nbreak", directory:false}
      ]), [true,false,true,false,true,true,true,false,false,false]);
      assert.deepEqual(await e.test(["", "src"], [
        {path:"src/drop.log", directory:false}, {path:"src/private.txt", directory:false}
      ]), [false,false]);
      assert.deepEqual(await e.test(["", "src", "src/deep"], [{path:"src/deep/drop.log",directory:false}]), [true]);
      assert.deepEqual(await e.test([], [{path:"anything",directory:false}]), [false]);
      assert.deepEqual(await e.test([""], []), []);
    } finally { await e.close(); await e.close(); }
  `);
});

test("snapshot and batch admission is bounded and duplicate/unknown scopes fail closed", async () => {
  await harness(`
    const e = new WorkspaceIgnoreEvaluator({deadline:Date.now()+4000});
    try {
      await e.register("", "#".repeat(512*1024));
      await assert.rejects(e.register("src", "x"), {code:"ignore-limit"});
      await assert.rejects(e.register("", "x"), {code:"ignore-unavailable"});
      await assert.rejects(e.test(["missing"], []), {code:"ignore-unavailable"});
      await assert.rejects(e.test([""], Array(129).fill({path:"x",directory:false})), {code:"ignore-limit"});
      await assert.rejects(e.test([""], [{path:"x".repeat(4097),directory:false}]), {code:"ignore-unavailable"});
      assert.equal((await e.test([""], Array(128).fill({path:"x",directory:false}))).length,128);
    } finally { await e.close(); }
    const many = new WorkspaceIgnoreEvaluator({deadline:Date.now()+4000});
    try {
      for(let i=0;i<256;i++) await many.register("scope"+i, "");
      await assert.rejects(many.register("overflow", ""), {code:"ignore-limit"});
    } finally { await many.close(); }
  `);
});

// Repeated short /** fragments caused multi-second synchronous matching in the
// previous implementation; the line-length limit alone cannot solve this.
const adversarial = `"a"+"/**".repeat(20)+"/never"`;
const adversarialPath = `"a/"+Array(20).fill("a").join("/")+"/different"`;

test("adversarial matching honors an absolute deadline while the harness heartbeat runs", async () => {
  await harness(`
    let ticks=0; const heartbeat=setInterval(()=>ticks++,10);
    const original=Bun.spawn; let worker;
    Bun.spawn=(...args)=>{ worker=original(...args); return worker; };
    const start=Date.now(), e=new WorkspaceIgnoreEvaluator({deadline:start+1000});
    try {
      await e.register("", ${adversarial});
      await assert.rejects(e.test([""],[{path:${adversarialPath},directory:false}]), {code:"search-time-limit"});
      assert.ok(ticks>=5, "matching blocked the coordinator heartbeat");
      assert.ok(Date.now()-start<2500, "deadline did not kill and reap promptly");
      await assertReaped(worker,"SIGKILL");
      await assert.rejects(e.test([""],[]), {code:"search-time-limit"});
    } finally { clearInterval(heartbeat); await e.close(); Bun.spawn=original; }
  `);
});

test("abort kills and reaps matching; already aborted/expired operations never spawn", async () => {
  await harness(`
    const original=Bun.spawn; let worker, spawns=0;
    Bun.spawn=(...args)=>{ spawns++; worker=original(...args); return worker; };
    const signal=new AbortController(); signal.abort();
    const pre=new WorkspaceIgnoreEvaluator({signal:signal.signal});
    await assert.rejects(pre.register("","x"),{code:"search-aborted"}); await pre.close();
    const expired=new WorkspaceIgnoreEvaluator({deadline:Date.now()-1});
    await assert.rejects(expired.test([],[]),{code:"search-time-limit"}); await expired.close();
    assert.equal(spawns,0);
    const controller=new AbortController(), e=new WorkspaceIgnoreEvaluator({signal:controller.signal,deadline:Date.now()+4000});
    let timer;
    try {
      await e.register("",${adversarial});
      timer=setTimeout(()=>controller.abort(),50);
      const start=Date.now();
      await assert.rejects(e.test([""],[{path:${adversarialPath},directory:false}]),{code:"search-aborted"});
      assert.ok(Date.now()-start<1500); await assertReaped(worker,"SIGKILL");
      await assert.rejects(e.test([""],[]),{code:"search-aborted"}); assert.equal(spawns,1);
    } finally { clearTimeout(timer); await e.close(); Bun.spawn=original; }
  `);
});

test("closing an outstanding operation is idempotent and rejects without a late successful result", async () => {
  await harness(`
    const original=Bun.spawn; let worker;
    Bun.spawn=(...args)=>{worker=original(...args);return worker;};
    const e=new WorkspaceIgnoreEvaluator({deadline:Date.now()+4000});
    try {
      await e.register("",${adversarial});
      const pending=e.test([""],[{path:${adversarialPath},directory:false}]);
      const rejection=assert.rejects(pending,{code:"ignore-unavailable"});
      await new Promise(resolve=>setTimeout(resolve,30));
      await Promise.all([e.close(),e.close(),rejection]);
      await assertReaped(worker,"SIGKILL");
      await assert.rejects(e.register("src","x"),{code:"ignore-unavailable"});
    } finally {await e.close();Bun.spawn=original;}
  `);
});

test("startup deadlines/cancellation reap the child and concurrent requests are not queued", async () => {
  await harness(`
    const original=Bun.spawn;
    try {
      for(const aborted of [false,true]) {
        let worker; const controller=new AbortController();
        Bun.spawn=(args,options)=>{worker=original([process.execPath,"--no-env-file","--no-install","--eval","await new Promise(r=>setTimeout(r,10000));"],options);return worker;};
        const e=new WorkspaceIgnoreEvaluator({signal:controller.signal,deadline:Date.now()+150});
        const timer=aborted?setTimeout(()=>controller.abort(),50):undefined;
        try {
          const start=Date.now();
          const pending=e.register("","x");
          const rejection=assert.rejects(pending,{code:aborted?"search-aborted":"search-time-limit"});
          await assert.rejects(e.test([],[]),{code:"ignore-busy"});
          await rejection;
          await assertReaped(worker,"SIGKILL");
          assert.ok(Date.now()-start<1500,"startup cancellation/deadline did not reap promptly");
        } finally {clearTimeout(timer);await e.close();}
      }
    } finally {Bun.spawn=original;}
  `);
});

test("startup failure, malformed replies, crashes, excessive output and late IDs fail closed", async () => {
  await harness(`
    const original=Bun.spawn;
    Bun.spawn=()=>{throw new Error("startup failure");};
    const unavailable=new WorkspaceIgnoreEvaluator({deadline:Date.now()+1000});
    await assert.rejects(unavailable.register("","x"),{code:"ignore-unavailable"}); await unavailable.close();
    const frame=(id,values)=>{const p=Buffer.from(JSON.stringify({id,values})),h=Buffer.alloc(4);h.writeUInt32BE(p.length);return Buffer.concat([h,p]);};
    const scenarios=[
      'await Bun.write(Bun.stdout,"bad!");',
      'process.exit(1);',
      'await Bun.write(Bun.stdout,Buffer.alloc(8192,120));',
      'await Bun.write(Bun.stdout,frame(0,[])); await Bun.stdin.stream().getReader().read(); await Bun.write(Bun.stdout,frame(999,[]));',
      'await Bun.write(Bun.stdout,frame(0,[])); await Bun.stdin.stream().getReader().read(); await Bun.write(Bun.stdout,frame(1,["not-boolean"]));',
      'await Bun.write(Bun.stdout,frame(0,[])); await Bun.stdin.stream().getReader().read(); await Bun.write(Bun.stdout,frame(1,[])); await new Promise(r=>setTimeout(r,20)); await Bun.write(Bun.stdout,frame(1,[]));'
    ];
    try {
      let completed=0;
      for(const [index,scenario] of scenarios.entries()) {
        let worker;
        const fake='const frame='+frame.toString()+'; '+scenario+'; await new Promise(r=>setTimeout(r,10000));';
        Bun.spawn=(args,options)=>{worker=original([process.execPath,"--no-env-file","--no-install","--eval",fake],options);return worker;};
        const e=new WorkspaceIgnoreEvaluator({deadline:Date.now()+1500});
        try {
          await assert.rejects(async()=>{await e.register("","x"); await new Promise(r=>setTimeout(r,40)); await e.test([""],[{path:"x",directory:false}]);},{code:"ignore-unavailable"});
          await assertReaped(worker,index===1?undefined:"SIGKILL");
          if(index===1) assert.equal(await worker.exited,1);
          completed++;
        } finally {await e.close();}
      }
      assert.equal(completed,scenarios.length,"not all malformed/crash/late-reply scenarios completed");
    } finally {Bun.spawn=original;}
  `);
}, 15000);

test("the evaluator launches installation-relative from a different package cwd without workspace env/preloads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sane-ignore-cwd-")); roots.push(cwd);
  const marker = join(cwd, "preload-marker"), preload = join(cwd, "evil.ts");
  await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, "loaded");`);
  await writeFile(join(cwd, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
  await writeFile(join(cwd, ".env"), `BUN_OPTIONS=--preload=${preload}\n`);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module", name: "untrusted-workspace" }));
  // The harness itself must not start in the poisoned cwd before it can disable
  // that cwd's bunfig. Change cwd only after importing the trusted module.
  await harness(`
    const original=Bun.spawn; let options, command;
    process.chdir(${JSON.stringify(cwd)});
    process.env.BUN_OPTIONS=${JSON.stringify("--preload=" + preload)};
    process.env.SECRET_WORKSPACE_TOKEN="must-not-cross";
    Bun.spawn=(args,config)=>{command=args;options=config;return original(args,config);};
    const e=new WorkspaceIgnoreEvaluator({deadline:Date.now()+3000});
    try {
      await e.register("","x"); assert.deepEqual(await e.test([""],[{path:"x",directory:false}]),[true]);
      assert.equal(command[0],process.execPath); assert.equal(command.at(-1),${JSON.stringify(childPath)});
      assert.notEqual(options.cwd,process.cwd());
      assert.deepEqual(options.env,{LANG:"C",LC_ALL:"C"}); assert.equal(existsSync(${JSON.stringify(marker)}),false);
    } finally {await e.close();Bun.spawn=original;}
  `);
});

test("the subprocess independently rejects out-of-order and oversize protocol frames", async () => {
  await harness(`
    for(const oversized of [false,true]) {
      const worker=Bun.spawn([process.execPath,"--no-env-file","--no-install",${JSON.stringify(childPath)}],{env:{LANG:"C",LC_ALL:"C"},stdin:"pipe",stdout:"pipe",stderr:"ignore"});
      const reader=worker.stdout.getReader();
      try {
        await reader.read();
        const payload=Buffer.from(JSON.stringify({id:2,kind:"register",scopeId:"",text:"x"})),header=Buffer.alloc(4);
        header.writeUInt32BE(oversized?4*1024*1024+1:payload.length);
        worker.stdin.write(oversized?header:Buffer.concat([header,payload]));await worker.stdin.flush();
        assert.notEqual(await worker.exited,0);
        await assertReaped(worker);
      } finally {try{worker.kill("SIGKILL");}catch{}await worker.exited;await reader.cancel();}
    }
  `);
});
