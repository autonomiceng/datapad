# Datapad

A highly configurable open-source customer support and billing portal for service providers.

Read [README.md](README.md) for scope and [CONTRIBUTING.md](CONTRIBUTING.md) before preparing changes for review. Check `mise.toml` for the available tools and tasks.

## Ways to hurt yourself

1. **Publishing private material.** Every push to this repository is public. Keep business-specific code, configuration, branding and migration mappings in a separate private repository. Keep credentials and production records outside Git. Use synthetic data in tests, screenshots, demos and CI. Private filesystem paths and personal details also stay out of public files.
2. **Importing code without provenance.** Check ownership and license compatibility before extracting prototype or third-party code. Preserve required notices; our MIT license applies to our original work.
3. **Touching live systems from development.** Use isolated local fixtures and provider sandboxes. Imports stage observations; billing, provisioning and production cutovers need their own approved scope.
4. **Stopping another task's process.** Stop only processes whose identity and ownership you verified. Capture process IDs when starting servers and confirm the working directory before stopping them; avoid pattern-based kills on shared hosts.

## Communication

Short, direct, precise language. State the result, then the evidence. Avoid em dashes and "not X, but Y" phrasing. When a decision is needed, give a few options with consequences and a recommendation. Ask about missing intent; explain technical disagreements briefly.

## Commits

Use Conventional Commits: `<type>(scope): <description>`. Describe the change's benefit. Attribute contributions accurately and follow the task's approval boundary before committing or publishing.

## Documentation and scratch

Keep durable documentation with the behavior it explains. Add an ADR for a consequential tradeoff that would otherwise surprise a future maintainer. Plans, research notes and review transcripts stay in private planning storage; synthetic agent scratch can use ignored directories. Update documentation when behavior or meaning changes.

## Delegation

Use the task's requested models and review process. Give parallel agents separate worktrees or explicit file ownership. One integrator owns shared manifests, migrations, CI and final integration. Independent code and spec reviews precede PR submission; the implementation author does not replace either review. Read the delivery sequence in [CONTRIBUTING.md](CONTRIBUTING.md).

## Taste

- Check maintained open-source libraries before building infrastructure.
- Implement the smallest complete vertical slice. Add abstractions when concrete uses justify them.
- Keep domain rules separate from provider adapters and transport code.
- Make dates, money, identity and tenant boundaries explicit.
- Test observable behavior and plausible failures. Use real database integration tests when persistence matters.
- Keep public tooling independent of private repositories and local machine configuration.

## Finish

Run `mise run pr:check` before opening or updating a PR. Put every required formatter, linter, type check, test and build behind a mise task and include it in that gate when its code arrives. Use `mise run format -- <files...>` only for files intentionally changed; inspect the diff afterwards. Formatter upgrades and broad reformatting need a separate reviewed change. Report exact commands, results and material gaps. Demonstrate application behavior from the reviewed revision and repeat the demo after feedback. A skipped or failed check remains visible. Follow explicit user instructions when they change the workflow.
