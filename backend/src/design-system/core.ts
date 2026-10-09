export const CORE = `Design a glanceable summary with one clear focus: a value, status, event or theme
chosen for the user's purpose, plus only the context needed to understand it. A selection bounds
candidate source content; it does not require reproducing every field, paragraph or record.
Omit duplicate headings, long descriptions, secondary statistics, redundant labels and low-priority
items. Select by explicit user focus, observed source priority or chronology; preserve source order
among equally important records. Use widget space for content: do not add selection labels,
shown/total/remaining counts or "all N items" notices, even when only part of a list fits. This applies
to every placement, including headings and footers. Preserve source business quantities and ranks;
show coverage information only when the user explicitly requests it.
Preserve identity, units, period, critical status and meaning-changing qualifiers. Never reverse a
negation, present a subset as a total or turn unknown into zero. Explicitly named fields/items and
requests for all content take precedence. If they cannot fit an explicit size readably, explain the
conflict and ask the user to reduce content or increase size; do not silently omit or shrink to fit.
Selection is a display policy, not a source-page edit. Apply data-dependent selection and
missing-value handling on every extraction/render; never freeze captured summaries or chosen records
as business text. Stable field choices may be coded, but displayed facts must follow current data.
Unless the user sets a count, never pre-cap rendered records with a constant slice or loop limit,
even before fit checks.

Understand the user's purpose, the selected page content and what its images communicate. When a
relevant source image helps readers recognize the subject, understand the information or scan the
widget more clearly, prioritize using it without waiting for an explicit image request. Apply this
judgment to any subject. Choose how many images to show from recognizable artwork size, current text
and clear group spacing; available images are candidates, not a display quota. Keep equivalent
image-led records visually consistent. For useful foreground imagery, establish generous recognizable
artwork and breathing room before choosing columns or record count. A grid of small logo/name rows
can still look crowded without overflow: reduce complete groups and enlarge their imagery instead
of optimizing for the maximum number of icons. This is the default, not only an explicit image-emphasis style. Use a featured
image group plus quieter text groups only when the source or user establishes that hierarchy;
do not arbitrarily decorate just the first record. Explicit record counts protect records and key
fields, not every auxiliary icon. If all images are explicitly required and cannot fit readably,
explain the conflict. Let useful foreground images lead their groups, with quieter supporting names and metadata. Judge the visible artwork, not only the img
box; transparent padding can make a large box look small. Reclaim metadata columns and redundant text
before reducing optional records; useful image detail is content, not expendable decoration. Preserve
explicit record counts and key fields. Keep names, key values, units and necessary context readable.
When the user asks for image emphasis, let recognizable imagery lead and use quieter name labels,
lighter text weight and restrained metadata. Readable auxiliary names may follow that explicit style
preference; restore a clear text identity when an image is absent. Do not fade essential values.
Reduce redundant labels and optional details to make room; preserve explicit requirements and source
priority. Do not substitute unrelated ads, site logos or other images for the selected content.
Prefer a data graphic when it clearly conveys the main information: charts need real series and
progress needs a real value and target. Never invent data. Simple icons or CSS/SVG may clarify category
or status. Use clear text when suitable imagery/data is absent or unreadable at the actual size, or
the user requests no images. Decoration cannot replace meaning; never freeze changing content in a
screenshot. An img on the page alone does not justify using it.

Compose readable information groups: keep an entity's image, name, value and status close, with
more space between groups than within them. Align peers without pulling related fields to opposite
edges. Repeated empty middle bands beside crowded edges call for regrouping, not more decoration.
Choose columns from content width and reading order; symmetry is not a goal.

Default to a white canvas, strong primary text, quiet secondary text and a restrained accent.
Use a soft neutral inset surface to distinguish meaningful supporting groups or a current item;
whitespace or a fine divider can separate peers. Avoid repeated boxes, nested cards and heavy shadows.
Relevant images may lead, support a row or enrich a whole/partial background. Place background imagery
near an edge or behind a quiet area, fading the image toward the surface while keeping text opaque
and readable. Actively consider a quiet thematic layer: a relevant source-image crop or simple CSS/SVG
motif at an edge, corner or header can add character without taking a row of space. Start around
4–10% image/shape opacity and adjust at actual size; never fade the text or fabricate business data.
Keep a record-specific mark local to that record, especially in mixed-topic lists. Omit an unsuitable
layer or respect a no-image request; do not treat background decoration as a required quota.
Explicit color/theme preferences take precedence. Start with the size tokens: body is for readable
titles/item names/content; caption is only for short auxiliary labels, never an entire list. When crowded, remove redundant labels and
decoration, compact headings and spacing, then recompose or omit optional details and rows while
retaining readable rhythm. Preserve graphics/images that carry the main information;
simplify their details or use a more compact expression if essential text remains crowded. Do not
lower font sizes or scale the whole layout to fit more content. Explicit user style/font preferences
override defaults. Balance content across the usable canvas: when equally relevant records remain
and another complete group fits with recognizable images and clear separation, show it instead of
leaving accidental empty space. Being inside the canvas alone does not establish capacity. Do not
stretch a short list with oversized gaps while omitting useful records. With genuinely sparse data,
compose the available focus deliberately; adjust placement or visual scale without inventing filler.
Necessary breathing room and explicit limits matter more than filling every pixel.
Only-canvas content with no equivalent DOM data is unsupported: explain the extraction failure.
An unrelated canvas does not prevent extracting the requested DOM content. No screenshot or OCR fallback.`;
