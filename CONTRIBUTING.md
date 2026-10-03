# Contributing

Contributions are welcome under the [MIT license](LICENSE). Read [AGENTS.md](AGENTS.md) before changing the repository.

## Set up

Tool versions and tasks live in `mise.toml`:

```sh
mise trust
mise install
mise run test
```

Install Docker with Compose for application tests and the local demo. On Linux, `mise run browser:deps` installs Chromium system libraries with administrator privileges; the test task installs the pinned browser.

This verifies application behavior and tooling safeguards. Run the full `mise run pr:check` on a contribution branch after staging its new changelog fragment, or on a checked-out PR branch that already includes one. Clean `main` intentionally fails the local PR fragment requirement.

## Checks and formatting

| Task                                             | Purpose                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `mise run deps:install`                          | Install pinned project tools from the frozen Bun lockfile                 |
| `mise run format -- <files...>`                  | Format explicitly named, intentionally edited files                       |
| `mise run format:check`                          | Check source, documentation and tooling formatting without writing        |
| `mise run check`                                 | Run formatting, application, architecture, contract and specialist checks |
| `mise run test`                                  | Run application behavior and tooling safeguards                           |
| `mise run pr:check`                              | Run all current checks and tests; also used by CI                         |
| `mise run changelog:add -- <category> <summary>` | Create a uniquely named Towncrier fragment                                |
| `mise run changelog:preview`                     | Render draft release notes to stdout without changing files or the index  |
| `mise run changelog:check`                       | Validate fragments, rendering and the applicable change policy            |

Run `pr:check` before opening or updating a PR and after resolving conflicts. Checks leave source files unchanged. The formatting task requires regular filenames, validates all inputs before writing, and rejects directory or glob arguments. Quote filenames; do not expand broad shell globs into the command. Inspect `git diff` after formatting and keep unrelated files unchanged.

Vite+ is pinned in `package.json`, and its Oxfmt formatting policy lives in the root `vite.config.ts`. Formatting tasks resolve the installed project-local CLI and configuration explicitly. Bun's exact `packageManager` version matches its mise pin, and `deps:install` uses `bun install --frozen-lockfile`. Tasks that need Vite+ depend on that install task, so the same setup runs locally and in CI. Use mise tasks rather than global installations, unpinned downloads or editor defaults. Formatter upgrades, configuration changes and broad reformatting belong in a separate reviewed change.

mise owns the task graph and PR gate. Vite+ owns formatting, JavaScript lint, integrated type checking and frontend builds; Bun owns frozen installs, backend execution and backend tests. Playwright exercises the built viewer. Node remains available for tool compatibility. ShellCheck, actionlint, EditorConfig and Towncrier cover distinct checks, and the Python changelog tests stay in the gate. Keep one formatting policy and one definition of each required check when adding application tooling.

Run `mise run test:app` for real PostgreSQL integration cases and the browser journey, `mise run app:check` for lint and type checks, and `mise run build` for the frontend. `check:architecture` enforces module boundaries, including type-only imports; the build check rejects server runtime in the browser bundle. `openapi:check` detects generated-contract drift; use `openapi:generate` for an intentional contract change. Every required check belongs in `pr:check` when its code arrives. Local checks and CI use the same mise gate with the changelog contexts below.

The [billing proof](docs/billing-proof.md) has credential-free checks in `test:billing-proof`, included in the PR gate. Its actual Stripe acceptance uses `billing:proof` with explicit private configuration. Serve only its generated report with `billing:serve`; keep provider evidence and credentials outside Git.

The retained [invoice sandbox](docs/billing-demo.md) has database and webhook checks in `test:app` and provider boundary checks in `test:stripe`. Real hosted-payment acceptance uses `billing:demo` with explicit private sandbox configuration; it is separate from credential-free CI.

Scheduled invoice acceptance uses `mise run test:portal:scheduled -- --config <private-config> --run-dir <private-run-directory>`. It uses real sandbox invoices, local sign-in and a private test clock; it is excluded from credential-free CI. Normal portal startup uses wall time. Preserve the chosen `--time-zone` when reopening that demo database. See [scheduled billing](docs/scheduled-billing.md).

The [customer account demo](docs/accounts-demo.md) uses `portal:demo` and an isolated local inbox. `test:portal` exercises real mailbox sign-in and membership in the PR gate. `test:app` includes PostgreSQL account permissions and an upgrade from the merged billing schema. `openapi:generate` and `openapi:check` cover both the anonymous viewer and authenticated portal contracts. Account work requires reading [its module boundaries and authorization contract](docs/accounts.md).

Before changing import-review modules, schemas or application structure, read [the module architecture and contract guide](docs/import-review.md). Review generated SQL from `mise run db:generate` and apply it explicitly with `mise run db:migrate`. Preserve migrations once released or depended on by real installations. A reviewed change may replace an unmerged baseline used only by disposable synthetic demos, with an explicit demo reset. Disposable demo reset is a separate operation.

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

Review findings identify a concrete defect, a plausible failure and supporting evidence. Reviewers check the accepted scope and contracts; tooling handles formatting and style preferences. Keep private paths, identities and review transcripts out of public artifacts. Follow [the application architecture](docs/import-review.md) and raise missing decisions before changing dependent interfaces or directories.

The independent code review also checks for unused code and exports, duplicate helpers, obsolete compatibility or migration scaffolding, and opportunities to simplify the implementation. Verify module ownership and dependency directions against the architecture. A cleanup finding should name the unnecessary complexity and a concrete simpler alternative; verify its resolution before merge. Do not require speculative abstractions or expand testing without a relevant risk.

For interface changes, reviewers apply the [interface rules](AGENTS.md#interface) to the rendered desktop and narrow layouts. Check that simplifying the page preserves accessible navigation, warnings and access to secondary fields.

Stop testing once the agreed checks pass. Broaden or repeat checks only for a relevant code change, failure or unresolved risk. Avoid coverage quotas, duplicate assertions across layers and tests that merely repeat implementation details. Billing, authorization and data integrity require verification proportionate to their consequences.

## Commit history and release notes

Default to one focused PR and one squash-merged commit. Write the final commit title and body in plain language: who benefits, what they can now do, and any meaningful limits. Review corrections become part of that final change. Describe internal tooling benefits honestly without claiming a new customer feature.

Finish corrections and remove superseded code in that unmerged PR. Do not defer known cleanup to another PR or retain compatibility aliases, extra migrations or obsolete abstractions solely for discarded review iterations. Regenerate an unreleased initial schema when only disposable demo data depends on it, following the explicit reset policy above. Preserve contracts and migration history used by released software or real installations.

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
