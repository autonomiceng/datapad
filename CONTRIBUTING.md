# Contributing

Contributions are welcome under the [MIT license](LICENSE). Read [AGENTS.md](AGENTS.md) before changing the repository.

## Set up

Tool versions and tasks live in `mise.toml`:

```sh
mise trust
mise install
mise run pr:check
```

## Checks and formatting

| Task                            | Purpose                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `mise run format -- <files...>` | Format explicitly named, intentionally edited files                          |
| `mise run format:check`         | Check foundation Markdown, YAML and formatting configuration without writing |
| `mise run check`                | Run format, EditorConfig, shell and workflow checks                          |
| `mise run test`                 | Exercise the formatting safeguards using temporary fixtures                  |
| `mise run pr:check`             | Run all current checks and tests; also used by CI                            |

Run `pr:check` before opening or updating a PR and after resolving conflicts. Checks leave source files unchanged. The formatting task requires regular filenames, validates all inputs before writing, and rejects directory or glob arguments. Quote filenames; do not expand broad shell globs into the command. Inspect `git diff` after formatting and keep unrelated files unchanged.

Prettier's version and configuration are pinned. Use the mise task rather than global installations, unpinned `npx` commands or editor defaults. Formatter upgrades, configuration changes and broad reformatting belong in a separate reviewed change. Keep one formatting policy when adding application tooling.

There is no application test suite yet. Add lint, type-check, build and application-test tasks when their code arrives, and wire every required task into `pr:check` in the same change. Expand formatting coverage with new source directories. Do not substitute a successful placeholder for a missing test suite. Keep the local gate and CI identical.

## Deliver a change

1. Propose a small increment with a visible outcome and acceptance criteria. Obtain an independent adversarial plan review, address its findings, and get maintainer approval before implementation. A request to prepare a draft for review authorizes that draft only.
2. Implement the agreed scope. Keep private material outside the public checkout and use synthetic fixtures. Review dependency licenses before adding or copying code.
3. Run `mise run pr:check` and the relevant acceptance tasks, then obtain independent code and spec reviews before submitting a PR. Address findings and report unresolved limitations.
4. Open a focused PR describing the problem, resulting behavior and verification. Application changes include a runnable demo of the exact revision under review. Documentation and repository setup changes use the changed files and tooling checks as their review artifact.
5. Address CodeRabbit feedback when available, explaining findings rejected on technical grounds. Report an unavailable review integration. Rerun affected checks and demonstrate fixes until accepted.
6. Merge after scope, checks, reviews and the relevant demo or document review are approved. Honor explicit instructions to stop before committing, pushing or merging.

Keep plans and review transcripts in private planning storage. Publish only reusable documentation and synthetic evidence. Public CI must run without private credentials or repositories.

Use Conventional Commits, for example `docs: explain local checks`. Keep commit attribution accurate. Preserve third-party licenses and notices where required.

## Commit history and release notes

Default to one focused PR and one squash-merged commit. Write the final commit title and body in plain language: who benefits, what they can now do, and any meaningful limits. Review corrections become part of that final change. Describe internal tooling benefits honestly without claiming a new customer feature.

Keep several commits only when each delivers an independently useful change. Fold corrections into their respective commits with fixup/autosquash before final review, coordinate with anyone using the branch, and rerun `mise run pr:check` afterwards. Preserve merged main and release history.

The selected release-note approach is Towncrier fragments rendered in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Each user-facing change gets a uniquely named fragment explaining its benefit. Only the release process assembles `CHANGELOG.md`; parallel feature branches edit separate fragments. Defects corrected before a feature ships belong in that feature's final description. Fixes to shipped behavior get their own entries.

Release tooling will be added in a separate increment. Until then, include the same benefit-focused summary in the PR and final commit message.
