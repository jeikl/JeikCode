# JeikCode source repair report

## Outcome

State whether this is a proposed candidate, an investigated failure without a patch, or a candidate with recorded checks. Keep installed runtime repair separate and unclaimed.

## Identity and scope

Record the repository, full source commit and tree, original dirty state, affected component, and exact allowed files. Explain any uncertainty between source and the observed application.

## Diagnosis

Describe the root-cause hypothesis and the evidence supporting it. Distinguish observations from inferences, and include any plausible explanation that remains unresolved.

## Proposed change

Explain why each changed file is needed and how the change addresses the symptom. Identify relevant behavior that could regress.

## Verification

Summarize the baseline and candidate receipts with their exact statuses and source/probe digests. Explain the probe's coverage, any unrelated failure, and the remaining verification gaps. A native receipt belongs to its recorded source snapshot.

## Candidate lesson

If reusable evidence exists, record a proposed project lesson with the source revision, component, operating system, and relevant provider or configuration. Include the symptom, supporting evidence, proposed rule, and a condition that would invalidate it. Label it as awaiting maintainer review. Omit this section when the evidence does not justify a lesson.

## Sharing review

Confirm which data was removed or generalized from the diff and notes. Record any known sensitive material that still prevents sharing. Local packet preparation does not imply that a community submission was sent or approved.
