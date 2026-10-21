# Refactor Candidates

## Protocol

Use this sequence while the focused tests are green:

1. Establish the green baseline for the current slice.
2. Inspect the production and test diff for one candidate below.
3. Make the smallest behavior-preserving change.
4. Run the focused tests.
5. Keep the change only if the tests stay green and the code or test contract is clearer.
6. Repeat until no useful candidate remains, then record `REFACTOR: <change and benefit>` or `REFACTOR: no justified change; <reason>` in the active issue progress or completion report.

Do not add behavior, change a public contract, or repair a failing test during this step. Those changes start a new red-green cycle. Do not refactor production code and delete tests in the same unverified edit; validate each kind of change separately.

After a TDD cycle, look for:

- Duplication: extract a function or a class.
- Long methods: break them into private helpers. Keep the tests on the public interface.
- Shallow modules: combine them or add depth.
- Feature envy: move the logic to where the data lives.
- Primitive obsession: introduce value objects.
- Existing code that the new work shows is a problem.

After the code refactor, look for test-contract surplus:

- Two tests that cannot fail independently.
- Near-duplicate tests that pin the same public API with a small fixture change.
- Driving tests that remain after a keeper already covers the behavior.
- Table cases that belong in one test instead of many tests.

If test A cannot fail unless test B also fails, delete test A. Do not keep a driving test as history. Git already keeps that history.