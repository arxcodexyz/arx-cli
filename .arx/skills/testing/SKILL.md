---
name: testing
description: Testing strategies and patterns for reliable code
version: 1.0.0
prompts:
  - "Write tests BEFORE implementation code (TDD: red-green-refactor)."
  - "Every test should test ONE behavior. Use descriptive test names that explain the expected behavior."
  - "For edge cases: test empty/null inputs, boundary values, error conditions, and happy paths."
---

# Testing Strategies

## Test Structure (AAA)
1. **Arrange** — Set up the test data and environment
2. **Act** — Execute the function/component being tested
3. **Assert** — Verify the result matches expectations

## What to Test
- **Happy path**: Normal inputs produce expected outputs
- **Edge cases**: Empty strings, null values, zero, negative numbers, max values
- **Error cases**: Invalid inputs produce appropriate errors
- **Boundary conditions**: Values at the edge of valid ranges

## Naming Convention
```
describe("ComponentName")
  it("should behave_expectedly when condition")
  it("should throw error when invalid_input")
```

## Coverage Goals
- New code: 80%+ coverage for logic, 100% for critical paths
- Integration tests for API endpoints and database operations
- Unit tests for utility functions and business logic
