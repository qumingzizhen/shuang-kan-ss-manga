# Client Strategy

## Decision

Build the web version first.

Future app clients should reuse the same backend rather than introducing a separate app-only backend.

## Shared Backend Surface

| Capability | Shared by Web and Future App |
|---|---|
| Authentication | Yes |
| User profile and permissions | Yes |
| Task creation and task history | Yes |
| Download progress events | Yes |
| File library and exports | Yes |
| Source adapter registry | Yes |
| Audit and abuse controls | Yes |
| Admin operations | Mostly yes, with stricter role checks |

## Client-specific Layer

If the future app needs different aggregation or offline behavior, add a thin BFF layer:

```text
Web / App / Desktop
  -> Client-specific BFF when needed
  -> Shared Core API
  -> Shared task, file, auth, and worker services
```

The BFF should not own business data. It should only reshape responses, optimize round trips, and adapt to platform-specific needs.

## Web Interaction Notes

The web console uses right-side detail drawers for task and file-library
inspection. Drawers must have an explicit close action, dismiss when the user
clicks outside the drawer area, and close on `Escape`. The current visual
direction is a soft manga/anime-inspired operations console rather than a
generic SaaS dashboard.

File-library reading uses a full-screen reader overlay instead of opening raw
image tabs. The reader keeps page navigation, page jump, adjacent-page
preloading, thumbnail context, fit-mode preference, and shelf progress in the
shared web client layer while persisting reading state through the backend API,
so future app clients can reuse the same data contract.
