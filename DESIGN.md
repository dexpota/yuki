---
name: Yuki
description: A clear, work-first interface for a self-hosted model catalogue and print organizer.
colors:
  paper: "#f8f8f4"
  surface: "#ffffff"
  surface-alt: "#f0efe9"
  ink: "#202421"
  muted: "#5c615e"
  subtle: "#6d706b"
  line: "#d5d4ce"
  line-strong: "#96928a"
  blue: "#b6d0dc"
  blue-wash: "#edf4f6"
  gold: "#d8b34e"
  gold-wash: "#f5edcf"
  ink-hover: "#353b37"
  success-ink: "#225b39"
  success-bg: "#e4f2e8"
  success-border: "#c9dfce"
  warning-ink: "#6c4c08"
  warning-bg: "#f5edd7"
  warning-border: "#e5d6ab"
  danger-ink: "#7a2e2b"
  danger-bg: "#f8e7e5"
  danger-border: "#e7c6c3"
  focus: "#246b86"
typography:
  display:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 3.35rem)"
    fontWeight: 720
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 670
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.97rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Almarai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0.04em"
rounded:
  xs: "2px"
  sm: "4px"
  md: "5px"
  lg: "11.2px"
  panel: "12.8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0.65rem 1rem"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.65rem 1rem"
    height: "42px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.62rem 0.78rem"
    height: "42px"
  model-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "1.25rem"
---

# Design System: Yuki

## Overview

**Creative North Star: "The Workshop Parts Index"**

Yuki's interface borrows the clear hierarchy of a workshop parts index. A warm near-white canvas, charcoal lettering, thin rules, and small pale-blue or foil-gold locator marks keep the catalogue and printer details easy to scan.

The application remains an operating surface for a self-hosted catalogue and print workflow. Its navigation stays compact, controls keep familiar behavior, and content is arranged in clear working groups. The public landing page's full-width register rows inform the visual language, while app pages retain the denser layouts their tasks need.

**Key Characteristics:**
- Warm near-white surfaces with charcoal text and restrained blue and gold accents.
- Almarai typography with a bold, compact heading hierarchy.
- Fine rules and modest corner radii establish structure; depth is used sparingly.
- Dense desktop work areas reflow to a horizontal navigation on narrow screens.
- No origami, folded-sheet geometry, crease illustrations, or packet artwork.

## Colors

The palette pairs warm near-white and charcoal with pale-blue and foil-gold index marks; semantic status colors remain reserved for operational meaning.

### Primary
- **Index Blue** (`{colors.blue}`): Active navigation locator and restrained workflow emphasis.
- **Marker Gold** (`{colors.gold}`): Brand punctuation, version markers, and selected notification emphasis; use sparingly.

### Neutral
- **Paper** (`{colors.paper}`): Main application canvas.
- **White Surface** (`{colors.surface}`): Header, controls, and content panels.
- **Warm Register** (`{colors.surface-alt}`): Secondary surface fill and quiet hover state.
- **Charcoal Ink** (`{colors.ink}`): Primary text and filled actions.
- **Soft Graphite** (`{colors.muted}`): Supporting copy and placeholders.
- **Dust Gray** (`{colors.subtle}`): Tertiary labels.
- **Index Rule** (`{colors.line}`): Structural dividers and subtle outlines.
- **Warm Gray** (`{colors.line-strong}`): Stronger component edges and quiet separators.

### Named Rules
**The Locator Color Rule.** Blue and gold identify active navigation, selected states, and small brand details. Keep reading text in the dark ink roles. Green, amber, and red communicate success, warning, and danger states only.

## Typography

- **Display Font:** Almarai (with ui-sans-serif, system-ui, sans-serif fallback)
- **Body Font:** Almarai (with ui-sans-serif, system-ui, sans-serif fallback)
- **Label/Mono Font:** No separate mono face is established.

**Character:** Almarai gives the interface a rounded, human sans voice while its compact line-height and heavier headings keep operational screens direct. Labels use measured tracking for navigation, section headings, and status.

### Hierarchy
- **Display** (720, responsive clamp from 2rem to 3.35rem, 1.05): Route headings; the catalogue heading uses a larger 3.5rem override.
- **Title** (670, 1.35rem, 1.25): Section headings.
- **Body** (400, 0.97rem, 1.5): Explanatory and supporting text.
- **Label** (650, 0.58–0.9rem, tracked where navigational): Brand descriptor, field labels, and compact navigation.

### Named Rules
**The Work Before Accent Rule.** Keep hierarchy and meaning clear; blue and gold mark state after the content is already understandable.

## Layout

The application uses a persistent top identity bar and a left navigation rail beside a flexible content region. The main content is capped at 1600px and uses responsive outer padding. Catalogue controls lead into a three-column model shelf on wide screens, with cards preserving real model names, creators, thumbnails, and available catalogue metadata. The rail groups routes and, when present, collection and tag filters. The landing page's open register rows do not replace this task-specific information architecture.

At narrow widths, the rail becomes a horizontally scrollable route bar and content padding tightens. Catalogue controls and working forms reflow into fewer columns; preserve readable labels and prevent page-level horizontal overflow. Spacing is based on a compact 4/8/16/24/32px rhythm, with larger gaps between distinct tasks than within control groups.

## Elevation & Depth

Depth is primarily structural: tonal surface changes and thin rules separate the header, navigation, controls, and working content. Elevated dialogs may use a soft shadow; ordinary cards and panels remain flat. Hover and focus states communicate interaction rather than adding persistent decoration.

### Shadow Vocabulary
- **Dialog** (`0 1.2rem 3rem rgb(32 36 33 / 18%)`): Confirmation overlays that must separate from the page.

### Named Rules
**The Flat Working Surface Rule.** Keep routine catalogue and settings surfaces flat; reserve a soft shadow for an overlay that actually sits above the page.

## Shapes

Forms are precise and compact: controls use 4px corners, buttons 5px, model cards about 11px, and larger filter panels about 13px. Dividers are thin and neutral. Pills are reserved for compact status or filter chips. Small square and line marks act as index locators; interface containers stay geometrically simple.

## Components

### Buttons
- **Character:** Direct and tactile, with a dark filled primary action and a quiet outlined alternative.
- **Shape:** Compact corners (5px primary, 4px secondary), at least 42px high.
- **Primary:** Charcoal fill, paper text, 0.65rem by 1rem padding.
- **Secondary:** White fill, charcoal text, stronger gray edge.
- **Hover / Focus:** Darken filled buttons; secondary buttons gain a warm surface fill. Keyboard focus uses a 3px blue outline with a 2px offset.
- **Disabled:** Keep the control visible with reduced opacity and an unavailable cursor.

### Chips
- **Style:** Compact status or filter labels use soft gold or neutral fills, charcoal text, and pill geometry where appropriate.
- **State:** Selected navigation uses a pale gray field and blue inset marker; notification counts use a gold wash.

### Cards / Containers
- **Corner Style:** Modest 11.2px model-card corners and 12.8px filter panels; smaller controls use 4–5px.
- **Background:** White over paper, with borders in Index Rule.
- **Shadow Strategy:** Flat by default; elevated overlays use the shadow described above.
- **Border:** One thin neutral border; hover may shift the edge toward index blue.
- **Internal Padding:** Common card padding is 1.25rem; compact controls use the 4/8/16px rhythm.

### Inputs / Fields
- **Style:** White field, charcoal text, 1px warm-gray border, 4px corners, and 42px minimum height.
- **Focus:** 3px index-blue outline with 2px offset.
- **Error / Disabled:** Errors use danger ink and a pale red wash; disabled actions reduce opacity without disappearing.

### Navigation
- **Style:** The desktop rail is a quiet paper-adjacent surface with compact drawn line icons. Active routes use a pale gray fill, stronger text, and a narrow blue inset marker.
- **Mobile:** The rail becomes a horizontal route strip above the content; active route treatment remains visible.

### Index Markers

Small blue and gold squares, rules, and state markers provide orientation in navigation and status labels. They remain geometric and subordinate to the information they locate.

## Do's and Don'ts

### Do:
- **Do** preserve the near-white, charcoal, index-blue, warm-gray, and marker-gold roles in new app screens.
- **Do** use Almarai for interface text and keep supporting copy in a readable size and contrast.
- **Do** prefer thin rules and surface tone for working groups; reserve shadows for truly elevated overlays.
- **Do** keep forms and catalogue controls usable at narrow widths.
- **Do** use status colors only for their matching success, warning, and danger meanings.

### Don't:
- **Don't** invent model, printer, version, or print-history content for visual fullness.
- **Don't** add origami, folded-sheet geometry, paper creases, or packet imagery.
- **Don't** use blue or gold as large competing fills across routine work screens.
- **Don't** introduce a second display typeface or a monospace face as generic technical decoration.
