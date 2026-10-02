# Release-note fragments

Every PR adds a nonempty fragment describing its benefit. Use synthetic examples and keep private material outside this directory. Meaningful summaries are checked in review.

```sh
mise run changelog:add -- maintenance "Contributors can preview release notes before review."
git add -- "changes/+<generated-id>.maintenance.md"
mise run changelog:preview
mise run changelog:check
```

Replace the staging example with the exact filename printed by `changelog:add`. Choose `added`, `changed`, `fixed`, `removed`, `security` or `maintenance`. Maintenance entries describe contributor and internal improvements and appear under their own heading. Towncrier generates a unique `+<eight-hex-digits>.<category>.md` filename. Supply the summary as one quoted argument; shell-like text in it is treated as content.

The preview uses Keep a Changelog Markdown with the fixed draft name `Datapad` and version `Unreleased`. A fixed internal date makes rendering reproducible; the draft heading makes no release-date claim. Rendering writes only to stdout and leaves the worktree, index and fragments unchanged. Release assembly is outside these tasks; ordinary PRs cannot edit generated `CHANGELOG.md`.

The check validates regular fragment files, supported names, nonempty text and Towncrier's strict rendering. Locally, it reports the merge base of `HEAD` and `origin/main`, then compares that base with both the index and working tree. A new fragment must be added in the index or a commit and contain nonempty text both in the index and on disk. Tracked edits to `CHANGELOG.md` in either the index or worktree fail. An untracked fragment can appear in previews but cannot satisfy the PR gate. Stage the fragment before running the local gate. A missing base fails with instructions to fetch it.

In GitHub Actions, `GITHUB_ACTIONS=true` and `GITHUB_EVENT_NAME=pull_request` require `HEAD` to be the two-parent test merge commit with both parents available. The comparison uses its first parent, with checkout `fetch-depth: 2` or greater. `push` and `workflow_dispatch` validate syntax and rendering and explicitly skip PR delta checks. Other GitHub Actions events fail until their comparison policy is defined.
