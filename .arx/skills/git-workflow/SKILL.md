---
name: git-workflow
description: Conventional git workflow practices
version: 1.0.0
prompts:
  - "Use conventional commits: feat (feature), fix (bug fix), refactor (restructure), docs (documentation), test (testing), chore (tooling), ci (CI/CD). Format: type(scope): short description."
  - "Before pushing: verify build passes, lint is clean, and tests pass locally."
  - "Commit messages: short title (<72 chars), blank line, bullet points for details. Use imperative mood ('add' not 'added')."
---

# Git Workflow

## Branch Naming
- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code restructuring  
- `docs/description` — documentation
- `ci/description` — CI/CD changes
- `chore/description` — maintenance, tooling

## Commit Message Format
```
type(scope): short imperative description (<72 chars)

- Longer explanation if needed (wrap at 72 chars)
- Bullet points for key changes
- Closes #issue_number if applicable
```

## Before Push Checklist
1. `npx tsc --noEmit` — TypeScript check
2. `npm run lint` or biome check
3. `npm test` or `npm run test`
4. `git diff --stat` — review files changed
