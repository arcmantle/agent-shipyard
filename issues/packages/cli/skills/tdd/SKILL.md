---
name: tdd
description: Test-driven development with a red-green-refactor loop, anchored to the active agent-issues issue. After green, prune duplicate driving tests and keep one public-interface contract per behavior.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Test-Driven Development

## Philosophy

Test observable behavior through public interfaces. Prefer integration-style tests that survive internal refactors.

See [tests.md](tests.md) for examples. See [mocking.md](mocking.md) for mocking rules.

Keep one public-interface test per observable behavior. A driving test is a tool that makes the missing behavior exist. A keeper test is a contract that must stay after the issue is done. Do not keep a driving test only because it completed a red-green cycle. Git already keeps that history.

If test A cannot fail unless test B also fails, delete test A. Merge near-duplicate tests into one table-driven test when the cases pin the same API. Do not use coverage percentage as the prune signal. Coverage does not tell you that two tests pin the same behavior. Do not add an absence test for a deleted driving test.

## Removed behavior

When an issue removes a feature, constraint, or compatibility path, remove or update its obsolete tests. Do not add a new test whose only purpose is to confirm that deleted code or an obsolete restriction has not returned. That test has no current behavior contract and adds maintenance cost. Test a replacement or newly supported observable behavior when the change creates one. Add an absence test only when the active issue or a relevant ADR makes the absence an explicit, observable requirement.

## Static declarations

Do not add a test that reads a static declaration and restates its literal shape or values. Examples include object trees, route tables, dependency lists, manifests, schema entries, and constant maps. Such a test duplicates the implementation and fails on an intentional edit without protecting caller behavior.

For a static declaration change, test the behavior that consumes the declaration through its public interface. If no distinct behavior can fail, do not force a red-green cycle. Use the existing behavioral suite, type-check, lint, build, or focused inspection as validation instead. Test the declaration directly only when its serialized shape is itself a supported external contract.

## Reuse an existing red

Before you write a new test, run the current suite against the missing behavior. If an existing public-interface test already fails for the correct reason, that failure is the red. Write the minimum code. Do not add a second test for the same path.

## Anti-pattern: horizontal slices

Use vertical tracer bullets. Do not write all the tests first and all the implementation second. Do not write a full keeper suite first and then implement. A keeper set is the result of the test-contract refactor after green, not a substitute for the red-green loop.

## Workflow

### 1. Planning

Run the **Entity Read** recipe, the **Relation Query** recipe, and the **Context Read** recipe for the active issue and its scope. Read every linked `planEntries` item returned by the issue; its current body can contain implementation decisions and constraints. Confirm the public interface, the priority behaviors, and the approach. Resolve any hard-to-reverse question before you code. See [deep modules](deep-modules.md) and [interface design](interface-design.md) when these concerns matter.

Treat the issue's `planEntries` as planning inputs. Do not create or change Plan-entry links. Report missing Plan-entry provenance to the issue creator.

List the observable behaviors that the issue requires. That list is the test map for the later test-contract refactor.

### 2. Tracer bullet

Write one test that confirms one thing about the system, unless an existing public-interface test is already red for that behavior.

```
RED:   Write test for first behavior, or reuse the existing failing test -> test fails
GREEN: Write minimal code to pass -> test passes
```

Confirm the test fails for the expected reason before you write the implementation.

### 3. Incremental loop

For each remaining behavior:

```
RED:   Write next test, or reuse the existing failing test -> fails
GREEN: Minimal code to pass -> passes
REFACTOR CHECKPOINT: Use the [refactoring guidance](refactoring.md) to inspect and improve the slice if useful, then rerun focused tests -> passes
```

Run one failing test at a time. Write only enough code to pass it. Then move to the next behavior. Do not add a new test when the current suite already fails for the correct reason.

### 4. Refactor workflow

Refactoring occurs at two points: after each green slice during the loop, and as a mandatory final gate before review. Refactoring is required work, even when the result is that no change is needed. After every green slice, pause before the next red and use the [refactoring guidance](refactoring.md). Inspect the changed production code and tests for one small, behavior-preserving improvement. Record either the improvement or why no refactor is justified.

Do not combine a refactor with a behavior change. If the code needs a new test to define behavior, return to `RED`. If a refactor is useful, make one small change at a time and run the focused tests after each change. Stop when the next change would add risk without improving clarity, duplication, ownership, or test-contract quality.

After all required behaviors are green, complete both final passes before review:

- **Code refactor:** Remove duplication in production code. Keep the tests on the public interface.
- **Test-contract refactor:** Map each new test to one behavior from the planning list. Remove a test if another public-interface test already fails for the same reason. Merge near-duplicate tests that pin the same API. Keep the smallest set that still pins the issue contract.

Run the focused tests after every production-code refactor and after every test-contract change. Do not mark this gate complete until the final focused suite is green, every test maps to a required behavior, and the refactor result has been recorded in the active issue progress or completion report. Do not keep a driving test as history.

Use one line for each checkpoint: `REFACTOR: <change and benefit>` or `REFACTOR: no justified change; <reason>`. Do not add a code comment only to satisfy this record.

### 5. Implementation review gate

You, the visible `tdd` agent, own the TDD cycles, the focused validation, and any repairs. Do not hand the build to a subagent: you hold the context on what the active Agent Issues skills expect, and a subagent does not have it. Do not treat the first passing test as the end of the work.

After the test-contract refactor and the focused validation pass, start one read-only review subagent. This is the only step that runs as a subagent. Give the reviewer the active issue context, the changed-file diff, the validation you already ran, the test map, and the shared [language standard](../agent-issues-language.md). The reviewer's report, its findings, and every message it writes must follow that standard.

The reviewer must cover all of these:

- **Behavior and contract:** Compare the implementation and tests against the active issue, the linked user stories, the relevant ADRs, and the observable public behavior. Find missing behaviors, wrong semantics, and gaps in behavior coverage.
- **Test surplus:** Find duplicate assertions on the same public API, tests that restate the same code path with a small fixture change, tests that exist only to complete a red-green cycle, and tests that pin internals or a static shape. A surplus finding has the same weight as a missing-behavior finding. The reviewer must report surplus explicitly, including `no surplus` when none remains.
- **Code and regression risk:** Inspect the changed code for correctness defects, unplanned scope, regressions, gaps in error handling, maintainability concerns, and gaps in validation.

The reviewer must not edit files. It must return either no findings, or structured findings with a severity, a file and location, evidence, and a concrete fix.

`tdd` rejects a finding only when it can explain why the finding is invalid or out of scope. Do not reject a surplus finding only because the test helped the red-green loop. For every valid, material finding, fix it yourself. Then run the focused validation that covers the fix. Do not hand repairs to a subagent. If there are no material findings, `tdd` records the reviewer report before the final validation. Do not mark the issue done until this gate is complete and the test map has no subsumed tests.

### 6. Complete and report

After the review gate and the final focused validation pass, mark the active issue `done`. Start the `next-work` skill with the active initiative. Include its result in the completion report. Do not start the selected issue.

## Implementer standards

If you need a paragraph-long comment to justify a workaround, the code is wrong. Fix the code.

## Checklist per cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test has one behavior, not one assertion as a hard limit
[ ] Existing failing public-interface test was reused when it was already red
[ ] Test does not restate a static declaration unless that shape is an external contract
[ ] Test covers current or newly supported behavior, not only the absence of removed behavior
[ ] Obsolete tests were removed or updated
[ ] Subsumed driving tests were deleted or merged, not kept only for a completed red-green cycle
[ ] Code is minimal for this test
[ ] Refactor checkpoint was completed after each green slice, or no refactor was recorded as justified
[ ] Final code and test-contract refactors were completed before review
[ ] No speculative features added
```