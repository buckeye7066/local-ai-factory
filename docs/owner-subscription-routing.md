# Owner subscription-first routing

Owner decision: 2026-09-13. For owner-operated coding work, consume eligible
OpenAI/ChatGPT and Anthropic/Claude subscription capacity before metered API
keys. Retain existing API budgets and genuinely free/local fallback.

FlexFactor selects subscription tiers before metered tiers in its automatic
best-available mode. Factory Deck / Purpose Foundry prepend a subscription-only
rotation tier to the automatic model ladder and recheck it after quota resets.
Explicit free-only and diagnostic provider selection remain separate.

Use the owner's existing official Codex and Claude Code sign-ins. CLI child
processes omit inherited OpenAI/Anthropic API credentials and cloud-provider
overrides; parent SDK fallback credentials are not deleted or modified.
A configured API-key helper or provider billing/extra-usage setting must still
be checked independently; subscription access is not unlimited API credit.

These shared coding routers can work on any selected repository. This is NOT
an account-token export or a customer-facing inference gateway. Application
server SDK calls, images/audio/embeddings, and hosted customer requests remain
on their supported API integrations. No personal account secret belongs in Git.

## Explicit private owner installation

`FACTORY_OWNER_SUBSCRIPTION_ONLY=1` together with an absolute `FACTORY_OWNER_CODEX_HOME` enrolls this private local installation. The config must live only in the owner's local environment, never the distributed build. This mode uses the official Codex executable with verified ChatGPT authentication and structured complete-output receipts. It removes all metered API rungs even if API keys exist, then permits configured genuinely free/local fallback. Customers on other installations remain unenrolled and retain their own provider settings. LAN access remains subject to the existing bearer-token boundary; this is not a shared customer inference service.

Prompts continue through the existing run idea and persisted steering mailbox, not a second instruction path. Existing completion/checkpoint and independent-review requirements remain enforced.

Executed locally: official subscription inference returned Factory subscription OK with `billingMode=subscription`, actual `gpt-6-astra` model and usage counters. The subscription/prompt/auth test set passed 44 cases; full-suite verification is recorded with the release. No owner credential, home directory or token is bundled in the app.

## Authoritative local execution metadata

The owner transport now uses the official Codex app-server stdio protocol. It verifies ChatGPT account authentication, the selected model returned by thread/start, ephemeral read-only execution and absence of user instruction files. Server invariants remain privileged developer instructions; task text is separate. Unexpected tools, model rerouting, malformed/incomplete output and deadline failures are refused. Requested output tokens are advisory; actual provider usage is recorded and hard byte/time limits remain enforced. In a controlled live test the trusted instruction prevailed over conflicting task text and the runtime returned model_source=app_server_configuration.
