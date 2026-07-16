---
name: stale-unused-rule
description: A stale rule that has not been recalled in months for eviction testing
metadata:
  type: feedback
tags:
  - deployment
  - stale
---

Always check the deployment logs after pushing to staging.

- **Why:** This rule has not been recalled or reinforced in over 90 days
- **How to apply:** This rule should be flagged as stale and evicted due to zero recent recall
