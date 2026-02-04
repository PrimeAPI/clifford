# Contributing

Thanks for contributing! This repo is a monorepo, so we keep commits and pull requests consistent and easy to scan.

## Commit Message Format (Required)

Each commit must follow this format:

```
<type>(scope): <description>

[optional body]

[optional footer]
```

### Types
Use one of the following:
- `build`
- `chore`
- `ci`
- `docs`
- `feat`
- `fix`
- `perf`
- `refactor`
- `revert`
- `style`
- `test`

Add more types if they make sense for the change.

### Scope (Required)
The scope is **always required** and should be the component name (because this is a monorepo).

Examples:
- `feat(api): add contexts close endpoint`
- `fix(worker): handle memory-write errors`
- `docs(web): update memory UI guide`

If the change touches **two components**, list both, comma-separated:
- `refactor(api,worker): unify memory job payload`

If the change touches **three or more components**, omit the scope to signal a global change:
- `chore: repo-wide formatting`

### Description
Keep it short and clear. Use the body for extra detail if needed (links are welcome).

### Breaking Changes
Use `!` after the scope and describe the break in the body.

Example:
```
feat(db)!: remove auth schema

BREAKING: auth schema removed; run migrations before deploy.
```

### Issue/PR Linking (Preferred)
Always link the issue in the commit message footer with `(#123)` when available.
For squash merges, always include the PR number as `(#123)`.
If no issue/PR number exists, the footer can be omitted.

Example:
```
fix(worker): handle missing memory ops

(#123)
```

## Pull Request Guidelines

- Keep PRs focused and small when possible.
- Update or add tests if behavior changes.
- Include screenshots for UI changes.
- Call out breaking changes clearly in the PR description.
- Make sure your branch is up to date with `main` before requesting review.

## Development Flow

1. Create a branch for your work.
2. Make changes with required commit format.
3. Open a PR with a clear description and linked issues.
4. Address review feedback and update as needed.
