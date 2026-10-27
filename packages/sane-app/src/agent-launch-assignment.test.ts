import { describe, expect, test } from "bun:test";
import type { WorkerAgentId } from "sane-core/agent-catalog";
import type { ConversationRef } from "sane-core/contracts";
import type { RepositoryDomain } from "sane-core/server";
import { workerAssignment, workerAssignmentOnly } from "./agent-launch";

// Pure domain doubles: no repository state, context files, native sessions or I/O.
const child: ConversationRef = { harness: "oc", authorityId: "fixture-authority", nativeId: "fixture-child" };
const parent: ConversationRef = { harness: "oc", authorityId: "fixture-authority", nativeId: "fixture-parent" };
const correlationId = "fixture-launch";
const procedure = "# SANE Procedure: synthetic pinned procedure\n\nPROCEDURE BODY";
function fixture(options: { status?: string; workstream?: boolean; specExists?: boolean; reportTemplateExists?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let status = options.status ?? "planned";
  const domain = {
    repositoryId: "fixture-repository",
    resolveContext(ref: ConversationRef) {
      calls.push({ method: "resolveContext", args: [ref] });
      return { artifactsRoot: options.workstream === false ? null : "/synthetic/workstream", executionCheckout: "/synthetic/implementation", workstream: options.workstream === false ? null : { id: "fixture-workstream" } };
    },
    getJobContext(workstreamId: string, jobId: string, ref: ConversationRef) {
      calls.push({ method: "getJobContext", args: [workstreamId, jobId, ref] });
      return {
        job: { status, specExists: options.specExists ?? true, specPath: `/synthetic/${jobId}/spec.md`, reportPath: `/synthetic/${jobId}/report.md` },
        reportTemplateExists: options.reportTemplateExists ?? true, reportTemplate: `/synthetic/${jobId}/template.md`,
      };
    },
    updateJob(...args: unknown[]) {
      calls.push({ method: "updateJob", args });
      status = args[2] as string;
    },
  };
  return { domain: domain as unknown as RepositoryDomain, calls };
}
function assignment(workstream = true, jobs: readonly string[] = ["job-one"]) {
  return [
    "# SANE Assignment", "", "Directory conventions:", "- `<implementation>/` = /synthetic/implementation",
    ...(workstream ? ["- `<workstream>/` = /synthetic/workstream"] : []),
    ...jobs.flatMap(job => ["", `Job: ${job}`, `Job spec: /synthetic/${job}/spec.md`, `Job report: /synthetic/${job}/report.md`, `Report template: /synthetic/${job}/template.md`]),
  ].join("\n");
}

describe("worker launch assignment-only composition", () => {
  test("assigned implementer resolves paths and starts a planned job exactly once with parent attribution", () => {
    const { domain, calls } = fixture();
    expect(workerAssignmentOnly(domain, child, parent, "implementer", ["job-one"], correlationId)).toBe(assignment());
    expect(calls).toEqual([
      { method: "resolveContext", args: [child] },
      { method: "getJobContext", args: ["fixture-workstream", "job-one", child] },
      { method: "updateJob", args: ["fixture-workstream", "job-one", "running", { actor: { kind: "native", repositoryId: "fixture-repository", ref: parent }, correlationId }] },
    ]);
    workerAssignmentOnly(domain, child, parent, "implementer", ["job-one"], correlationId);
    expect(calls.filter(call => call.method === "updateJob")).toHaveLength(1);
  });

  test("historical helper preserves pinned procedure plus assignment and identical domain semantics", () => {
    const legacy = fixture();
    const selective = fixture();
    const oldText = workerAssignment(legacy.domain, child, parent, "implementer", ["job-one"], correlationId, procedure);
    const pathsOnly = workerAssignmentOnly(selective.domain, child, parent, "implementer", ["job-one"], correlationId);
    expect(oldText).toBe(`${procedure}\n\n${assignment()}`);
    expect(pathsOnly).toBe(assignment());
    expect(pathsOnly).not.toContain("PROCEDURE BODY");
    expect(legacy.calls).toEqual(selective.calls);
  });

  test("free implementer returns only roots in both formats and never resolves or mutates jobs", () => {
    for (const workstream of [true, false]) {
      const legacy = fixture({ workstream });
      const selective = fixture({ workstream });
      expect(workerAssignment(legacy.domain, child, parent, "implementer", [], correlationId, procedure)).toBe(assignment(workstream, []));
      expect(workerAssignmentOnly(selective.domain, child, parent, "implementer", [], correlationId)).toBe(assignment(workstream, []));
      expect(selective.calls).toEqual([{ method: "resolveContext", args: [child] }]);
      expect(legacy.calls).toEqual(selective.calls);
    }
  });

  for (const role of ["tester", "reviewer", "fixer"] as const satisfies readonly WorkerAgentId[]) {
    test(`${role} resolves jobs in caller order but never changes planned job state`, () => {
      const { domain, calls } = fixture();
      expect(workerAssignmentOnly(domain, child, parent, role, ["job-two", "job-one"], correlationId)).toBe(assignment(true, ["job-two", "job-one"]));
      expect(calls.filter(call => call.method === "updateJob")).toHaveLength(0);
    });
  }

  test("implementer does not restart non-planned jobs", () => {
    for (const status of ["running", "complete"]) {
      const { domain, calls } = fixture({ status });
      expect(workerAssignmentOnly(domain, child, parent, "implementer", ["job-one"], correlationId)).toBe(assignment());
      expect(calls.filter(call => call.method === "updateJob")).toHaveLength(0);
    }
  });

  for (const [label, options, error] of [
    ["no workstream", { workstream: false }, /require a workstream/],
    ["missing spec", { specExists: false }, /spec is missing/],
    ["missing report template", { reportTemplateExists: false }, /report template is missing/],
  ] as const) {
    test(`${label} fails both formats before any mutation`, () => {
      const legacy = fixture(options);
      const selective = fixture(options);
      expect(() => workerAssignment(legacy.domain, child, parent, "implementer", ["job-one"], correlationId, procedure)).toThrow(error);
      expect(() => workerAssignmentOnly(selective.domain, child, parent, "implementer", ["job-one"], correlationId)).toThrow(error);
      expect(selective.calls.filter(call => call.method === "updateJob")).toHaveLength(0);
      expect(legacy.calls).toEqual(selective.calls);
    });
  }
});
