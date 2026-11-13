import argparse
import ast
import json
import math
import subprocess
from pathlib import Path
from typing import Any


class ReadProblem(RuntimeError):
    pass


def lookup(path: Path, text: str) -> list[dict[str, Any]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    nodes: list[ast.stmt] = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PublicKnowledge"]
    if len(nodes) != 1:
        raise AssertionError("Expected one PublicKnowledge class")
    namespace: dict[str, Any] = {
        "Path": Path, "ReadProblem": ReadProblem, "subprocess": subprocess, "json": json, "math": math,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), "exec"), namespace)
    public = namespace["PublicKnowledge"]
    if not isinstance(public, type):
        raise AssertionError("Expected a PublicKnowledge class")
    return public().lookup(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bindings", type=Path)
    parser.add_argument("text")
    args = parser.parse_args()
    try:
        terms = lookup(args.bindings, args.text)
    except ReadProblem as error:
        print(json.dumps({"ok": False, "code": str(error)}, separators=(",", ":")))
        return 1
    print(json.dumps({"ok": True, "terms": terms}, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
