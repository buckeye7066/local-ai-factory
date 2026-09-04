# Production proof trigger

This repository control exists so an exact `main` revision can deliberately trigger both Factory Deck and Purpose Foundry cloud proof workflows when a caller does not have access to GitHub's `workflow_dispatch` API.

When automation-origin content writes suppress recursive Actions events, use a reviewed pull request and put both smoke markers in the merge commit message so the resulting merge SHA is the exact revision under proof.

An automation-authored synchronization commit may produce an `action_required` pull-request run with no jobs. That state is neither a passing nor failing test result. Add a reviewed, user-authored verification commit, require the normal exact-head job set to execute, and keep the branch unmergeable until those jobs finish successfully.

The marker-bearing commit is only the trigger. The resulting workflow runs and their artifacts are the production-readiness evidence.
