# J1b.1 — Journal UI visual system

This document records the approved KcalCue journal visual direction implemented on the J1b.1 refresh branch.

## Product feeling

KcalCue should feel like a calm, personal meal journal rather than a clinical dashboard or an aggressive diet app.

The visual hierarchy prioritizes:

1. what the user ate;
2. when they ate it;
3. the confirmed nutrition state;
4. an optional journal note;
5. AI provenance only when the user asks to inspect it.

AI remains an optional accelerator. Manual logging is still the primary action.

## Design tokens

The journal shell owns a small local token set so the refresh does not unexpectedly restyle unrelated KcalCue surfaces. Inside the shell, inherited app tokens (`--green`, `--ink`, `--paper`, `--content`) follow this palette, so the embedded editor does not keep a sage primary.

Core palette:

- page: warm cream `#f7f1e6`;
- surface: off-white `#fffdf9`;
- soft surface: warm neutral `#f4ece3`;
- warm surface: pale peach `#fbe8d6`;
- primary: muted terracotta `#a15b42`, pressed `#7d4330`, wash `#f3e2d6`;
- accent: warm clay `#94523c`, wash `#f6e3d6`;
- text: dark warm brown `#2f261f`, soft `#5e4b40`, muted `#7a6358`;
- success: restrained green `#4f7d5c`, used only for the synced status dot;
- warning `#8b6224` on `#fff0d7`;
- error `#8f2d32`, kept redder than the terracotta primary;
- warning / error remain clearly differentiated and never rely on colour alone.

Desktop content columns use `--journal-column: 760px`. Layout tokens use a restrained radius and a light warm-brown shadow scale rather than a separate one-off value for every card.

## Cartoon food stamps

The app uses small decorative food stamps around journal hero and empty-state surfaces.

Rules:

- decorative only;
- aria-hidden;
- low opacity and reduced saturation;
- sparse placement;
- never directly behind dense text;
- never used as the only indication of meal type or state.

Meal cards also use one small decorative meal-type stamp. The accompanying text still provides the actual meal type.

The current implementation uses KcalCue-owned lightweight line-SVG food marks rather than platform emoji, so the decorative language remains consistent across iOS, Android, Windows and desktop browsers. They stay local to the journal UI and can be refined later without changing layout or semantics.

## Today

Today uses:

- a warm peach-cream hero card;
- clear date context;
- one strong manual-entry action;
- one secondary AI-photo action;
- a compact daily summary;
- breakfast / lunch / dinner / snack sections;
- calmer meal cards with time, confirmed meal name, optional note and calorie status.

The daily summary remains descriptive. Unknown / partial coverage copy is not hidden for aesthetics.

## New / editor

The editor separates:

- date / time / meal type;
- optional journal note;
- manual calorie control;
- food / portion editor;
- uncertainty and provenance;
- save actions.

Journal note styling is deliberately softer than structured food or nutrition controls.

## History

History shares the same journal language as Today while preserving its existing date filter and edit/delete actions.

Date groups use clearer hierarchy and saved-meal cards use the same meal card system as Today.

This refresh does not implement the later J1c search/filter expansion.

## Bottom navigation

The bottom navigation is a floating app-style bar:

- quieter Today and History tabs;
- a slightly stronger terracotta Add action in the centre;
- no green floating island.

The Add action remains the visual centre and continues to start manual logging. Side tabs use a light peach wash only for the current page.

A future Insights destination must not appear until J2 exists.

## Responsive and accessibility rules

Acceptance baseline:

- 375×812 mobile;
- 1280×900 desktop;
- no horizontal overflow;
- minimum 44px interactive targets;
- visible keyboard focus;
- safe-area-aware fixed navigation;
- long meal names and notes wrap;
- food stamps are aria-hidden;
- states remain understandable without decorative colour or artwork.

## Scope

J1b.1 changes presentation and hierarchy only.

It does not change:

- meal schema;
- journal-note contract;
- calorie or nutrition calculations;
- AI model/provider;
- Firebase / Cloud Run configuration;
- persistent photo Storage;
- allowlist;
- billing or signup.
