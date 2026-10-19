"""Parse source text only. Never import or execute the inspected repository."""
import ast
import json
import sys

payload = json.load(sys.stdin)
try:
    tree = ast.parse(payload["text"], filename=payload["path"])
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    # Python overload stubs and repeated definitions share a name; the final definition is the binding.
    nodes = list({node.name: node for node in nodes}.values())
    names = {node.name for node in nodes}
    symbols = []
    for node in nodes:
        calls = sorted({item.func.id for item in ast.walk(node) if isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id in names and item.func.id != node.name})
        start = min([node.lineno] + [d.lineno for d in node.decorator_list])
        symbols.append({"name": node.name, "startLine": start, "endLine": node.end_lineno, "calls": calls})
    print(json.dumps({"symbols": symbols, "parser": "python-ast/" + sys.version.split()[0]}))
except (SyntaxError, ValueError, RecursionError) as error:
    print(json.dumps({"symbols": [], "error": str(error)}))
