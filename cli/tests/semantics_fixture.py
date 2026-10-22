"""An isolated source checkout for CLI protocol tests."""

IDENTITY = {"id": "test", "commit": "a" * 12}


def seed(root):
    source = root / "semantics/test" / IDENTITY["commit"]
    source.mkdir(parents=True)
    files = {
        "semantics.k": 'requires "lib/core.k"\nmodule LANG imports CORE endmodule\n',
        "lib/core.k": "module CORE endmodule\n",
    }
    for name, text in files.items():
        data = text.encode()
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return source
