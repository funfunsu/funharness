# Spec Delta Assets

This directory provides baseline assets for the Spec Delta review layer.

## Files

- domain-digest.template.md
  - Human-readable review output template.
  - Grouped by domain and focused on intent, contract, validation, and drift impact.

- domain-classification-rules.yaml
  - Machine-readable domain mapping rules.
  - Includes priority order, scoring, fallback, and strict-gate constraints.

## Intended Pipeline Flow

1. Collect delta facts from requirement, design, testcase, tasks, and implementation checks.
2. Classify each delta fact into a domain using domain-classification-rules.yaml.
3. Aggregate by domain and compute risk and gate verdict.
4. Render a digest document using domain-digest.template.md.
5. Persist both machine ledger and human digest outputs.

## Suggested Output Paths

- Machine ledger:
  - .harness/spec-delta/ledger.jsonl

- Per-run digest:
  - specs/<iteration>/delta/domain-digest-<timestamp>.md

- Latest digest shortcut:
  - specs/<iteration>/delta/domain-digest.latest.md

## Minimum Fields Needed By The Template

- generatedAt
- workspace
- iteration
- gateLevel
- baselineSnapshotId
- currentSnapshotId
- summary object
- domainIndexTable markdown
- domain sections data

## Strict Mode Recommendations

- deny uncategorized domain items until manually resolved
- deny behavior-changing implementation drift without corresponding spec delta
- deny contract delta when requirement/testcase links are stale

## Rollout Plan

1. Phase 1
  - Generate ledger and digest only.
  - Do not block merges yet.

2. Phase 2
  - Enable standard gate blocking on broken trace links and high-risk drift.

3. Phase 3
  - Enable strict gate policies from domain-classification-rules.yaml.
