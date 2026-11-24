"""Reject retired MCP names in current onboarding and host-acceptance docs."""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = "docs/kernel-v3/02-commands-and-tools.md"
GUIDES = (
    "README.md",
    "workbench/README.md",
    "workbench/docs/QUICKSTART.md",
    "workbench/docs/HOST_ACCEPTANCE.md",
)
TABLE_HEADING = "## 4. 旧工具 → 新工具"
ROW = re.compile(r"^\| `([a-z][a-z0-9_]*)` \| (.*) \|$", re.MULTILINE)


def retired_tools():
    contract = (ROOT / CONTRACT).read_text(encoding="utf-8")
    _, heading, after_heading = contract.partition(TABLE_HEADING + "\n")
    section = after_heading.split("\n## ", 1)[0]
    rows = ROW.findall(section)
    if not heading or not rows:
        raise ValueError(f"{CONTRACT}: 找不到工具迁移表")
    return {
        old: replacement
        for old, replacement in rows
        if f"`{old}`" not in replacement
    }


def main():
    try:
        retired = retired_tools()
        if not retired:
            raise ValueError(f"{CONTRACT}: 工具迁移表没有退役条目")
        # Chinese prose may touch a tool name without an ASCII word boundary.
        token = re.compile(
            r"(?<![A-Za-z0-9_])("
            + "|".join(map(re.escape, sorted(retired)))
            + r")(?![A-Za-z0-9_])"
        )
        problems = []
        for path in GUIDES:
            lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
            for number, line in enumerate(lines, 1):
                for name in dict.fromkeys(token.findall(line)):
                    problems.append(
                        f"{path}:{number}: 已退役工具 {name}；{retired[name]}"
                    )
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"通过：{len(GUIDES)} 份现行操作指南未引用已退役的 MCP 工具。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
