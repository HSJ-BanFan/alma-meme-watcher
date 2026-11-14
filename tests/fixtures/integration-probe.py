import argparse
import ast
import hashlib
import json
import math
import subprocess
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def extract(path: Path, name: str, globals_: dict[str, Any]) -> Callable[..., Any]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    nodes: list[ast.stmt] = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == name]
    if len(nodes) != 1:
        raise AssertionError(f"Expected one {name} definition")
    module = ast.Module(body=nodes, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), globals_)
    value = globals_[name]
    if not callable(value):
        raise AssertionError(f"Extracted {name} is not callable")
    return value


def probe(skill: Path, absent: bool = False) -> dict[str, Any]:
    calls = {"read_post": 0, "read_floor": 0, "facade_detail": 0}

    def notes(kind: str) -> Callable[..., list[str]]:
        def count(*_args: Any) -> list[str]:
            calls[kind] += 1
            return ["MEME_ATTACHMENT_SENTINEL"]
        return count

    post = {"title": "Fixture post", "author": "Fixture account", "comment_num": 1,
            "blocks": [("text", "玉芬啊玉芬"), ("image", "fixture.png"), ("text", "Fixture text after image")],
            "local_images": ["fixture-local.png"], "comments": []}
    root = {"commentid": "11", "text": "Fixture root", "user": {"username": "Fixture user"}}
    reply = {"commentid": "12", "replyid": "11", "text": "Fixture reply", "imgs": ["fixture-image-url"]}
    gates = []
    common = {"_as_int": lambda value: int(value or 0), "_fmt_time": lambda _value: "",
              "_clean_text": lambda value: str(value or ""), "_username": lambda value: (value or {}).get("username", ""),
              "_gate_arm": lambda: gates.append("arm"), "_gate_ok": lambda: gates.append("ok"),
              "_gate_hit": lambda: gates.append("hit")}
    post_env = {**common, "fetch_post": lambda _link: post, "post_url": lambda _link: "fixture-post-url"}
    if not absent:
        post_env["_meme_notes"] = notes("read_post")
    post_output = extract(skill / "xhh_tool.py", "read_post", post_env)("17")
    assert post_output.index("玉芬啊玉芬") < post_output.index("fixture-local.png") < post_output.index("Fixture text after image")
    assert "fixture-post-url" in post_output

    def thread(link, **kwargs):
        assert (link, kwargs) == ("17", {"page": 1, "limit": 50})
        return [{"root": root, "replies": [reply]}]

    floor_env = {**common, "_get_client": lambda: SimpleNamespace(comment_thread=thread)}
    if not absent:
        floor_env["_meme_notes"] = notes("read_floor")
    floor_output = extract(skill / "xhh_tool.py", "read_floor", floor_env)("17", "12")
    assert floor_output.index("Fixture root") < floor_output.index("Fixture reply")
    assert "fixture-image-url" in floor_output and "回复根评论" in floor_output
    assert "root_id=11 目标 cid=12" in floor_output
    assert gates == ["arm", "ok"]

    events = []
    detail = {"scope": "fixture-scope", "post": {"title": "Fixture post", "body": "玉芬啊玉芬", "assets": []},
              "nodes": [{"cid": "11", "text": "Fixture root"}], "warnings": []}
    state = SimpleNamespace(ingest=lambda *_args, **_kwargs: None, observe_visibility=lambda *_args: None,
                            invalidate_delivery=lambda *_args: None)

    def request(kind, *args):
        events.append(kind)
        if kind == "detail":
            assert args == ("17", 1, 50)
            return detail
        if kind == "asset_files":
            return args[0]
        if kind == "verify_account":
            return None
        raise AssertionError(f"Unexpected backend call {kind}")

    instance = SimpleNamespace(state=state, contract_version=1, _request=request,
                               _save_detail=lambda _value: None,
                               result=lambda kind, data, **kwargs: {"kind": kind, "data": data, **kwargs})
    if not absent:
        instance._catalog_detail = notes("facade_detail")
    facade_env = {"ReadBudget": object, "ReadProblem": RuntimeError}
    facade_output = extract(skill / "community_facade.py", "_read_detail", facade_env)(
        instance, "p:17", SimpleNamespace(requests=2))
    assert facade_output["kind"] == "detail"
    assert facade_output["data"]["post"] == detail["post"]
    assert facade_output["data"]["floor"] == [{"cid": "11", "text": "Fixture root", "currently_observed": True}]
    delivery = facade_output["delivery"]
    assert {key: delivery[key] for key in ("post_id", "cids", "scopes")} == {
        "post_id": "17", "cids": {"11"}, "scopes": ["fixture-scope"]}
    # Current community sources add text_only to reply-target deliveries; the
    # legacy fixture predates it, so a post read may omit it but must never set it.
    assert set(delivery) <= {"post_id", "cids", "scopes", "text_only"}
    assert delivery.get("text_only", False) is False
    assert events == ["verify_account", "detail", "asset_files"]
    failures = [name for name, count in calls.items() if count != 0]
    if "knowledge" in facade_output["data"]:
        failures.append("facade_contains_knowledge")
    for name, output in [("post_contains_attachment", post_output), ("floor_contains_attachment", floor_output)]:
        if "MEME_ATTACHMENT_SENTINEL" in output:
            failures.append(name)
    return {"surface": "isolated_real_function_bodies", "ok": not failures,
            "implicit_lookup_calls": calls, "failures": failures,
            "preserved": ["post_text", "image_location", "floor_reply_relationship", "account_verify", "detail_delivery"]}


def knowledge_probe(skill: Path, plugin_root: Path) -> dict[str, Any]:
    class ReadProblem(RuntimeError):
        def __init__(self, code: str, _scope: str = ""):
            self.code = code
            super().__init__(code)

    environment = {"Path": Path, "json": json, "math": math, "subprocess": subprocess, "ReadProblem": ReadProblem}
    public = extract(skill / "community_bindings.py", "PublicKnowledge", environment)
    calls = []

    def runner(command, **kwargs):
        calls.append(command)
        assert command[0] == "node" and Path(command[1]) == plugin_root / "scripts" / "lookup.mjs"
        assert kwargs["timeout"] == 5 and kwargs["shell"] is False and kwargs["stdin"] == subprocess.DEVNULL
        return subprocess.run(command, **kwargs)

    adapter = public(runner=runner)
    assert adapter.entry == plugin_root / "scripts" / "lookup.mjs"
    knowledge = extract(skill / "community_facade.py", "_knowledge", {})
    instance = SimpleNamespace(_catalog=lambda: adapter,
                               result=lambda kind, data, **kwargs: {"kind": kind, "data": data, **kwargs})
    instance._knowledge = lambda text: knowledge(instance, text)
    read = extract(skill / "community_facade.py", "read", {"ReadBudget": object})
    result = read(instance, "knowledge", SimpleNamespace(requests=2), query="玉芬啊玉芬")
    card = result["data"]["terms"][0]
    assert result["kind"] == "knowledge" and result["data"]["available"] is True
    assert card["term"] == "结过婚我也认" and card["matched_keys"] == ["玉芬啊玉芬"]
    assert card["source_url"] == "https://www.bilibili.com/video/BV19iJ86ZEnr"
    assert card["usage_context"] == card["avoid_when"] == card["origin"] == ""
    no_hit = read(instance, "knowledge", SimpleNamespace(requests=2), query="unknown")
    assert no_hit["data"]["available"] is True and no_hit["data"]["terms"] == []
    for text in ["missing_db", "corrupt_db"]:
        failure = read(instance, "knowledge", SimpleNamespace(requests=2), query=text)
        assert failure["data"]["available"] is False and failure["data"]["status"] == "knowledge_unavailable"
        assert failure["errors"][0]["code"] == "knowledge_unavailable"

    rejected = 0
    responses = [(0, "", ""), (1, '{"terms":[]}', "fault"), (0, '{"terms":[]}', "warning"),
                 (0, "{", ""), (0, '{"terms":[],"extra":1}', ""), (0, '{"terms":{}}', ""),
                 (0, json.dumps({"terms": [{**card, "confidence": True}]}), ""),
                 (0, json.dumps({"terms": [{**card, "days_left": 0}]}), ""),
                 (0, json.dumps({"terms": [{**card, "aliases": [1]}]}), ""),
                 (0, json.dumps({"terms": [card, card, card, card]}), "")]
    for code, stdout, stderr in responses:
        invalid = public(runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr))
        try:
            invalid.lookup("fixture")
        except ReadProblem as error:
            assert error.code == "knowledge_unavailable"
            rejected += 1
        else:
            raise AssertionError("Invalid protocol response was accepted")

    def timeout(*args, **_kwargs):
        raise subprocess.TimeoutExpired(args[0], 5)

    try:
        public(runner=timeout).lookup("fixture")
    except ReadProblem as error:
        assert error.code == "knowledge_unavailable"
        rejected += 1
    else:
        raise AssertionError("Timeout was accepted as a no-hit")
    return {"public_knowledge": "success_no_hit_and_faults", "protocol_faults_rejected": rejected, "explicit_cli_calls": len(calls)}


def source_file(root: Path, filename: str) -> Path:
    path = root / filename
    return path if path.is_file() else root / (filename + ".txt")


def function_hashes(path: Path, excluded: set[str]) -> dict[str, str]:
    source = path.read_bytes()
    lines = source.splitlines(keepends=True)
    result: dict[str, str] = {}

    def visit(nodes: list[ast.stmt], prefix: tuple[str, ...] = ()) -> None:
        for node in nodes:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                key = prefix + (node.name,)
                name = ".".join(key)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and name not in excluded:
                    start = min([node.lineno] + [decorator.lineno for decorator in node.decorator_list])
                    body = b"".join(lines[start - 1:node.end_lineno])
                    if name == "PublicKnowledge.lookup":
                        binding = b', "--db", str(self.db_path)'
                        assert body.count(binding) <= 1, "Unexpected repeated public database binding"
                        body = body.replace(binding, b"")
                    result[name] = hashlib.sha256(body).hexdigest()
                visit(node.body, key)

    visit(ast.parse(source, filename=str(path)).body)
    return result


def preservation_probe(original: Path, staged: Path) -> dict[str, Any]:
    excluded = {
        "community_facade.py": {"Community._catalog_detail", "Community._read_detail", "Community.scan"},
        "xhh_tool.py": {"_meme_notes", "read_post", "read_floor"},
        "community_bindings.py": {"PublicKnowledge.__init__"},
    }
    hashes: dict[str, str] = {}
    for filename, names in excluded.items():
        before = function_hashes(source_file(original, filename), names)
        after = function_hashes(staged / filename, names)
        differing = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
        assert not differing, f"Protected functions changed in {filename}: {differing}"
        hashes.update({filename + "/" + key: value for key, value in before.items()})
    unchanged: dict[str, str] = {}
    for filename in ["community_state.py", "community_runtime.py", "community_context.py", "community_admin.py", "meme_backfill_avoid.py"]:
        assert source_file(original, filename).read_bytes() == (staged / filename).read_bytes(), f"Protected file changed: {filename}"
        unchanged[filename] = hashlib.sha256((staged / filename).read_bytes()).hexdigest()
    return {"protected_functions": len(hashes),
            "protected_function_digest": hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
            "unchanged_file_hashes": unchanged}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("skill_dir", type=Path)
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--plugin-root", type=Path)
    args = parser.parse_args()
    result = probe(args.skill_dir)
    if result["ok"]:
        assert probe(args.skill_dir, absent=True)["ok"]
        result["plugin_absent_read"] = "passed"
    if args.plugin_root:
        result.update(knowledge_probe(args.skill_dir, args.plugin_root))
    if args.compare:
        result.update(preservation_probe(args.compare, args.skill_dir))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
