export const CORE = `Design a glanceable summary with one clear focus: a value, status, event or theme
chosen for the user's purpose, plus only the context needed to understand it. A selection bounds
candidate source content; it does not require reproducing every field, paragraph or record.
Omit duplicate headings, long descriptions, secondary statistics, redundant labels and low-priority
items. Select by explicit user focus, observed source priority or chronology; preserve source order
among equally important records. Label partial lists as a selection or show a count.
Preserve identity, units, period, critical status and meaning-changing qualifiers. Never reverse a
negation, present a subset as a total or turn unknown into zero. Explicitly named fields/items and
requests for all content take precedence. If they cannot fit an explicit size readably, explain the
conflict and ask the user to reduce content or increase size; do not silently omit or shrink to fit.
Selection is a display policy, not a source-page edit. Apply data-dependent selection, counts and
missing-value handling on every extraction/render; never freeze captured summaries or chosen records
as business text. Stable field choices may be coded, but displayed facts must follow current data.

Understand the user's purpose, the selected page content and what its images communicate. When a
relevant source image helps readers recognize the subject, understand the information or scan the
widget more clearly, prioritize using it without waiting for an explicit image request. Apply this
judgment to any subject. Choose a leading or supporting visual role and give the image enough space
to be useful at the actual size, while keeping names, key values, units and necessary context readable.
Reduce redundant labels and optional details to make room; preserve explicit requirements and source
priority. Do not substitute unrelated ads, site logos or other images for the selected content.
Prefer a data graphic when it clearly conveys the main information: charts need real series and
progress needs a real value and target. Never invent data. Simple icons or CSS/SVG may clarify category
or status. Use clear text when suitable imagery/data is absent or unreadable at the actual size, or
the user requests no images. Decoration cannot replace meaning; never freeze changing content in a
screenshot. An img on the page alone does not justify using it.

Use whitespace, alignment and typography before containers: a neutral surface, strong primary text,
quiet secondary text and one contextual accent. Avoid nested cards, heavy shadows and competing
highlights. Start with the size tokens: body is for readable titles/item names/content; caption is
only for short auxiliary labels, never an entire list. When crowded, omit optional content and
rows, remove decoration, then recompose. Preserve graphics/images that carry the main information;
simplify their details or use a more compact expression if essential text remains crowded. Do not
lower font sizes or scale the whole layout to fit more content. Explicit user style/font preferences
override defaults. Balance content across the usable canvas: when equally relevant records remain
and another complete row fits readably, show it instead of leaving accidental empty space. Do not
stretch a short list with oversized gaps while omitting useful records. With genuinely sparse data,
compose the available focus deliberately; adjust placement or visual scale without inventing filler.
Necessary breathing room and explicit limits matter more than filling every pixel.
Only-canvas content with no equivalent DOM data is unsupported: explain the extraction failure.
An unrelated canvas does not prevent extracting the requested DOM content. No screenshot or OCR fallback.`;
