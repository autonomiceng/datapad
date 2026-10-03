# Resolve commercial terms and billing state independently

Combining price and state in one revision lets a future price change revive paused billing, and selecting the latest scheduled state can revive a cancelled agreement. We store commercial and state revisions separately in one terms table and make approved cancellation an immutable effective-period barrier that overrides later planned state changes. Periods capture both revisions, and changes atomically refresh affected unsealed copies while preserving sealed history and the earlier scheduled revisions.
