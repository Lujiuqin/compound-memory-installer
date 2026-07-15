# Compound Memory Schema

## Note properties

Structured notes use `id`, `type`, `status`, `created`, `updated`, `domains`, `aliases`, `sources`, and `review_after`.

Supported types include `capture`, `daily`, `evergreen`, `project`, `source`, `map`, `system-health`, and `system-review`.

## Compounding rule

Search titles, aliases and bodies first. Append dated evidence or refinements to an existing evergreen note when the conclusion matches. Create a new evergreen note only for a meaningfully distinct conclusion. Keep raw material in the inbox until that choice is clear.

## Review signals

- Stale inbox: older than three days.
- Orphan evergreen: older than fourteen days with no incoming or outgoing wikilinks.
- Missing source: evergreen note with no `sources` value.
- Duplicate candidate: normalized title or alias collision.
- Broken link: wikilink with no resolvable note target.

Treat the first four weeks as a baseline. Prefer trend-based system proposals over optimizing a single score.

