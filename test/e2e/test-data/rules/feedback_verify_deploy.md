---
name: verify-deploy
description: Always verify deployment succeeded by checking live endpoint
metadata:
  type: feedback
tags:
  - deployment
  - verification
---

Verify deployment succeeded by hitting the live endpoint after every deploy.

- **Why:** Deployments can succeed at the container level but fail at the routing level
- **How to apply:** After every `make rebuild` or deploy command, curl the health endpoint and verify 200 response before declaring done
