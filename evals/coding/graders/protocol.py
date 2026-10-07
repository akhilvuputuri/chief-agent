"""Trusted, evaluator-owned assertions; never exported to the coding workspace."""

import importlib.util
import sys

spec = importlib.util.spec_from_file_location("candidate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules["candidate"] = module
spec.loader.exec_module(module)
case, group = sys.argv[2:]


def rejects(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError("Expected rejection")


if group == "regression":
    assert module.wire_size({"x": "😀"}) == len('{"x":"😀"}'.encode())
    assert module.text_bound("hello", 5) == "hello"
    rejects(lambda: module.text_bound("hello", 4))
    module.validate_files(
        [
            module.File(path="src/a.py", content="ok"),
            module.File(path="src/b.py", content=None),
        ]
    )
    rejects(
        lambda: module.validate_files(
            [module.File(path=f"f{i}", content="") for i in range(101)]
        )
    )
    for path in ["../secret", ".git/config", ".env", "src/.env.prod"]:
        rejects(lambda: module.validate_path(path))
elif case == "chief-protocol-unicode":
    assert module.utf16_length("A😀𐀀") == 5
    assert module.text_bound("😀", 2) == "😀"
    rejects(lambda: module.text_bound("😀", 1))
    rejects(lambda: module.text_bound("a😀", 2))
    rejects(lambda: module.utf16_length("\ud800"))
else:
    for values in [("a", "b"), ("a", None), (None, None)]:
        rejects(
            lambda: module.validate_files(
                [module.File(path="same.py", content=x) for x in values]
            )
        )
    module.validate_files([module.File(path=f"f{i}", content="") for i in range(100)])

# A candidate calling exit(0) before assertions must not pass.
sys.exit(42)
