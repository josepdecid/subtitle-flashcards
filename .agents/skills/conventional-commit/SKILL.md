---
name: Conventional Commit
description: Create git commits following the Conventional Commits spec, optionally pushing afterwards. Use when the user asks to commit changes or runs /commit.
---

## Workflow

1. Inspect the repository state: `git status --short`, `git diff --cached`, and `git diff`. Also check `git log --oneline -10` to match existing style.
2. If nothing is staged, stage the relevant changes by explicit path (avoid `git add -A` if unrelated or sensitive files are present). Never stage `.env`, secrets, or `.venv`.
3. If the changes contain clearly unrelated concerns, split them into separate commits.
4. Write the message following the format below, then commit with `git commit`.
5. Run `git status` to verify the commit succeeded.
6. Only push if the user passed `--push`: run `git push` (use `git push -u origin <branch>` if no upstream is set). Never force-push.

## Message format

```
<type>(<optional scope>): <description>

<optional body>

<optional footer>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Description: imperative mood, lowercase, no trailing period, max ~72 chars.
- Scope: short noun for the affected area (e.g. `cli`, `server`, `translate`); omit if unclear.
- Body: explain the *why*, wrapped at ~72 chars; omit for trivial changes.
- Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer.

## Rules

- Do not amend, rebase, or rewrite history unless asked.
- Do not skip hooks (`--no-verify`).
- If a hook fails, fix the issue and create a new commit.
- Do not commit when there are no changes; say so instead.
