"""Offline contract smoke for Echo's Recipe Book (recipes.json).

Validates the registry WITHOUT booting the MCP server: the #1 latent bug in a
parameterized recipe book is a ?-placeholder / binds mismatch, which only
surfaces at execution. This catches it (plus shape invariants) statically.

Run: python scripts/smoke_recipe_book.py
"""
import json
import sys
from pathlib import Path

RECIPES = Path(r"C:\Users\azrae\Desktop\NX ECHO\nx-echo\echo\mcp\external\recipes.json")

VALID_CATEGORIES = {"echo-data", "agent-assign", "model-pick", "zoe-action", "render"}

pass_n = 0
fail_n = 0


def ok(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  PASS {name}")
    else:
        fail_n += 1
        print(f"  FAIL {name} {('- ' + detail) if detail else ''}")


def count_placeholders(sql: str) -> int:
    # recipes never use string literals containing '?', so a raw count is safe;
    # assert that invariant too.
    return sql.count("?")


def main():
    ok("recipes.json exists", RECIPES.exists())
    if not RECIPES.exists():
        print("ALL FAIL - file missing")
        sys.exit(1)

    book = json.loads(RECIPES.read_text(encoding="utf-8"))
    ok("has version", "version" in book)
    recipes = book.get("recipes", {})
    ok("has recipes", len(recipes) > 0, f"{len(recipes)} found")

    for name, r in recipes.items():
        kind = r.get("kind", "sql")
        argspec = r.get("arg") or {}
        required = bool(argspec.get("required"))

        if kind == "tool":
            ta = r.get("tool_args") or {}
            ok(f"[{name}] tool: has tool name", bool(r.get("tool")))
            ok(f"[{name}] tool: has tool_args dict", isinstance(ta, dict) and len(ta) > 0)
            vals = list(ta.values())
            if required:
                ok(f"[{name}] tool: required arg mapped ($arg)", "$arg" in vals,
                   "arg.required but no $arg in tool_args")
            if "$limit" in vals:
                ok(f"[{name}] tool: has limit_default", "limit_default" in r)
            ok(f"[{name}] tool: no sql key", "sql" not in r)
        else:
            sql = r.get("sql", "")
            binds = r.get("binds", [])
            nq = count_placeholders(sql)
            # core invariant: one ? per bind token
            ok(f"[{name}] ?-count == binds-count", nq == len(binds),
               f"{nq} placeholders vs {len(binds)} binds")
            # no stray '?' inside string literals (would corrupt the count)
            ok(f"[{name}] no '?' inside quoted literal", "'?'" not in sql and "\"?\"" not in sql)
            # bind tokens are known
            unknown = [b for b in binds if b not in ("arg", "limit") and not isinstance(b, (str, int, float))]
            ok(f"[{name}] bind tokens valid", not unknown, str(unknown))
            uses_arg = "arg" in binds
            if required:
                ok(f"[{name}] required arg is bound", uses_arg,
                   "arg.required=true but 'arg' not in binds")
            else:
                ok(f"[{name}] no-arg recipe does not bind arg", not uses_arg,
                   "arg.required=false but 'arg' appears in binds")
            # SELECT-only (defense-in-depth; the executor re-validates anyway)
            head = sql.lstrip().upper()
            ok(f"[{name}] is SELECT/WITH", head.startswith("SELECT") or head.startswith("WITH"))
            for forbidden in ("INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "ATTACH "):
                if forbidden in head:
                    ok(f"[{name}] no {forbidden.strip()}", False)
            # limit hygiene: if 'limit' is bound, limit_default must exist
            if "limit" in binds:
                ok(f"[{name}] has limit_default", "limit_default" in r)

        # shared invariants (all recipes)
        ok(f"[{name}] category valid", r.get("category") in VALID_CATEGORIES,
           str(r.get("category")))
        # every seeded recipe must carry a live proof (the 'verified before making' bar)
        ok(f"[{name}] has validation proof", r.get("validated") is True and "proof" in r)

    print(f"\n{'ALL PASS' if fail_n == 0 else 'FAILURES'} - {pass_n} passed, {fail_n} failed")
    sys.exit(0 if fail_n == 0 else 1)


if __name__ == "__main__":
    main()
