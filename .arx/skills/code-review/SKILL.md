---
name: code-review
description: Best practices and tools for code review
version: 1.0.0
prompts:
  - "When reviewing code, follow these dimensions: correctness (does it meet spec?), readability (is it clear?), maintainability (can someone else fix it?), security (any vulnerabilities?), and performance (is it efficient?)."
  - "Use replace_in_file for targeted fixes. Prefer small, focused changes over large rewrites."
  - "Always verify your fixes: run the build, check TypeScript, then run tests."
---

# Code Review Best Practices

## Review Checklist
- [ ] Correctness: Does the code do what it's supposed to?
- [ ] Edge cases: What happens with empty/null/unexpected input?
- [ ] Error handling: Are errors caught and reported clearly?
- [ ] Security: No hardcoded secrets, SQL injection, XSS, or path traversal.
- [ ] Performance: No N+1 queries, no unnecessary allocations in hot paths.
- [ ] Readability: Clear variable names, appropriate comments, no dead code.
- [ ] Tests: Adequate coverage for the change.
- [ ] Consistency: Matches the project's existing style and conventions.
