# Contributing

Contributions are welcome under the [MIT license](LICENSE). Read [AGENTS.md](AGENTS.md) before changing the repository.

## Set up

Tool versions and tasks live in `mise.toml`:

```sh
mise trust
mise install
mise run test
```

This verifies the tool setup. Run the full `mise run pr:check` on a contribution branch after staging its new changelog fragment, or on a checked-out PR branch that already includes one. Clean `main` intentionally fails the local PR fragment requirement.

## Checks and formatting

| Task                                             | Purpose                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `mise run deps:install`                          | Install pinned project tools from the frozen Bun lockfile                       |
| `mise run format -- <files...>`                  | Format explicitly named, intentionally edited files                             |
| `mise run format:check`                          | Check foundation Markdown, YAML, JSON and tooling configuration without writing |
| `mise run check`                                 | Run format, EditorConfig, shell, workflow and changelog checks                  |
| `mise run test`                                  | Exercise tooling safeguards using temporary fixtures                            |
| `mise run pr:check`                              | Run all current checks and tests; also used by CI                               |
| `mise run changelog:add -- <category> <summary>` | Create a uniquely named Towncrier fragment                                      |
| `mise run changelog:preview`                     | Render draft release notes to stdout without changing files or the index        |
| `mise run changelog:check`                       | Validate fragments, rendering and the applicable change policy                  |

Run `pr:check` before opening or updating a PR and after resolving conflicts. Checks leave source files unchanged. The formatting task requires regular filenames, validates all inputs before writing, and rejects directory or glob arguments. Quote filenames; do not expand broad shell globs into the command. Inspect `git diff` after formatting and keep unrelated files unchanged.

Vite+ is pinned in `package.json`, and its Oxfmt formatting policy lives in the root `vite.config.ts`. Formatting tasks resolve the installed project-local CLI and configuration explicitly. Bun's exact `packageManager` version matches its mise pin, and `deps:install` uses `bun install --frozen-lockfile`. Tasks that need Vite+ depend on that install task, so the same setup runs locally and in CI. Use mise tasks rather than global installations, unpinned downloads or editor defaults. Formatter upgrades, configuration changes and broad reformatting belong in a separate reviewed change.

mise owns the task graph and PR gate. Vite+ owns formatting and will supply JavaScript lint, frontend tests and builds as application code arrives; Bun owns dependency installs and future backend execution and tests. Node remains available for tool compatibility. ShellCheck, actionlint, EditorConfig and Towncrier cover distinct checks, and the Python changelog tests stay in the gate. Keep one formatting policy and one definition of each required check when adding application tooling.

There is no application test suite yet. Add lint, type-check, build and application-test tasks when their code arrives, and wire every required task into `pr:check` in the same change. Expand formatting coverage with new source directories. Do not substitute a successful placeholder for a missing test suite. Local checks and CI use the same mise gate with the changelog contexts described below.

## Deliver a change

1. Propose a small increment with a visible outcome and acceptance criteria. Obtain an independent adversarial plan review, address its findings, and get maintainer approval before implementation. A request to prepare a draft for review authorizes that draft only.
2. Implement the agreed scope using the brief below. Keep private material outside the public checkout and use synthetic fixtures. Review dependency licenses before adding or copying code.
3. Run `mise run pr:check` and the relevant acceptance tasks, then obtain independent code and spec reviews before submitting a PR. Address findings and report unresolved limitations.
4. Open a focused PR describing the problem, resulting behavior, changelog fragment and verification. Include the release-note preview from the reviewed revision. Application changes include a runnable synthetic-data demo of that revision. Documentation and repository setup changes use the changed files and tooling checks as their review artifact.
5. Address CodeRabbit feedback when available, explaining findings rejected on technical grounds. Report an unavailable review integration. Rerun affected checks and demonstrate fixes until accepted.
6. Merge after required CI checks pass and the owner approves the reviews and exact-revision demo or document/preview review. Use `gh pr merge --squash --match-head-commit <reviewed-head> --subject '<benefit-focused title>' --body-file <message-file>` with an explicitly written final message. Keep automatic merging and administrative bypasses disabled. Honor explicit instructions to stop before committing, pushing or merging.

Keep plans and review transcripts in private planning storage. Publish only reusable documentation and synthetic evidence. Public CI must run without private credentials or repositories.

Use Conventional Commits, for example `docs: explain local checks`. Keep commit attribution accurate. Preserve third-party licenses and notices where required.

## Implementation and review brief

The integrator supplies this brief before delegating work:

- Approved outcome, acceptance cases and exclusions.
- Reviewed architecture/module contracts and applicable instruction-file pointers.
- Missing architecture decisions raised for resolution before dependent implementation.
- Owned files, worktree and exact base commit SHA; the integrator owns shared manifests, migrations and CI.
- Required mise tasks, acceptance cases tied to plausible failures, and expected verification evidence.
- Requested model routing and independent code/spec reviewers, kept in private instructions.
- Delivery boundary: draft, commit, push, PR or merge, and the required owner approval.
- Final report: changed behavior, exact check commands/results, demo or document artifact, and material risks.

Review findings identify a concrete defect, a plausible failure and supporting evidence. Reviewers check the accepted scope and contracts; tooling handles formatting and style preferences. Keep private paths, identities and review transcripts out of public artifacts. Establish application directories through the reviewed architecture plan when application work begins.

Stop testing once the agreed checks pass. Broaden or repeat checks only for a relevant code change, failure or unresolved risk. Avoid coverage quotas, duplicate assertions across layers and tests that merely repeat implementation details. Billing, authorization and data integrity require verification proportionate to their consequences.

## Commit history and release notes

Default to one focused PR and one squash-merged commit. Write the final commit title and body in plain language: who benefits, what they can now do, and any meaningful limits. Review corrections become part of that final change. Describe internal tooling benefits honestly without claiming a new customer feature.

Keep several commits only when each delivers an independently useful change. Fold corrections into their respective commits with fixup/autosquash before final review, coordinate with anyone using the branch, and rerun `mise run pr:check` afterwards. Preserve merged main and release history.

Towncrier renders fragments in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Every PR adds a new nonblank fragment explaining its benefit. Categories are `added`, `changed`, `fixed`, `removed`, `security` and `maintenance`. Maintenance appears separately for contributor and internal improvements; describe those benefits honestly. For example:

```sh
mise run changelog:add -- maintenance "Contributors can preview release notes before review."
git add changes/<generated-fragment>.maintenance.md
mise run pr:check
mise run changelog:preview
```

Use the filename printed by `changelog:add`; see [the fragment contract](changes/README.md). Parallel branches create separate fragments. The preview is a draft, makes no new version claim, and leaves files and the index unchanged. Meaningful summaries remain a reviewer judgment. Unknown fragment files, invalid categories and blank summaries fail validation. Feature PRs cannot edit generated `CHANGELOG.md` to bypass the fragment requirement. Defects corrected before a feature ships belong in that feature's final description; fixes to shipped behavior get their own entries. Include the same benefit-focused summary in the PR and final commit message.

Locally, `changelog:check` reports the merge base of `HEAD` and `origin/main`, then checks both index and working-tree differences from that base. A new fragment must be added in the index or a commit and contain nonblank text in both the index and on disk. Tracked edits to `CHANGELOG.md` in either the index or working tree fail. Untracked fragments can appear in the preview but cannot satisfy the new-fragment requirement. Stage the fragment before running the local gate. A missing remote ref or merge base fails with an actionable message; fetch `origin/main` before checking a branch.

In GitHub Actions, `GITHUB_ACTIONS=true` and `GITHUB_EVENT_NAME=pull_request` select PR checks against the test merge commit's first parent. Both parents must be available; the workflow fetches the required history. Missing merge context fails. `push` and `workflow_dispatch` runs validate syntax and rendering and explicitly skip PR delta checks; unsupported events fail. All contexts use `mise run pr:check`, and CI includes the preview in its job summary.

This tooling creates, validates and previews fragments. Release assembly, version bumps, tags and publishing are deferred to a separate increment.
