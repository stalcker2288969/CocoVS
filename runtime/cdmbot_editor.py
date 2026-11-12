"""Read cdmbot projects and prepare edits without rewriting YAML comments."""

import json
from pathlib import Path
import sys
import textwrap

import yaml
from cdmbot.config import load_suite
from cdmbot.project import load_project
from yaml.nodes import MappingNode


def read(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError(f"YAML file is too large: {path}")
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return stream.read()


def mapping(node, name):
    if not isinstance(node, MappingNode):
        raise ValueError(f"{name}: expected a mapping")
    return {key.value: (key, value) for key, value in node.value}


def block(path, field, name, value, initial=None):
    original = read(path) if path.exists() else initial
    if original is None:
        raise ValueError(f"File not found: {path}")
    root = yaml.compose(original, Loader=yaml.SafeLoader)
    top = mapping(root, path.name)
    member = top.get(field)
    fragment = {name: value}
    eol = "\r\n" if "\r\n" in original else "\n"

    def dump(data, flow=False):
        return yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=flow).strip("\n")

    if member is None:
        index = root.end_mark.index
        if root.flow_style:
            index -= 1
            insertion = (", " if top else "") + dump({field: fragment}, True)[1:-1]
        else:
            prefix = "" if not index or original[index - 1] in "\r\n" else eol
            insertion = prefix + dump({field: fragment}).replace("\n", eol) + eol
    else:
        key, group = member
        values = mapping(group, field)
        if name in values:
            raise ValueError(f"{field}: {name} already exists")
        if group.start_mark.index < key.end_mark.index:
            raise ValueError(f"{field}: open the YAML file to edit an aliased mapping")
        if group.flow_style:
            index = group.end_mark.index - 1
            prefix = ", " if values and not original[:index].rstrip().endswith(",") else ""
            insertion = prefix + dump(fragment, True)[1:-1]
        else:
            mark = group.start_mark
            index = mark.index - mark.column
            indentation = next(iter(values.values()))[0].start_mark.column
            insertion = textwrap.indent(dump(fragment), " " * indentation).replace("\n", eol) + eol
    updated = original[:index] + insertion + original[index:]
    yaml.safe_load(updated)
    return updated


def discover(path):
    data = yaml.safe_load(read(path))
    if not isinstance(data, dict) or "suites" not in data:
        return None
    suites = []
    for name, (program, suite_file) in load_project(path).suites.items():
        row = {"name": name, "program": str(program), "file": str(suite_file)}
        try:
            suite = load_suite(suite_file)
            suite_text = read(suite_file)
            root = mapping(yaml.compose(suite_text, Loader=yaml.SafeLoader), "suite")
            case_keys = mapping(root["cases"][1], "cases")
            row["cases"] = [
                {"name": case.name, "line": case_keys[case.name][0].start_mark.line,
                 "inputs": list(case.setup.inputs)}
                for case in suite.cases
            ]
            row["sources"] = [str(source) for source in (*suite.sources, suite.harness) if source is not None]
        except Exception as error:
            row["error"] = str(error)
        suites.append(row)
    return suites


def main(operation, path, *args):
    if operation == "discover":
        return discover(path)
    if operation == "suite":
        name, program, suite, architecture, memory_model, *sources = args
        relative = {"program": program, "suite": suite}
        test = {"version": 1, "architecture": architecture, "memory_model": memory_model}
        if sources:
            test["build"] = {"sources": sources}
        test["cases"] = {"smoke": {"run": {"until": "halt"}}}
        return {"manifest": block(path, "suites", name, relative, "version: 1\nsource_roots: [.]\n"),
                "suite": yaml.safe_dump(test, sort_keys=False, allow_unicode=True)}
    if operation == "case":
        return block(path, "cases", args[0], {"run": {"until": "halt"}})
    raise ValueError(f"Unknown editor operation: {operation}")


if __name__ == "__main__":
    try:
        action, file, *arguments = sys.argv[1:]
        print(json.dumps(main(action, Path(file).resolve(), *arguments)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)

