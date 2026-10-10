# Reproduction

## Symptom

Describe the JeikCode component and the smallest observed failure. Quote only the relevant, redacted error text.

## Environment and identity

Record the source commit and tree, original checkout dirty state, operating system, and relevant JeikCode configuration category. Record observed binary build information separately. Keep installed runtime correspondence unknown unless independently established outside this workflow.

## Steps

List the minimal inputs and actions in order. State the expected result and the result actually observed. Explain any unavailable input or dependency.

## Captured probe

Record whether an independent probe was captured during preparation and its digest from the native receipt. Describe its inputs, assertions, and expected exit behavior precisely enough for a maintainer to reconstruct and review a check. The raw captured script stays local; its digest cannot reconstruct its contents. Do not embed credentials or installation commands in this report.

## Baseline

Record the exact baseline status, the source digest, and whether the observed failure demonstrates the reported defect. A missing, blocked, or timed-out check must remain explicit.

## Candidate

Record the exact candidate status and source digest. Explain the observed behavioral difference and the scope of the check. State if the final candidate changed after the recorded check.

## Remaining gaps

List the relevant platforms, paths, or runtime behavior that were not checked. Include unavailable sandbox or toolchain support and installed application behavior that remains unverified.
