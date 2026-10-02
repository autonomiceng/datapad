"""Exercise changelog tasks against isolated Git repositories and real Towncrier."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]


class ChangelogTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory(prefix="datapad-changelog-test-")
    self.addCleanup(self.temp.cleanup)
    self.repo = Path(self.temp.name) / "repo"
    self.repo.mkdir()
    self.env = os.environ.copy()
    self.env.pop("GITHUB_ACTIONS", None)
    self.env.pop("GITHUB_EVENT_NAME", None)
    for name in ("towncrier.toml", "changes/README.md", "scripts/check_changelog.py"):
      target = self.repo / name
      target.parent.mkdir(parents=True, exist_ok=True)
      shutil.copyfile(SOURCE / name, target)
    self.git("init", "-b", "main")
    self.git("config", "user.name", "Synthetic Contributor")
    self.git("config", "user.email", "contributor@example.invalid")
    self.git("add", ".")
    self.git("commit", "-m", "test: initialize fixture")
    self.git("update-ref", "refs/remotes/origin/main", "HEAD")

  def run_command(self, *args, repo=None, event=None):
    env = self.env.copy()
    if event is not None:
      env.update(GITHUB_ACTIONS="true", GITHUB_EVENT_NAME=event)
    return subprocess.run(
      args, cwd=repo or self.repo, env=env, text=True, capture_output=True, check=False
    )

  def git(self, *args, repo=None):
    result = self.run_command("git", *args, repo=repo)
    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
    return result.stdout.strip()

  def task(self, name, *args, repo=None, event=None):
    return self.run_command(
      "bash", str(SOURCE / ".mise/tasks/changelog" / name), *args, repo=repo, event=event
    )

  def assert_passes(self, result):
    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

  def assert_fails(self, result, message):
    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
    self.assertIn(message, result.stdout + result.stderr)

  def fragment(self, name="+12345678.maintenance.md", text="Contributors can review changes."):
    path = self.repo / "changes" / name
    path.write_text(text + "\n", encoding="utf-8")
    return path

  def snapshot(self):
    return (
      self.git("status", "--porcelain=v1", "-z"),
      (self.repo / ".git/index").read_bytes(),
      {path.name: path.read_bytes() for path in (self.repo / "changes").iterdir()},
      (self.repo / "CHANGELOG.md").exists(),
    )

  def test_unique_creation_and_draft_check_leave_files_and_index_unchanged(self):
    summary = "Contributors can keep literal $(touch unexpected) in summaries."
    self.assert_passes(self.task("add", "maintenance", summary))
    self.assert_passes(self.task("add", "maintenance", "Contributors can preview parallel changes."))
    files = list((self.repo / "changes").glob("+*.maintenance.md"))
    self.assertEqual(len(files), 2)
    self.assertFalse((self.repo / "unexpected").exists())
    self.git("add", "changes")
    before = self.snapshot()
    preview = self.task("preview")
    self.assert_passes(preview)
    self.assertIn("## [Unreleased]", preview.stdout)
    self.assertNotIn("1970-01-01", preview.stdout)
    self.assertIn("### Maintenance", preview.stdout)
    self.assertEqual(preview.stdout.count(summary), 1)
    self.assertEqual(preview.stdout.count("Contributors can preview parallel changes."), 1)
    self.assert_passes(self.task("check"))
    self.assertEqual(self.snapshot(), before)
    self.git("commit", "-m", "test: add notes")
    self.assert_passes(self.task("check"))

  def test_missing_blank_and_unsupported_fragments_are_rejected(self):
    self.assert_fails(self.task("check"), "Add and stage")
    path = self.fragment(text=" \t")
    self.git("add", "changes")
    self.assert_fails(self.task("check"), "non-whitespace")
    path.write_text("Contributors can read an unstaged note.\n", encoding="utf-8")
    self.assert_fails(self.task("check"), "non-whitespace text in the index")
    path.unlink()
    unknown = self.fragment("+12345678.unknown.md")
    self.assert_fails(self.task("check"), "Invalid news fragment name")
    unknown.unlink()
    self.fragment("not-a-supported-name.md")
    self.assert_fails(self.task("check"), "Unsupported fragment filename")
    self.assert_fails(self.task("add", "maintenance", " \t"), "non-whitespace")
    self.assert_fails(self.task("add", "unknown", "A summary."), "Category must")

  def test_changelog_edit_cannot_bypass_a_new_fragment(self):
    changelog = self.repo / "CHANGELOG.md"
    changelog.write_text("# Changelog\n", encoding="utf-8")
    self.git("add", "CHANGELOG.md")
    self.git("commit", "-m", "test: initialize generated changelog")
    self.git("update-ref", "refs/remotes/origin/main", "HEAD")
    self.fragment()
    changelog.write_text("# Changelog\n\nAn edited entry.\n", encoding="utf-8")
    self.git("add", "changes", "CHANGELOG.md")
    self.assert_fails(self.task("check"), "editing generated CHANGELOG.md")
    changelog.write_text("# Changelog\n", encoding="utf-8")
    self.assert_fails(self.task("check"), "editing generated CHANGELOG.md")
    self.git("restore", "--staged", "CHANGELOG.md")
    changelog.write_text("# Changelog\n\nAn unstaged entry.\n", encoding="utf-8")
    self.assert_fails(self.task("check"), "editing generated CHANGELOG.md")

  def test_missing_local_base_reports_fetch_instructions(self):
    self.fragment()
    self.git("add", "changes")
    self.git("update-ref", "-d", "refs/remotes/origin/main")
    self.assert_fails(self.task("check"), "fetch origin/main and enough history")

  def test_pr_merge_accepts_depth_two_and_rejects_missing_merge_history(self):
    self.git("switch", "-c", "feature")
    self.fragment()
    self.git("add", "changes")
    self.git("commit", "-m", "test: add feature note")
    self.git("switch", "main")
    (self.repo / "base.txt").write_text("Synthetic base change.\n", encoding="utf-8")
    self.git("add", "base.txt")
    self.git("commit", "-m", "test: advance base")
    first_parent = self.git("rev-parse", "HEAD")
    self.git("merge", "--no-ff", "feature", "-m", "test: create PR merge")
    depth_two = Path(self.temp.name) / "depth-two"
    self.git("clone", "--depth", "2", self.repo.as_uri(), str(depth_two))
    result = self.task("check", repo=depth_two, event="pull_request")
    self.assert_passes(result)
    self.assertIn(first_parent, result.stdout)
    depth_one = Path(self.temp.name) / "depth-one"
    self.git("clone", "--depth", "1", self.repo.as_uri(), str(depth_one))
    self.assert_fails(
      self.task("check", repo=depth_one, event="pull_request"), "fetch-depth: 2"
    )
    self.git("switch", "feature")
    self.assert_fails(self.task("check", event="pull_request"), "two-parent")

  def test_push_and_manual_skip_delta_while_unsupported_events_fail(self):
    push = self.task("check", event="push")
    self.assert_passes(push)
    self.assertIn("PR delta checks skipped", push.stdout)
    manual = self.task("check", event="workflow_dispatch")
    self.assert_passes(manual)
    self.assertIn("PR delta checks skipped", manual.stdout)
    self.assert_fails(self.task("check", event="pull_request_target"), "Unsupported")
    self.assert_fails(self.task("check", event=""), "Unsupported")

  def test_existing_modified_or_renamed_and_untracked_fragments_do_not_satisfy_gate(self):
    original = self.fragment()
    self.git("add", "changes")
    self.git("commit", "-m", "test: add old note")
    self.git("update-ref", "refs/remotes/origin/main", "HEAD")
    original.write_text("Contributors can read an edited old note.\n", encoding="utf-8")
    self.assert_fails(self.task("check"), "Add and stage")
    self.git("restore", "changes")
    self.git("mv", "changes/+12345678.maintenance.md", "changes/+87654321.maintenance.md")
    self.assert_fails(self.task("check"), "Add and stage")
    self.fragment("+abcdef12.added.md", "Customers can see a synthetic new feature.")
    self.assert_fails(self.task("check"), "Add and stage")

  def test_symlink_fragments_and_nonregular_entries_are_rejected(self):
    outside = self.repo / "synthetic.txt"
    outside.write_text("Synthetic content.\n", encoding="utf-8")
    path = self.repo / "changes/+12345678.maintenance.md"
    path.symlink_to(outside)
    self.git("add", "changes")
    self.assert_fails(self.task("check"), "regular fragment file")
    path.unlink()
    path.mkdir()
    self.assert_fails(self.task("check"), "regular fragment file")
    path.rmdir()
    directory = self.repo / "changes"
    directory.rename(self.repo / "saved-changes")
    directory.symlink_to(self.repo / "saved-changes", target_is_directory=True)
    self.assert_fails(self.task("check"), "regular directory")


if __name__ == "__main__":
  unittest.main()
