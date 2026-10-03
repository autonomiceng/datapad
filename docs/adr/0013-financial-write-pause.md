# Financial writes require a dispatch guard

Status: accepted.

A provider request with a reused idempotency key may still create its first remote effect if the earlier request never arrived. Therefore a global billing pause blocks both first dispatch and replay. Retrieval remains available for establishing outcomes.

Each admitted dispatch checks a deployment guard in its short stamp transaction. Pause locks that guard exclusively. A dispatch admitted before pause may still complete afterwards; the UI states this limit. A missing control is paused, and resume preserves existing consent and finite retry windows.

This gives a precise local ordering without holding SQL transactions across network calls. It does not cancel requests already in flight or coordinate workers in independently restored database copies. Restore inspection has no provider or worker composition; promoting a restored copy requires a separate operator handoff.
