#!/usr/bin/env python3
"""Copy this Mac's arm64 Node runtime and its Homebrew dylibs into the .app."""
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

app = Path(sys.argv[1]).resolve()
node = Path(sys.argv[2]).resolve()
frameworks = app / "Contents" / "Frameworks"
frameworks.mkdir(parents=True, exist_ok=True)
target = app / "Contents" / "MacOS" / "SherryNode"
shutil.copy2(node, target)
target.chmod(0o755)

def dependencies(path):
    lines = subprocess.check_output(["otool", "-L", str(path)], text=True).splitlines()[1:]
    return [line.strip().split(" (")[0] for line in lines]

def resolve_dependency(source, dependency):
    if dependency.startswith(("/usr/lib/", "/System/Library/")):
        return None
    if dependency.startswith("/opt/homebrew/"):
        return Path(dependency).resolve()
    if dependency.startswith("@loader_path/"):
        return (source.parent / dependency.removeprefix("@loader_path/")).resolve()
    if dependency.startswith("@rpath/"):
        name = dependency.removeprefix("@rpath/")
        candidates = [source.parent / name, source.parent.parent / "lib" / name,
                      Path("/opt/homebrew/opt/node/lib") / name]
        candidates += [Path(path) for path in glob.glob(f"/opt/homebrew/opt/*/lib/{name}")]
        for candidate in candidates:
            if candidate.exists():
                return candidate.resolve()
    raise RuntimeError(f"Cannot bundle dependency {dependency} from {source}")

queue = [(node, target)]
copied = {target.name: node}
for source, destination in queue:
    changes = []
    for dependency in dependencies(source):
        resolved = resolve_dependency(source, dependency)
        if resolved is None:
            continue
        name = resolved.name
        if name in copied and copied[name] != resolved:
            raise RuntimeError(f"Conflicting dylib name: {name}")
        if name not in copied:
            copied[name] = resolved
            output = frameworks / name
            shutil.copy2(resolved, output)
            output.chmod(0o755)
            queue.append((resolved, output))
        new_path = f"@loader_path/{'../Frameworks/' if destination == target else ''}{name}"
        changes += ["-change", dependency, new_path]
    if destination != target:
        changes += ["-id", f"@loader_path/{destination.name}"]
    if changes:
        subprocess.run(["install_name_tool", *changes, str(destination)], check=True)
print(f"Bundled Node and {len(copied) - 1} runtime libraries.")
