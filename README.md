<p align="center">
  <img src="assets/hero.svg" alt="JSON Viewer for Obsidian" width="100%">
</p>

<p align="center">
  <a href="https://github.com/viggomeesters/obsidian-json-viewer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/viggomeesters/obsidian-json-viewer?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="Obsidian 1.5.0+" src="https://img.shields.io/badge/Obsidian-1.5.0%2B-7c3aed?style=flat-square">
  <img alt="Read-only" src="https://img.shields.io/badge/mode-read--only-0f766e?style=flat-square">
</p>

# JSON Viewer

JSON Viewer is a read-only Obsidian plugin for browsing `.json`, `.jsonl`, and `.ndjson` files as structured data. It is built for configuration files, logs, exports, API payloads, datasets, and agent/runtime artifacts that are awkward to inspect as raw text.

![JSON Viewer preview](assets/screenshot.svg)

## Features

- Opens `.json`, `.jsonl`, and `.ndjson` files in a dedicated Obsidian view.
- Shows objects, arrays, strings, numbers, booleans, nulls, and parse errors.
- Parses JSONL/NDJSON record-by-record and reports errors per line.
- Filters the tree by key, value, or JSON Pointer path.
- Provides a right-side outline for fast navigation through large structures.
- Includes expand/collapse controls, copy raw JSON, and copy JSON Pointer buttons.
- Shows raw JSON/JSONL with lightweight syntax highlighting and line numbers.
- Stays read-only by design: it never writes back to your data files.

## JSONL behavior

JSONL files can be very large. JSON Viewer parses non-empty lines independently and renders the first 1,000 valid records to avoid flooding Obsidian with a huge DOM tree. Additional valid records are counted and reported. Invalid records are shown as line-specific parse errors.

## Privacy and clipboard behavior

JSON Viewer does not make network requests and does not send vault content to external services. It writes to the system clipboard only when you explicitly click a copy button, such as copying raw JSON or a JSON Pointer path. It does not read clipboard contents.

## Why read-only?

JSON and JSONL files are often generated artifacts or source-of-truth data. JSON Viewer intentionally does not write to disk, so it cannot reformat, reorder, truncate, or corrupt data files.

## Installation

### Community plugin directory

Install from the [Obsidian Community directory](https://community.obsidian.md/plugins/json-viewer) or search for JSON Viewer in **Settings → Community plugins → Browse**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/viggomeesters/obsidian-json-viewer/releases/latest).
2. Create this folder in your vault: `.obsidian/plugins/json-viewer/`.
3. Put the downloaded files in that folder.
4. Reload Obsidian.
5. Enable **JSON Viewer** in **Settings -> Community plugins**.

### BRAT installation

For beta testing, install the plugin with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using this repository URL:

```text
https://github.com/viggomeesters/obsidian-json-viewer
```

## Usage

Open any `.json`, `.jsonl`, or `.ndjson` file in your vault. Obsidian will open it with JSON Viewer.

Use the toolbar to:

- filter visible nodes
- expand or collapse the tree
- copy the raw JSON source
- copy individual JSON Pointer paths from tree rows

Use the outline panel to jump through large files quickly.

## Development

```bash
npm install
npm run build
npx tsc --noEmit
```

For local development, copy or symlink this repository into `.obsidian/plugins/json-viewer/` inside an Obsidian vault.

## Release process

Obsidian installs community plugin files from GitHub releases. For each release:

1. Update `manifest.json`, `package.json`, and `versions.json`.
2. Run `npm install`, `npm run build`, and `npx tsc --noEmit`.
3. Create a GitHub release whose tag exactly matches `manifest.json.version`.
4. Attach `main.js`, `manifest.json`, and `styles.css` as release assets.

## Community directory submission

JSON Viewer is listed in the [Obsidian Community directory](https://community.obsidian.md/plugins/json-viewer).

Release updates are built and checked locally, then uploaded to GitHub with a tag matching `manifest.json.version`. The official Community source preview and release review are checked separately.

Official references:

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Obsidian releases repository](https://github.com/obsidianmd/obsidian-releases)

## License

[MIT](LICENSE)
