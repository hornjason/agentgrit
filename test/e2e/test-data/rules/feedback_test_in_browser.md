---
name: test-in-browser
description: Always validate UI changes in a real browser before shipping
metadata:
  type: feedback
tags:
  - ui-testing
  - validation
---

Validate every UI change in a real browser before declaring it complete.

- **Why:** DOM assertions and unit tests miss visual regressions, layout breaks, and interaction bugs
- **How to apply:** After any frontend change, open the page in a browser (or run Playwright) and verify the golden path visually
