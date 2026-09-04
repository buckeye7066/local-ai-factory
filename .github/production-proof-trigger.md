# Production proof trigger

This repository control exists so an exact `main` revision can deliberately trigger both Factory Deck and Purpose Foundry cloud proof workflows when a caller does not have access to GitHub's `workflow_dispatch` API.

When automation-origin content writes suppress recursive Actions events, use a reviewed pull request and put both smoke markers in the merge commit message so the resulting merge SHA is the exact revision under proof.

The marker-bearing commit is only the trigger. The resulting workflow runs and their artifacts are the production-readiness evidence.
