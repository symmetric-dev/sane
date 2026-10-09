"""Execute generated snippets against Marimo's actual ID-or-name cell view."""
import ast
import asyncio
import contextlib
import io
import json
import sys

import marimo._code_mode as cm
from marimo._ast.cell import CellConfig
from marimo._code_mode._context import _CellsView
from marimo._messaging.notebook.document import NotebookCell, NotebookDocument
from marimo._types.ids import CellId_t


class Context:
    def __init__(self):
        self._document = NotebookDocument([
            NotebookCell(CellId_t("abcd"), "x = 1", "friendly_name", CellConfig())
        ])
        self.cells = _CellsView(self)
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def _note_read(self, *args):
        pass

    def create_cell(self, code, **kwargs):
        self.calls.append("create")
        return "newid"

    def edit_cell(self, cell_id, **kwargs):
        self.calls.append("edit")

    def run_cell(self, cell_id):
        self.calls.append("run")


results = []
for case in json.load(sys.stdin):
    ctx = Context()
    # This is the upstream ambiguity the adapter must guard against.
    assert "friendly_name" in ctx.cells
    assert "friendly_name" not in ctx.cells.keys()
    cm.get_context = lambda: ctx
    output = io.StringIO()
    error = None
    try:
        with contextlib.redirect_stdout(output):
            asyncio.run(eval(compile(case["snippet"], "<sane-snippet>", "exec", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), {}))
    except ValueError as exc:
        error = str(exc)
    results.append({"error": error, "calls": ctx.calls, "stdout": output.getvalue()})
print(json.dumps(results))
