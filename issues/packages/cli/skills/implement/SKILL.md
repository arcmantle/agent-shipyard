---
name: implement
description: Delivers a change in thin, independently-verified vertical slices instead of one large pass, anchored to the active agent-issues issue. Use for broad refactors, config or infrastructure changes, multi-file migrations, or other work with no fast test seam. After the last slice, prune duplicate driving tests and keep one public-interface contract per behavior.
argument-hint: Issue ID to implement (or the briefing prepare just reported)
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Incremental Implementation

Build in thin vertical slices: implement one piece, verify it, then expand. Each increment leaves the system in a working, verified state. Never implement an entire issue in one uninterrupted pass.

You write and verify every slice yourself, in this conversation. Never start a subagent to implement a slice, even to save time or context. The only subagent this skill starts is the read-only review in step 5, after the test-contract refactor.

If a slice turns out to have a natural test seam, write the test for that slice. Verification and tests can work together in this skill.

Before you write a new test, run the current suite against the missing behavior. If an existing public-interface test already fails for the correct reason, that failure is the verification. Do not add a second test for the same path.

A slice-local test is a driving test. A keeper test is a contract that must stay after the issue is done. Do not keep one test per slice when those tests pin the same behavior. After the last slice, keep the smallest public-interface suite that still pins the issue contract. If test A cannot fail unless test B also fails, delete test A. Merge near-duplicate tests into one table-driven test when the cases pin the same API. Do not use coverage percentage as the prune signal. Do not add an absence test for a deleted driving test.

When an issue removes a feature, constraint, or compatibility path, remove or update its obsolete tests. Do not add a new test whose only purpose is to confirm that deleted code or an obsolete restriction has not returned. That test has no current behavior contract and adds maintenance cost. Test a replacement or newly supported observable behavior when the change creates one. Add an absence test only when the active issue or a relevant ADR makes the absence an explicit, observable requirement.

## Workflow

### 1. Planning

Run the **Entity Read** recipe, the **Relation Query** recipe, and the **Context Read** recipe for the active issue and its scope. Read every linked `planEntries` item returned by the issue; its current body can contain implementation decisions and constraints. If `prepare` reported a briefing at the fork, use that instead. Confirm the public interface, the priority behaviors, and the approach. Resolve any hard-to-reverse question before you write code. Send it to `/agent-issues grill-with-docs` instead of deciding it yourself.

Treat the issue's `planEntries` as planning inputs. Do not create or change Plan-entry links. Report missing Plan-entry provenance to the issue creator.

Break the approach into vertical slices before you start:

- **Vertical (preferred):** each slice is a complete path through the stack. The slice gives the user or caller new, working capability. Do not build one layer at a time across every slice, for example all models, then all endpoints, then all UI.
- **Contract-first:** when two sides of a boundary must move in parallel, fix the shared type or interface first. Then implement each side against it independently.
- **Risk-first:** sometimes one slice is genuinely uncertain, for example an external integration, a tricky migration, or a performance question. Do that slice first. A dead end then surfaces before you build on top of it.

List the observable behaviors that the issue requires. That list is the test map for the later test-contract refactor.

### 2. The increment cycle

For each slice:

1. **Implement** the smallest complete piece of the slice. Before you write it, ask what the simplest thing that could work is. After you write it, check that each abstraction earns its complexity. Do not add complexity for a problem this issue does not have. Three similar lines are better than one early abstraction.
2. **Verify** with the narrowest check available. Run the slice's tests if a test seam exists. If an existing public-interface test already covers the slice, do not add another test. If not, run the repository's build, typecheck, and lint commands for the touched packages. Then run a manual check that the behavior matches what the slice promised.
3. **Move to the next slice.** Carry the working state forward. Do not restart. Do not batch verification across slices. Slice checks can stay local. The kept suite after the last slice must be the issue contract, not one test per slice.

Touch only what the issue requires. If you notice unrelated cleanup worth doing, name it in your report instead of doing it:

```
NOTICED BUT NOT TOUCHING:
- <file>: <what you noticed, and why it's out of this issue's scope>
```

### 3. Increment discipline

- **One thing at a time.** Each increment changes one logical thing. Do not mix a feature addition with an unrelated refactor or config change in the same slice.
- **Keep it compilable.** After every slice, the touched packages must build and their existing tests must still pass. Never leave the tree in a broken state between slices.
- **Safe defaults.** New behavior defaults to off, or to the conservative choice, unless the issue asks for the opposite. Do not change existing behavior for every caller as a side effect of one slice.
- **Rollback-friendly.** Prefer additive changes over edits to existing code, where the issue allows it. Additive changes are new files or new functions. Do not delete code and replace it in the same slice. Split the delete and the replacement into separate slices, so either half reverts on its own.

### 4. Test-contract refactor

After the last slice's focused verification passes, and while the suite is green, refactor the tests before review:

- Map each new test to one behavior from the planning list.
- Remove a test if another public-interface test already fails for the same reason.
- Merge near-duplicate tests that pin the same API.
- Keep the smallest set that still pins the issue contract.

Do not mark this step complete while a subsumed test remains. Do not keep a driving test as history. Run the focused verification again after the prune.

### 5. Implementation review gate

You, the visible `implement` agent, own every increment, its verification, and any repairs. Do not hand the build to a subagent: you hold the context on what the active Agent Issues skills expect, and a subagent does not have it. Do not treat the first working slice as the end of the work.

After the test-contract refactor and the focused verification pass, start one read-only review subagent. This is the only step that runs as a subagent. Give the reviewer the active issue context, the changed-file diff, the verification you already ran, the test map, and the shared [language standard](../agent-issues-language.md). The reviewer's report, its findings, and every message it writes must follow that standard.

The reviewer must cover all of these:

- **Behavior and contract:** Compare the implementation and tests against the active issue, the linked user stories, the relevant ADRs, and the observable public behavior. Find missing behaviors, wrong semantics, and gaps in behavior coverage.
- **Test surplus:** Find duplicate assertions on the same public API, tests that restate the same code path with a small fixture change, tests that exist only to complete a slice, and tests that pin internals or a static shape. A surplus finding has the same weight as a missing-behavior finding. The reviewer must report surplus explicitly, including `no surplus` when none remains.
- **Code and regression risk:** Inspect the changed code for correctness defects, unplanned scope, regressions, gaps in error handling, maintainability concerns, and gaps in validation.

The reviewer must not edit files. It must return either no findings, or structured findings with a severity, a file and location, evidence, and a concrete fix.

`implement` rejects a finding only when it can explain why the finding is invalid or out of scope. Do not reject a surplus finding only because the test helped a slice. For every valid, material finding, fix it yourself. Then re-run the verification that covers the fix. Do not hand repairs to a subagent. If there are no material findings, `implement` records the reviewer report before the final verification. Do not mark the issue done until this gate is complete and the test map has no subsumed tests.

### 6. Complete and report

After the review gate and the final verification pass, mark the active issue `done`. Start the `next-work` skill with the active initiative. Include its result in the completion report. Do not start the selected issue.

## Red flags

Stop and reconsider the current slice if any of these show up:

- More than roughly 100 lines written without running any verification.
- Two or more unrelated changes landing in the same slice.
- Scope creep, for example telling yourself "let me just quickly add this too."
- Skipping verification to move faster.
- The build or tests are broken between slices.
- An abstraction built before a third use case actually demands it.
- Editing files outside the issue's scope because you happened to be nearby.
- Starting a subagent to implement or fix a slice instead of doing it yourself.

## Checklist per slice

```
[ ] Slice is a complete, working vertical step, not a partial layer
[ ] A test, build, typecheck, or manual check ran and passed
[ ] Existing failing public-interface test was reused when it already covered the slice
[ ] New tests cover current or newly supported behavior, not only the absence of removed behavior
[ ] Obsolete tests were removed or updated
[ ] Subsumed driving tests were deleted or merged after the last slice
[ ] No unrelated changes riding along in this slice
[ ] No speculative abstractions added ahead of a real second or third use case
[ ] The tree builds and existing checks still pass after this slice
```

