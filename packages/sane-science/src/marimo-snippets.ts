const common = `import base64, hashlib, json, marimo
import marimo._code_mode as cm
if marimo.__version__ != "0.25.1":
    raise RuntimeError("SANE requires marimo 0.25.1 in the kernel")
def _sane_hash(code):
    return hashlib.sha256(code.encode("utf-8")).hexdigest()
`

function prelude(payload: object, marker: string): string {
  // Base64 contains no Python quoting/control characters; JSON itself stays data.
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  return `${common}\n_sane_p = json.loads(base64.b64decode("${encoded}"))\ndef _sane_emit(value):\n    print("${marker}" + json.dumps(value, ensure_ascii=True, allow_nan=False))\n`
}

export function inspectSnippet(marker: string): string {
  return prelude({}, marker) + `
async with cm.get_context() as ctx:
    _sane_result = {
        "cells": [{
            "id": c.id, "code": c.code, "sourceHash": _sane_hash(c.code),
            "name": c.name, "status": c.status,
            "errors": [{"kind": e.kind, "message": e.msg} for e in c.errors],
            "output": c.output.asdict() if c.output is not None else None,
            "consoleOutputs": [o.asdict() for o in c.console_outputs],
        } for c in ctx.cells.values()],
        "graph": {
            "parents": {cid: sorted(ids) for cid, ids in ctx.graph.parents.items()},
            "children": {cid: sorted(ids) for cid, ids in ctx.graph.children.items()},
        },
    }
_sane_emit(_sane_result)
`
}

export type CellOperation =
  | { kind: "create"; code: string; after?: string; run: boolean }
  | { kind: "edit"; cellId: string; code: string; expectedSourceHash: string; run: boolean }
  | { kind: "run"; cellId: string; run: true }

export function operationSnippet(operation: CellOperation, marker: string): string {
  return prelude(operation, marker) + `
_sane_cid = _sane_p.get("cellId", "")
_sane_conflict = False
if _sane_p["kind"] != "run":
    async with cm.get_context() as ctx:
        if _sane_p["kind"] == "create":
            if _sane_p.get("after") is not None and _sane_p["after"] not in ctx.cells.keys():
                raise ValueError("Unknown exact after-cell ID")
            _sane_cid = ctx.create_cell(_sane_p["code"], after=_sane_p.get("after"), hide_code=False)
        else:
            if _sane_cid not in ctx.cells.keys():
                raise ValueError("Unknown exact cell ID")
            _sane_current = ctx.cells[_sane_cid].code
            if _sane_hash(_sane_current) != _sane_p["expectedSourceHash"]:
                _sane_conflict = True
            else:
                ctx.edit_cell(_sane_cid, code=_sane_p["code"])
_sane_emit({"cellId": _sane_cid, "mutation": "rejected" if _sane_conflict else ("not-requested" if _sane_p["kind"] == "run" else "accepted")})
if _sane_p["run"] and not _sane_conflict:
    async with cm.get_context() as ctx:
        if _sane_cid not in ctx.cells.keys():
            raise ValueError("Unknown exact cell ID")
        ctx.run_cell(_sane_cid)
`
}
