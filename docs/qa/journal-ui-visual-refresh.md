# J1b.1 — Journal UI visual refresh acceptance

## Visual contract

The refresh must preserve J1b behaviour while presenting a coherent warm journal interface.

Required visual checkpoints:

- branded header and compact sync state;
- warm Today hero;
- manual logging visually primary;
- AI photo action visually secondary;
- restrained decorative food stamps;
- compact daily summary;
- journal-style meal cards;
- distinct optional note treatment;
- clearer editor grouping;
- floating safe-area-aware bottom navigation;
- History uses the same card and spacing system.

## Functional invariants

The visual refresh must not change:

- manual / AI entry semantics;
- note save / clear / reload behaviour;
- outbox or blocked-save behaviour;
- account isolation;
- nutrition calculations;
- uncertainty / unknown-data wording;
- photo privacy behaviour;
- production runtime configuration.

## Required checks

Before merge:

- focused MealJournal UI / notice / race suites;
- affected KcalCueApp / ResultView component suites;
- lint;
- typecheck;
- full unit / integration suite;
- production build;
- full Playwright journal suite;
- 375×812 overflow check;
- 1280×900 overflow check;
- visual inspection of Today and editor screenshots;
- diff / secret / config scan.

Production release is a separate owner-authorized gate.
