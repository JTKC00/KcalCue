# J1b.2 — Journal UI Visual Refresh

This document records the implementation acceptance target for the KcalCue visual refresh.

## Visual principles

KcalCue should feel like a calm everyday nutrition journal, not a clinical dashboard or aggressive fitness tracker.

The implementation uses a small coherent visual system:

- warm cream page background;
- soft white journal surfaces;
- deep sage primary;
- muted terracotta accent;
- dark green-charcoal text;
- rounded surfaces with restrained shadows;
- generous spacing;
- app-like persistent bottom navigation.

## Decorative food stamps

The Journal shell includes lightweight decorative SVG motifs for:

- rice bowl;
- apple;
- cup / tea;
- toast.

They are:

- decorative only;
- aria-hidden;
- low contrast;
- sparse;
- excluded from dense information blocks;
- never required to understand an action or nutrition result.

## Today

Today is the main product home.

Hierarchy:

1. warm journal hero;
2. manual logging primary CTA;
3. AI photo secondary CTA;
4. daily summary;
5. meal-type groups;
6. meal cards.

Confirmed food names remain visually stronger than AI provenance or uncertainty details.

An empty day does not display 0 kcal. It displays “未記錄” and reminds the user that unknown does not mean zero.

## New / Editor

The New screen uses two large entry cards:

- manual meal journal entry;
- AI-assisted photo entry.

Manual remains the primary path.

The editor groups meal metadata and journal note into calmer journal surfaces while preserving all existing J1a/J1b data behavior.

The existing food/portion editor, nutrition uncertainty, manual kcal correction, AI evidence and save-review warning remain functional and visible.

## History

History keeps the existing date filter behavior but uses:

- stronger date grouping;
- a restrained timeline marker;
- cleaner card rhythm;
- journal-note presentation consistent with Today.

No J1c search/filter expansion is included.

## Bottom navigation

The bottom navigation remains:

- 今日;
- 新增;
- 歷史.

The central Add action is visually stronger but keeps normal button semantics and an explicit accessible name.

No placeholder Insights tab is shown before J2 exists.

## Responsive and accessibility rules

Validated targets include:

- 375×812 mobile;
- desktop baseline;
- no horizontal overflow;
- 44px or larger primary interaction targets;
- visible keyboard focus;
- safe-area-aware bottom navigation;
- long meal names and multiline notes wrapping safely;
- decorative stamps carrying no meaning;
- reduced-motion preference disabling decorative interaction movement.

On mobile, duplicate CTA buttons inside the empty-state card are hidden because the Today hero and central Add navigation already provide equivalent actions. This prevents the floating navigation from competing with duplicate controls.

## Functional invariants

This visual refresh must not change:

- meal schema;
- journal-note normalization or 500-code-point contract;
- repository/outbox behavior;
- account isolation;
- Firebase/Cloud Run runtime configuration;
- AI provider or model;
- Storage behavior;
- billing/public signup;
- uncertainty or partial-nutrition semantics.

## Downstream

After the app visual refresh is accepted and released, JTKC00/Snugzap#16 should align the public KcalCue product page with this approved visual language.
