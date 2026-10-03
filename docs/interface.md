# Interface conventions

These conventions describe the current portal pages: customer accounts, services, invoices and subscriptions. They apply the interface rules in [AGENTS.md](../AGENTS.md). Tokens live in [styles.css](../src/web/styles.css); page styles reuse them and add no new colors, sizes or weights.

## Type and color

- One system sans-serif family. Three sizes: `--text-page` for the single page title, `--text-body` for content and section headings, `--text-support` for labels, notes and secondary actions.
- Two weights: 400 and 600. Section headings, amounts and form labels use 600.
- `--muted` marks labels and supporting notes. `--accent` marks primary actions and links. `--danger` marks warnings and review states and is never decorative.
- Amounts use tabular figures and align right.

## Page structure

- An account page is at most 800px wide. A muted back link names the parent page, followed by one `h1`. Detail pages use the record's name as the title.
- Each white panel holds one task or one set of related records. Give a panel a visible `h2` only when it adds information. Otherwise give it an accessible label.
- Group related records with spacing, rules and indentation instead of nested panels. Child records, such as add-ons and forecast lines, are indented behind a 2px rule.
- Use disclosure only when it hides substantial secondary information.

## Facts and comparison

- Show facts as muted labels above values in a grid that wraps by available width. Keep compared values next to each other on desktop and at 390px.
- Put a supporting value, such as a due date or check time, below its main value in supporting text.
- Write dates as `Nov 3, 2026`. Write a service period as `Nov 3 to Dec 3, 2026`; the end date is exclusive, as defined in the [glossary](../CONTEXT.md).

## Forms and actions

- Labels sit above controls. Controls are at least 44px tall. Split one combined choice into small dependent selects whose options come only from server-supplied combinations.
- Primary buttons name the result, such as "Create subscription", "Save changes" or "Update forecast". Secondary buttons use the outlined style.
- Put each warning or note directly below the field it explains. Incomplete or invalid input disables the dependent action. It never reaches a query.
- On a conflict, lock the inputs and offer "Reload and review". Never retry automatically.

## Status and review

- Status tags are small outlined labels. Normal states are quiet, unpaid and billable states use the accent, and review states use the danger color.
- A review explanation uses a danger left rule beside the record it concerns. It says what happened and what to do next. It never implies a balance, payment or provider effect that has not happened.
- Check every changed page at 1280px and 390px for horizontal overflow and repeated copy.
