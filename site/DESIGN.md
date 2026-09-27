---
name: Yuki landing page
description: A flat workshop index with generous type, ruled rows, and restrained blue and gold details.
colors:
  paper: "#f8f8f4"
  ink: "#202421"
  body: "#414844"
  muted: "#5c615e"
  blue: "#b6d0dc"
  gold: "#d8b34e"
  warm-gray: "#96928a"
  rule: "#d5d4ce"
  focus: "#246b86"
typography:
  display:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.55rem, 4.35vw, 4.35rem)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.3rem, 1.75vw, 1.65rem)"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "0.04em"
  lead:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 1.65vw, 1.5rem)"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 1.4vw, 1.3rem)"
    fontWeight: 400
    lineHeight: 1.58
  label:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "0.08em"
rounded:
  control: "4px"
spacing:
  compact: "0.75rem"
  standard: "1rem"
  gutter: "1.25rem"
  section: "1.5rem"
  wide: "2rem"
components:
  github-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
    height: "46px"
  github-button-hover:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink}"
  feature-label:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
---

# Design System: Yuki landing page

## Overview

**Creative North Star: "The Workshop Parts Index"**

This file documents the public landing page in `site/`. The application shares
the Workshop Parts Index identity and records its task-specific layout in the
root [design system](../DESIGN.md). Values here are extracted from `styles.css`;
page strategy remains in the
[surface brief](../.impeccable/surfaces/site-index-html.md).

The landing page uses a calm, practical index vocabulary: a warm near-white
canvas, charcoal lettering, thin rules, and generous text. Pale blue and gold
appear as small identifying details. Flat register rows give the real product
capabilities space without presenting them as simulated application data.

**Key Characteristics:**
- Self-hosted Almarai at three real weights: regular, bold, and extra-bold.
- Large headings, readable supporting text, and aligned feature labels.
- Flat surfaces and fine rules, with no authored shadows or entrance animation.
- A quiet masthead with one GitHub action on the right.

## Colors

Warm paper and slightly green charcoal carry the page; blue and gold provide
small accents rather than competing surfaces.

### Primary
- **Index Blue** (`{colors.blue}`): Small register marks and text selection fill.
- **Focus Blue** (`{colors.focus}`): Visible keyboard focus outlines.

### Secondary
- **Marker Gold** (`{colors.gold}`): Brand punctuation, the version-row marker,
  link hover detail, and the GitHub button's hover fill.

### Neutral
- **Workshop Paper** (`{colors.paper}`): The continuous page canvas.
- **Charcoal Ink** (`{colors.ink}`): Headings, wordmark, and primary button fill.
- **Reading Ink** (`{colors.body}`): Register descriptions.
- **Soft Graphite** (`{colors.muted}`): Supporting copy, labels, and footer links.
- **Warm Gray** (`{colors.warm-gray}`): Scrollbar, brand divider, and underlines.
- **Index Rule** (`{colors.rule}`): Masthead and register-row boundaries.

**The Small Accent Rule.** Keep ordinary reading text in the dark ink roles;
the pale decorative accents do not carry small text.

## Typography

**Display Font:** Almarai, with ui-sans-serif, system-ui, sans-serif fallbacks.
**Body Font:** The same family; no separate monospace or display face.

Local WOFF2 files supply weights 400, 700, and 800 with `font-display: swap`.
The extra-bold headline is compact and balanced; uppercase register headings
and feature labels establish a clear scan pattern.

The frontmatter records desktop display, title, lead, body, and label roles.
Descriptions have a short column measure (up to 43ch), while the hero lead
allows up to 70ch. Brand and button text keep their own established sizes.

At widths up to 760px, the display becomes
`clamp(2.45rem, 9vw, 4rem)` with a 1.08 line-height and a 14ch maximum measure.
Section titles use 1.25rem; body and lead use 1.125rem; labels retain 0.875rem.
The wordmark is 2.6rem on desktop and 2.1rem on mobile, with its existing
custom tight tracking; do not copy that tracking into reading text.

**The Readable Detail Rule.** Keep feature labels at their established 14px
base size and mobile descriptions at 18px; reflow the layout to make room.

## Layout

The masthead places the brand at left and a single GitHub button at right.
The content and footer are capped at 1370px, with a fluid width of
`calc(100% - 10.8vw)`. A centered hero leads into full-width ruled rows.

Desktop rows use a 4.5rem index column and three flexible columns for the
heading, description, and feature labels. Rows have a 166px minimum height,
1.65rem vertical padding, and fluid column gaps.

- At 1200px and below, labels flow underneath the heading and description;
  rows use a 4rem index column and two flexible content columns.
- At 760px and below, content has 1.25rem side gutters. The hero aligns left,
  rows have a 3.3rem index column beside stacked content, and the footer stacks.
- At 600px and below, the brand descriptor moves below the wordmark. The
  GitHub button remains on the right.

Use the extracted spacing values as recurring intervals, not a rigid global
scale: section separation is deliberately larger than spacing within rows.

## Elevation & Depth

The page has no authored shadows, cards, or floating content panels. Thin rules
and whitespace distinguish regions on a continuous canvas. The app shares this
palette and rule language while keeping task-specific panels and controls. The
live-editing toolbar is development tooling and is not part of this system.

**The Flat Index Rule.** Use alignment and rules to organize this surface;
do not add folded-paper imagery or packet motifs.

## Shapes

The only filled control has modest corners defined by the control radius.
Register marks are small geometric SVG symbols; they remain decorative and
hidden from assistive technology. Thin rectangular rules carry the structure.

## Components

### GitHub button

A dark, compact link styled as the masthead action. It uses the frontmatter
color, radius, padding, and minimum-height values, with 1rem bold text. Hover
changes it to gold with dark text. It remains at least 44px high on mobile.
The existing destination is the repository.

### Brand

An extra-bold wordmark with gold punctuation and a readable two-line product
descriptor. Desktop uses a thin vertical divider; small screens stack the
descriptor below the wordmark and remove the divider. The brand links to the
top of the page.

### Register row

A semantic list item containing an index and geometric mark, section heading,
short description, and a plain list of capability labels. The three rows
describe the catalogue, versioned files, and print history. Catalogue details
call out real filters such as favorites and failed or unprinted models.
Version details distinguish previews, metadata, and original files; print
details name dates and results. Keep these labels as text rather than
suggesting interactive filters.

### Source link and footer

The source link pairs an inline GitHub SVG with 1rem text and a 44px minimum hit
area. A sentence-case setup note closes the footer, telling self-hosters to use
Docker Compose and find the guide in the repository. Both use the muted ink
role, and the footer reflows vertically on smaller screens.

### Shared interaction states

Links receive a 3px focus outline with 4px offset. Button color transitions
last 140ms with `ease`; there is no entrance animation. Reduced-motion mode
disables smooth scrolling and reduces transitions to 0.01ms. Text selection
uses dark ink on blue; scrollbar colors use warm gray over paper.

## Do's and Don'ts

### Do:
- **Do** preserve the single-family typography and generous reading sizes.
- **Do** keep the GitHub action easy to find at the top right.
- **Do** reflow headings, descriptions, and labels without shrinking them.
- **Do** retain semantic lists, real links, and visible keyboard focus.

### Don't:
- **Don't** replace real capability descriptions with invented sample records.
- **Don't** add folded imagery, packet motifs, or invented model data.
- **Don't** use pale blue or gold for small reading text.
- **Don't** document the live editing toolbar as a product component.
