# Secrets Management

All credentials, tokens and keys are stored in the Strongroom vault.

## Rotation

Secrets in Strongroom are rotated every 90 days. Database passwords are rotated automatically; third-party API keys are rotated by the owning team.

## Break-glass access

Break-glass access to production secrets requires two approvers and is logged to the audit trail.

## Rules

Secrets must never be committed to a repository, including in env files. The pre-commit scanner blocks commits that contain a credential.
