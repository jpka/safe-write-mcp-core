# AGENTS.md

safe-write-mcp-core: the reusable two-phase write safety layer for MCP servers — preview-then-execute plan tokens, out-of-band localhost approval, and audit hooks. Zero runtime dependencies; hosts supply `preview()`/`execute()` callbacks and audit persistence.

## Working conventions

- Tickets live in GitHub Issues (see the [build map](https://github.com/jpka/safe-write-mcp-core/issues/1)); claim one with `gh issue edit <n> --add-assignee @me` before starting.
- **PR-first:** any ticket that involves file edits is developed on a branch and merged via a GitHub PR — never push to main directly. Open the PR with `gh pr create`, then babysit it: watch CI, address failures, re-run until green, then `gh pr merge --squash`.
- Put `Closes #n` in the PR body so the ticket closes on merge; then post a resolution comment summarizing what was delivered and verified.
- Verify before opening a PR: `npm run lint` (tsc --noEmit) and `npm test` (vitest) locally — CI runs the same on Node 24.
- Audit sink contract: record() never throws; failures go to stderr.
