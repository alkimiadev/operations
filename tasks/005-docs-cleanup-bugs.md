---
id: docs-cleanup-bugs
name: Remove resolved bug documentation from call-protocol.md
status: completed
depends_on: [bug-checkaccess-resource-bypass, bug-pendingrequestmap-type-conflict]
scope: single
risk: trivial
impact: isolated
level: review
---

## Description

After the two independent bugs are fixed in code, the "Bugs" section in `call-protocol.md` § Source vs. Spec Drift should be removed. These bugs will no longer exist as drift — they'll be resolved.

Specifically, remove:

1. The `checkAccess()` resource check bypass bug entry
2. The `PendingRequestMap` type name conflict bug entry

These are standalone fixes that don't depend on ADR-005 or ADR-006, so they can be cleaned up immediately after implementation.

## Acceptance Criteria

- [ ] "Bugs" subsection removed from `call-protocol.md` § Source vs. Spec Drift
- [ ] No other doc sections reference these bugs as unresolved
- [ ] `call-protocol.md` still has the ADR-005 and ADR-006 drift tables (those are not yet resolved)

## References

- docs/architecture/call-protocol.md § Source vs. Spec Drift → Bugs

## Notes

Both bugs (checkAccess resource bypass and PendingRequestMap type name conflict) have been resolved in prior tasks. The Bugs subsection was the only remaining reference.

## Summary

Removed the "Bugs" subsection from `call-protocol.md` § Source vs. Spec Drift and updated the introductory sentence to remove the "Bug" mention. ADR-005 and ADR-006 drift tables remain intact.
- Modified: `docs/architecture/call-protocol.md`
- All acceptance criteria verified: Bugs section removed, no other unresolved references, ADR drift tables preserved