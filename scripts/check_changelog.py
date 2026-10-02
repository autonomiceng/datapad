#!/usr/bin/env python3
"""Validate Towncrier fragments and the documented PR change policy."""

import os
from pathlib import Path
import re
import subprocess
import sys


def git(*args):
  result = subprocess.run(
    ["git", *args], capture_output=True, check=False
  )
  if result.returncode:
    raise ValueError(result.stderr.decode(errors="replace").strip())
  return result.stdout


def comparison():
  if os.environ.get("GITHUB_ACTIONS") == "true":
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event in {"push", "workflow_dispatch"}:
      print(f"{event}: PR delta checks skipped; validating fragment syntax and rendering.")
      return None
    if event != "pull_request":
      raise ValueError(f"Unsupported GitHub Actions event: {event!r}.")
    try:
      parents = git("rev-list", "--parents", "-n", "1", "HEAD").split()
      if len(parents) != 3:
        raise ValueError("HEAD must be a two-parent GitHub test merge commit.")
      base = git("rev-parse", "--verify", "HEAD^1^{commit}").decode().strip()
      git("rev-parse", "--verify", "HEAD^2^{commit}")
    except ValueError as error:
      raise ValueError(
        "PR history unavailable: check out the GitHub test merge commit "
        "with fetch-depth: 2 or greater. " + str(error)
      ) from error
    print(f"pull_request: comparing HEAD with first parent {base}.")
    return [base, "HEAD"]
  try:
    base = git("merge-base", "HEAD", "origin/main").decode().strip()
  except ValueError as error:
    raise ValueError(
      "Local PR base unavailable: fetch origin/main and enough history "
      "to find its merge base with HEAD. " + str(error)
    ) from error
  print(f"Local PR: comparing working tree and index with merge base {base} (origin/main).")
  return [base]


def check():
  delta = comparison()
  fragments = Path("changes")
  if fragments.is_symlink() or not fragments.is_dir():
    raise ValueError("changes must be a regular directory.")
  names = set()
  for path in fragments.iterdir():
    if path.is_symlink() or not path.is_file():
      raise ValueError(f"Expected a regular fragment file: {path}")
    if path.name == "README.md":
      continue
    if not re.fullmatch(r"\+[0-9a-f]{8}\.[a-z]+\.md", path.name):
      raise ValueError(f"Unsupported fragment filename: {path}")
    if not path.read_text(encoding="utf-8").strip():
      raise ValueError(f"Fragment must contain non-whitespace text: {path}")
    names.add(os.fsencode(str(path)))
  subprocess.run(
    [
      "towncrier", "build", "--config", "towncrier.toml", "--draft",
      "--name", "Datapad", "--version", "Unreleased", "--date", "1970-01-01",
    ],
    stdout=subprocess.DEVNULL,
    check=True,
  )
  if delta is not None:
    changed = set(git("diff", "--name-only", "-z", *delta, "--").split(b"\0"))
    local = len(delta) == 1
    if local:
      changed.update(
        git("diff", "--cached", "--name-only", "-z", *delta, "--").split(b"\0")
      )
    if b"CHANGELOG.md" in changed:
      raise ValueError("PRs must add fragments instead of editing generated CHANGELOG.md.")
    added = set(
      git(
        "diff", *(["--cached"] if local else []), "--name-only", "--diff-filter=A",
        "--find-renames", "-z", *delta, "--"
      ).split(b"\0")
    )
    new_fragments = names.intersection(added)
    if not new_fragments:
      raise ValueError("Add and stage a new nonempty fragment with mise run changelog:add.")
    for name in new_fragments:
      revision = ":" if local else "HEAD:"
      if not git("show", revision + os.fsdecode(name)).decode("utf-8").strip():
        raise ValueError("Added fragment must contain non-whitespace text in the index or PR commit.")
  print("Changelog syntax and rendering passed" + ("; PR delta policy passed." if delta else "."))


if __name__ == "__main__":
  try:
    check()
  except (ValueError, OSError, subprocess.CalledProcessError) as error:
    print(f"Changelog check failed: {error}", file=sys.stderr)
    sys.exit(1)
