# Issue #1 local checklist

- [ ] **Worktree.** Work from a git worktree off main. Subagents inherit it. Multiple `Agent` calls on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally. Before you commit, merge, or deploy from a worktree, list the live agents and stop every one that holds it, including grandchildren you never launched. A delegate's children do not inherit its brief, so a read-only instruction never reaches them. Confirm each stop, then run `git status` and read the tree you are about to ship.
  skip: The user explicitly requests compilation and tests on main before checking out the named branch. Use the clean existing checkout. No worktree or writing subagent is needed.
- [ ] **Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable.
  One seed-entry change needs one commit. Do not rewrite unrelated history.
- [ ] **PRs.** Run `/deslop` over the diff before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.
  skip: Comment review is inapplicable to a JSON-only data change. Do not change source code or existing comments.
- [ ] **Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.
  skip: The user provides the exact PR title. Preserve it. Use a conventional commit message.
- [ ] **Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what it leaves out, what it could break, and how you proved it works, in under a minute. Write short, simple sentences with few identifiers. Do not write walls of text. The squash commit body is the PR body. If the body would make the squash commit longer than about 40 lines, cut the body.
  skip: The user requests `Closes #1`. Preserve that body and append only the required attribution.
- [ ] **Forge.** Resolve the forge before the first PR operation and keep that choice for create, edit, view, watch, and merge. GitHub CLI (`gh`) is the default. If `command -v origin` succeeds and Origin can resolve the repository, prefer `origin pr ...`. If Origin is absent or cannot resolve the repository, stay on `gh` and record the fallback. Do not require Graphite (`gt`).
  Use gh because the user explicitly requests `gh pr create`.
- [ ] **Built-in PR tool.** When the run provides a built-in PR tool, create, edit, retarget, and mark ready through it, never through a forge CLI. Its own instructions say how. A PR made with the CLI misses what the tool tracks, such as a description later runs can edit. Use the resolved forge for everything the tool does not cover, and for every PR operation when the run has no such tool.
  skip: The user's explicit gh command takes precedence.
- [ ] **Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. Without a built-in PR tool, create a child with `origin pr create --status open --base <parent-branch>` or `gh pr create --base <parent-branch>` according to the resolved forge, and retarget an existing child with `origin pr edit <pr> --base <parent-branch>` or `gh pr edit <pr> --base <parent-branch>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.
  skip: There is only one independent seed-entry PR, targeting main.
- [ ] **Readiness.** Open every PR ready, never as a draft. A built-in PR tool can default to draft, so set `draft: false` on every creation call through it. With Origin, pass `--status open`. With `gh`, omit `--draft`. If a PR still opens as a draft, mark it ready through the PR tool, or run `origin pr ready <number>` or `gh pr ready <number>` according to the resolved forge. Run `origin pr view <number>` or `gh pr view <number>` before you refer to PR status.
  Create a normal PR and verify its live title, body, base, head, and URL.
- [ ] **Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists, per `babysit.md`. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.
  skip: The user requests creation only, not merge, review handling, or CI monitoring.

## Task-specific steps

- [x] Verify main and the clean working tree. Pull main with `git pull --ff-only origin main`.
- [x] Read Issue #1 and current project instructions.
- [x] Read the compile command and determine its output and production-sync behavior.
- [x] Read the current seed file and schema before compilation changes the data.
- [x] Run `npm run compile -- BV19iJ86ZEnr` without `--sync`.
  The primary model returned incomplete JSON. The script's built-in fallback model completed compilation and appended the entry.
- [x] Check that exactly the requested source has a valid normalized seed entry and existing entries are unchanged.
  The direct Node assertion passed. Exactly one entry was added. All four prior entries are unchanged.
- [x] Run `npm test` and require all tests to pass.
  All 31 tests passed. No tests failed or were skipped. `git diff --check` passed.
- [ ] Check out `feat/meme-BV19iJ86ZEnr` after successful compilation and tests.
- [ ] Run deslop. Stage only the intended seed-file change, inspect the staged diff, and commit with the required co-author line.
- [ ] Push the named feature branch. Use `gh pr create` with the exact title and `Closes #1` plus attribution.
- [ ] Read the created PR and verify the clean final working tree. Remove this local checklist.

## Execution checkpoint

The existing compile command is the tool for this data-only change. Inspect its inputs and output first, then run compilation and tests sequentially. Compilation depends on Bilibili and the configured Magpie service. Validate the stored entry directly instead of treating a successful process exit as sufficient evidence. No source change, model migration, production sync, or PR merge is in scope.
