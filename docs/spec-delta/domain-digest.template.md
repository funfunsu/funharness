# Domain Digest Template

> Purpose
> This document is the human-readable summary for Spec Delta reviews.
> It is generated from machine-readable delta records and grouped by domain.

---

## Metadata

- digestVersion: 1.0.0
- generatedAt: {{generatedAt}}
- workspace: {{workspace}}
- iteration: {{iteration}}
- sourceLedger: {{sourceLedgerPath}}
- gateLevel: {{gateLevel}}
- baselineSnapshot: {{baselineSnapshotId}}
- currentSnapshot: {{currentSnapshotId}}

---

## Executive Summary

- totalChanges: {{summary.totalChanges}}
- highRiskChanges: {{summary.highRiskChanges}}
- mediumRiskChanges: {{summary.mediumRiskChanges}}
- lowRiskChanges: {{summary.lowRiskChanges}}
- blockedByGate: {{summary.blockedByGate}}
- pendingHumanReview: {{summary.pendingHumanReview}}

### Gate Verdict

- verdict: {{summary.verdict}}
- reason: {{summary.verdictReason}}

---

## Domain Index

{{domainIndexTable}}

Expected table columns:

- domain
- total
- high
- medium
- low
- reqChanged
- contractChanged
- testcaseChanged
- taskChanged
- blocked

---

## Domain Sections

### Domain: {{domain.name}}

#### 1) Intent Delta

- addedRequirements:
  - {{domain.intent.added[0]}}
- modifiedRequirements:
  - {{domain.intent.modified[0]}}
- removedRequirements:
  - {{domain.intent.removed[0]}}

#### 2) Requirement Delta Details

| reqId | changeType | oldIntent | newIntent | severity | traceStatus |
| --- | --- | --- | --- | --- | --- |
| {{domain.reqDelta[0].reqId}} | {{domain.reqDelta[0].changeType}} | {{domain.reqDelta[0].oldIntent}} | {{domain.reqDelta[0].newIntent}} | {{domain.reqDelta[0].severity}} | {{domain.reqDelta[0].traceStatus}} |

#### 3) Contract Delta

| contractId | endpointOrModel | changeType | old | new | severity |
| --- | --- | --- | --- | --- | --- |
| {{domain.contractDelta[0].contractId}} | {{domain.contractDelta[0].endpointOrModel}} | {{domain.contractDelta[0].changeType}} | {{domain.contractDelta[0].old}} | {{domain.contractDelta[0].new}} | {{domain.contractDelta[0].severity}} |

#### 4) Validation Delta

| testcaseId | relatedReqIds | changeType | givenWhenThenChanged | resultImpact |
| --- | --- | --- | --- | --- |
| {{domain.validationDelta[0].testcaseId}} | {{domain.validationDelta[0].relatedReqIds}} | {{domain.validationDelta[0].changeType}} | {{domain.validationDelta[0].givenWhenThenChanged}} | {{domain.validationDelta[0].resultImpact}} |

#### 5) Task Delta

| taskId | relatedReqIds | changeType | executionImpact | status |
| --- | --- | --- | --- | --- |
| {{domain.taskDelta[0].taskId}} | {{domain.taskDelta[0].relatedReqIds}} | {{domain.taskDelta[0].changeType}} | {{domain.taskDelta[0].executionImpact}} | {{domain.taskDelta[0].status}} |

#### 6) Drift Signals

- implementationDriftDetected: {{domain.drift.detected}}
- driftType:
  - {{domain.drift.types[0]}}
- details:
  - {{domain.drift.details[0]}}

#### 7) Risk And Actions

- riskLevel: {{domain.risk.level}}
- blockers:
  - {{domain.risk.blockers[0]}}
- requiredActions:
  - {{domain.risk.requiredActions[0]}}
- autoRepairSuggestedPrompt:
  - {{domain.risk.autoRepairPrompt}}

---

## Cross-Domain Coupling

| sourceDomain | targetDomain | couplingType | changedArtifact | risk |
| --- | --- | --- | --- | --- |
| {{coupling[0].sourceDomain}} | {{coupling[0].targetDomain}} | {{coupling[0].couplingType}} | {{coupling[0].changedArtifact}} | {{coupling[0].risk}} |

---

## Policy Exceptions

| exceptionId | domain | reason | approvedBy | expiresAt |
| --- | --- | --- | --- | --- |
| {{exceptions[0].id}} | {{exceptions[0].domain}} | {{exceptions[0].reason}} | {{exceptions[0].approvedBy}} | {{exceptions[0].expiresAt}} |

---

## Reviewer Checklist

- [ ] Every modified requirement has updated trace links in design, testcase, and tasks.
- [ ] Contract delta has corresponding design delta.
- [ ] Given/When/Then changes are reflected in testcase delta.
- [ ] No high-risk drift item remains unresolved.
- [ ] Gate verdict is consistent with current policy level.

---

## Machine Notes

This section may be auto-filled by the pipeline and should not be manually edited.

- digestHash: {{machine.digestHash}}
- inputDeltaCount: {{machine.inputDeltaCount}}
- unresolvedBlockers: {{machine.unresolvedBlockers}}
- rendererVersion: {{machine.rendererVersion}}
