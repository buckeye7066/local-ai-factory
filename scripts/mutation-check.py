#!/usr/bin/env python3
"""Mutation harness: break one guarantee, prove a test catches it, restore.

A mutation that silently did not apply is a HARNESS FAILURE, not a survivor —
so every case prints the applied check and aborts loudly if the substitution
did not land.
"""
import io, subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (label, file, old, new, test files)
MUTATIONS = [
    (
        "M1 a repo WITH CI must not be fast-forwarded (planTrunkAdvance sends 'present' to the gate)",
        "src/server/orchestrator/releasePlan.ts",
        '  if (input.hostCi === "absent") {',
        '  if (input.hostCi === "absent" || input.hostCi === "present") {',
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M2 'unknown' CI must route to the gate, never the bypass",
        "src/server/orchestrator/releasePlan.ts",
        '  if (input.hostCi === "absent") {',
        '  if (input.hostCi !== "present") {',
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M3 the direct-trunk-advance opt-in is OFF by default",
        "src/server/orchestrator/releasePlan.ts",
        "  if (input.directTrunkAdvance === true) {",
        "  if (input.directTrunkAdvance !== true) {",
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M4 deliverRun must honour the pr-gate decision (not fast-forward anyway)",
        "src/server/orchestrator/deliverRun.ts",
        '    if (trunkPlan.path === "pr-gate") {',
        '    if (trunkPlan.path === "never-happens") {',
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M5 an empty workflow file is not a CI gate",
        "src/server/workspace/hostCi.ts",
        "      if (statSync(join(dir, name)).size > 0) return name;",
        "      if (statSync(join(dir, name)).size >= 0) return name;",
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M6 an unreadable tree is UNKNOWN, never 'absent'",
        "src/server/workspace/hostCi.ts",
        '        presence: "unknown",\n        detail: `Could not read ${dir} to look for CI configuration.`,\n        evidence: null,\n      };\n    }\n  } catch {',
        '        presence: "absent",\n        detail: `Could not read ${dir} to look for CI configuration.`,\n        evidence: null,\n      };\n    }\n  } catch {',
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M7 a pending PR must not be reported as a failed run",
        "src/server/orchestrator/releasePlan.ts",
        '  if (state === "pending") return "pending";',
        '  if (state === "pending") return "fail-run";',
        ["src/server/__tests__/trunkProtectedByHostCi.test.ts"],
    ),
    (
        "M8 auto-merge is armed when checks outlast the window",
        "src/server/orchestrator/releaseRun.ts",
        '          "--squash", "--auto",',
        '          "--squash",',
        ["src/server/__tests__/releaseRun.test.ts"],
    ),
    (
        "M9 auto-merge is bound to the exact verified commit",
        "src/server/orchestrator/releaseRun.ts",
        '          "--squash", "--auto",\n          "--match-head-commit", input.verifiedCommitSha,',
        '          "--squash", "--auto",',
        ["src/server/__tests__/releaseRun.test.ts"],
    ),
    (
        "M10 an unarmable auto-merge is HELD, never reported as pending",
        "src/server/orchestrator/releaseRun.ts",
        "      if (!succeeded(armed)) {",
        "      if (false && !succeeded(armed)) {",
        ["src/server/__tests__/releaseRun.test.ts"],
    ),
    (
        "M11 the PR base branch is resolved by gh, never hardcoded to main",
        "src/server/orchestrator/releaseRun.ts",
        '      "--head", input.branch,\n      "--title", title, "--body", body,',
        '      "--head", input.branch, "--base", "main",\n      "--title", title, "--body", body,',
        ["src/server/__tests__/releaseRun.test.ts"],
    ),
]


def read(p):
    return io.open(os.path.join(ROOT, p), encoding="utf-8").read()


def write(p, s):
    io.open(os.path.join(ROOT, p), "w", encoding="utf-8", newline="").write(s)


def run_tests(files):
    r = subprocess.run(
        ["npx", "vitest", "run", *files],
        cwd=ROOT, capture_output=True, text=True, shell=True,
    )
    return r.returncode


only = sys.argv[1] if len(sys.argv) > 1 else None
applied = killed = 0
survivors = []

for label, path, old, new, tests in MUTATIONS:
    if only and not label.startswith(only):
        continue
    original = read(path)
    count = original.count(old)
    print(f"\n=== {label}")
    print(f"    file: {path}")
    print(f"    APPLIED CHECK: pattern occurrences = {count}")
    if count != 1:
        print("    HARNESS FAILURE: mutation did not apply uniquely. ABORT.")
        sys.exit(2)
    mutated = original.replace(old, new)
    assert mutated != original, "HARNESS FAILURE: mutated text identical to original"
    write(path, mutated)
    applied += 1
    try:
        code = run_tests(tests)
    finally:
        write(path, original)
        assert read(path) == original, "HARNESS FAILURE: restore did not restore"
    if code != 0:
        killed += 1
        print(f"    KILLED (tests exited {code}) — the guarantee is really tested.")
    else:
        survivors.append(label)
        print("    SURVIVED (tests exited 0) — the guarantee is NOT tested.")

print(f"\napplied={applied} killed={killed}")
if survivors:
    print("SURVIVORS:")
    for s in survivors:
        print(" -", s)
    sys.exit(1)
