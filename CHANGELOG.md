# Changelog

## 0.1.2 - 2026-10-25

- Build large JSON trees and raw-source sections lazily, with paging and bounded outlines/search results. Based on the reviewed source proposal in PR #2.
- Add DOM regressions for initial render size, paging, lazy raw source, searches outside the rendered page and JSONL pointer preservation.
- Keep production builds platform independent.

All notable changes to JSON Viewer are documented here.

## 0.1.1 - 2026-06-07

- Harden raw source tokenization to avoid community review regex warnings.

## 0.1.0 - 2026-06-07

- Initial public release.
- Add read-only `.json`, `.jsonl`, and `.ndjson` file view.
- Add tree rendering for objects, arrays, strings, numbers, booleans, nulls, and parse errors.
- Add JSONL/NDJSON line-by-line parsing with per-line errors.
- Add filter/search, outline navigation, copy raw JSON, copy JSON Pointer, expand/collapse, and raw source highlighting.
