import {
  Notice,
  Plugin,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const VIEW_TYPE_JSON_VIEWER = "json-viewer";
const JSON_EXTENSIONS = ["json", "jsonl", "ndjson"];
const OUTLINE_MAX_DEPTH = 4;
const OUTLINE_ITEM_LIMIT = 1000;
const JSONL_RENDER_LIMIT = 1000;
// Documents up to this many nodes open fully expanded; larger ones render lazily.
const EAGER_EXPAND_NODE_LIMIT = 2000;
const CHILD_PAGE_SIZE = 250;
const EXPAND_ALL_ROW_LIMIT = 5000;
const FILTER_MATCH_LIMIT = 1000;
const FILTER_DEBOUNCE_MS = 200;
const RAW_PAGE_LINES = 2000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface OutlineItem {
  label: string;
  path: string;
  depth: number;
  type: "object" | "array" | "jsonl";
  count: number;
}

interface JsonParseError {
  label: string;
  message: string;
  line?: number;
  column?: number;
}

interface JsonlRecord {
  line: number;
  value: JsonValue;
}

interface TreeNode {
  label: string;
  path: string;
  value: JsonValue;
}

interface JsonDocument {
  mode: "json" | "jsonl";
  roots: TreeNode[];
  errors: JsonParseError[];
  skippedRecords: number;
}

interface BranchState {
  node: TreeNode;
  keys: string[] | null;
  // Indexes of the children that survive the active filter; null renders every child.
  visibleChildren: number[] | null;
  rendered: number;
  more: HTMLElement | null;
}

interface FilterResult {
  matches: number;
  truncated: boolean;
}

export default class JsonViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_JSON_VIEWER,
      (leaf) => new JsonViewerView(leaf),
    );
    this.registerExtensions(JSON_EXTENSIONS, VIEW_TYPE_JSON_VIEWER);

    this.addCommand({
      id: "open-current-json-in-viewer",
      name: "Open current JSON file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isJsonFile(file)) return false;

        if (!checking) {
          void this.openJsonFile(file);
        }
        return true;
      },
    });
  }

  async openJsonFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_JSON_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }
}

class JsonViewerView extends TextFileView {
  private filterTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_JSON_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "JSON viewer";
  }

  getIcon(): string {
    return "braces";
  }

  setViewData(data: string): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.cancelFilter();
    this.data = "";
    this.contentEl.empty();
  }

  async onClose(): Promise<void> {
    this.cancelFilter();
  }

  private cancelFilter(): void {
    if (this.filterTimer !== null) {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
  }

  private render(): void {
    this.cancelFilter();
    const container = this.contentEl;
    container.empty();
    container.addClass("json-viewer");

    const header = container.createDiv({ cls: "json-viewer__header" });
    const title = header.createDiv({ cls: "json-viewer__title" });
    title.createDiv({
      cls: "json-viewer__filename",
      text: this.file?.name ?? "JSON file",
    });
    title.createDiv({
      cls: "json-viewer__path",
      text: this.file?.path ?? "",
    });

    const toolbar = header.createDiv({ cls: "json-viewer__toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "json-viewer__search" });
    setIcon(searchWrap.createSpan({ cls: "json-viewer__search-icon" }), "search");
    const searchInput = searchWrap.createEl("input", {
      attr: {
        "aria-label": "Filter JSON tree",
        placeholder: "Filter",
        spellcheck: "false",
        type: "search",
      },
    });
    const expandButton = createButton(toolbar, "chevrons-down", "Expand all");
    const collapseButton = createButton(toolbar, "chevrons-up", "Collapse all");
    const rawButton = createButton(toolbar, "file-code-2", "Copy raw JSON");

    rawButton.addEventListener("click", () => {
      void copyToClipboard(this.data, "JSON copied");
    });

    const document = parseJsonDocument(this.data, this.file?.extension ?? "json");
    if (document.errors.length > 0) {
      renderParseErrors(container, document.errors);
    }

    const body = container.createDiv({ cls: "json-viewer__body" });
    const main = body.createDiv({ cls: "json-viewer__main" });

    if (document.mode === "jsonl") {
      renderJsonlSummary(main, document);
    }

    const filterStatus = main.createDiv({ cls: "json-viewer__filter-status json-viewer__hidden" });
    const treeEl = main.createDiv({ cls: "json-viewer__tree" });
    const eager = countNodes(document.roots, EAGER_EXPAND_NODE_LIMIT) <= EAGER_EXPAND_NODE_LIMIT;
    const tree = new JsonTree(treeEl, document.roots, eager);

    const outline = collectOutline(document.roots, document.mode);

    const runFilter = (): void => {
      this.filterTimer = null;
      const query = searchInput.value;
      const result = tree.setFilter(query);
      filterOutline(outlineButtons, outline.items, query);
      renderFilterStatus(filterStatus, query, result);
    };

    const outlineButtons = renderOutline(body, outline.items, outline.truncated, (path) => {
      let target = tree.reveal(path);
      if (!target && searchInput.value) {
        searchInput.value = "";
        this.cancelFilter();
        runFilter();
        target = tree.reveal(path);
      }
      if (!target) return;
      if (target.instanceOf(HTMLDetailsElement)) target.open = true;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.addClass("json-viewer__pulse");
      window.setTimeout(() => target.removeClass("json-viewer__pulse"), 900);
    });

    searchInput.addEventListener("input", () => {
      this.cancelFilter();
      this.filterTimer = window.setTimeout(runFilter, FILTER_DEBOUNCE_MS);
    });

    expandButton.addEventListener("click", () => {
      if (!tree.expandAll()) {
        new Notice(`Expanded the first ${EXPAND_ALL_ROW_LIMIT} rows; this file is too large to expand fully.`);
      }
    });

    collapseButton.addEventListener("click", () => {
      tree.collapseAll();
    });

    renderRaw(main, this.data, document.mode);
  }
}

/**
 * Renders the tree on demand: a branch's children are built the first time it opens, and
 * large branches are built in pages, so a large file costs only the rows actually on screen.
 */
class JsonTree {
  private readonly elements = new Map<string, HTMLElement>();
  private readonly branches = new WeakMap<HTMLElement, BranchState>();
  private readonly copyTemplate: HTMLElement;
  private matches: Set<string> | null = null;
  private ancestors: Set<string> | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly roots: TreeNode[],
    private readonly eager: boolean,
  ) {
    this.copyTemplate = createButton(createDiv(), "copy", "Copy JSON Pointer");
    this.copyTemplate.addClass("json-viewer__copy");

    container.addEventListener("click", (event) => {
      const target = event.target as Element;

      const copy = target.closest(".json-viewer__copy");
      if (copy) {
        event.preventDefault();
        event.stopPropagation();
        const path = copy.closest<HTMLElement>("[data-path]")?.dataset.path ?? "";
        void copyToClipboard(path || "/", `Copied ${path || "/"}`);
        return;
      }

      const more = target.closest(".json-viewer__more");
      const branch = more?.closest<HTMLElement>("details");
      const state = branch ? this.branches.get(branch) : undefined;
      if (branch && state) {
        this.renderChildPage(branch, state, 0);
      }
    });

    this.render();
  }

  setFilter(query: string): FilterResult {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      this.matches = null;
      this.ancestors = null;
      this.render();
      return { matches: 0, truncated: false };
    }

    const matches = new Set<string>();
    const ancestors = new Set<string>();
    const matchPaths = needle.includes("/");
    let truncated = false;

    const visit = (value: JsonValue, path: string, label: string): void => {
      if (truncated) return;
      if (path !== "" && nodeMatches(value, path, label, needle, matchPaths)) {
        if (matches.size >= FILTER_MATCH_LIMIT) {
          truncated = true;
          return;
        }
        matches.add(path);
        addAncestorPaths(path, ancestors);
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          visit(value[index], `${path}/${index}`, `[${index}]`);
        }
      } else if (isObject(value)) {
        for (const key of Object.keys(value)) {
          visit(value[key], `${path}/${escapeJsonPointerSegment(key)}`, key);
        }
      }
    };

    this.roots.forEach((root) => visit(root.value, root.path, root.label));
    this.matches = matches;
    this.ancestors = ancestors;
    this.render();
    return { matches: matches.size, truncated };
  }

  /** Opens and renders every branch on the way to `path`; returns its element, or null if it is not shown. */
  reveal(path: string): HTMLElement | null {
    const root = this.roots.find((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`));
    if (!root) return null;

    let currentPath = root.path;
    let element = this.elements.get(currentPath);
    const segments = path.slice(root.path.length).split("/").slice(1);

    for (const segment of segments) {
      if (!element) return null;
      const state = this.branches.get(element);
      if (!state) return null;
      const index = childPosition(state, segment);
      if (index < 0) return null;

      if (element.instanceOf(HTMLDetailsElement)) element.open = true;
      while (state.rendered <= index) {
        if (this.renderChildPage(element, state, 0) === 0) break;
      }

      currentPath = `${currentPath}/${segment}`;
      element = this.elements.get(currentPath);
    }

    return element ?? null;
  }

  /** Expands breadth-first until EXPAND_ALL_ROW_LIMIT new rows are built; returns false if it stopped early. */
  expandAll(): boolean {
    let budget = EXPAND_ALL_ROW_LIMIT;
    const queue: HTMLElement[] = [];
    this.roots.forEach((root) => {
      const element = this.elements.get(root.path);
      if (element) queue.push(element);
    });

    for (let head = 0; head < queue.length; head += 1) {
      const details = queue[head];
      const state = this.branches.get(details);
      if (!state || !details.instanceOf(HTMLDetailsElement)) continue;

      details.open = true;
      while (state.rendered < childCount(state)) {
        if (budget <= 0) return false;
        budget -= this.renderChildPage(details, state, 0);
      }

      for (const child of Array.from(details.children)) {
        if (child.instanceOf(HTMLDetailsElement)) queue.push(child);
      }
    }

    return true;
  }

  collapseAll(): void {
    this.container.querySelectorAll("details").forEach((detail) => {
      detail.open = false;
    });
  }

  private render(): void {
    this.container.empty();
    this.elements.clear();

    if (this.roots.length === 0) {
      this.container.createDiv({
        cls: "json-viewer__empty",
        text: "This JSON file is empty.",
      });
      return;
    }

    const filtering = this.ancestors !== null;
    const roots = filtering
      ? this.roots.filter((root) => this.ancestors?.has(root.path) || this.matches?.has(root.path))
      : this.roots;

    if (roots.length === 0) {
      this.container.createDiv({ cls: "json-viewer__empty", text: "No matches." });
      return;
    }

    let openDepth = 0;
    if (!filtering) {
      openDepth = this.eager ? Infinity : roots.length === 1 ? 1 : 0;
    }
    roots.forEach((root) => this.renderNode(this.container, root, openDepth, filtering));
  }

  private renderNode(parent: HTMLElement, node: TreeNode, openDepth: number, filtering: boolean): void {
    const { value, path, label } = node;
    if (!Array.isArray(value) && !isObject(value)) {
      this.renderScalar(parent, node);
      return;
    }

    const keys = Array.isArray(value) ? null : Object.keys(value);
    const type = Array.isArray(value) ? "array" : "object";
    const meta = keys ? `${keys.length} keys` : `${(value as JsonValue[]).length} items`;

    const details = parent.createEl("details", {
      cls: `json-viewer__branch json-viewer__type-${type}`,
    });
    details.dataset.path = path;

    const summary = details.createEl("summary", { cls: "json-viewer__row" });
    summary.createSpan({ cls: "json-viewer__key", text: label });
    summary.createSpan({ cls: "json-viewer__badge", text: type });
    summary.createSpan({ cls: "json-viewer__meta", text: meta });
    summary.appendChild(this.copyTemplate.cloneNode(true));
    if (this.matches?.has(path)) summary.addClass("json-viewer__match");

    // Under a filter only branches leading to a match are narrowed and opened; a branch that
    // matches by itself stays closed and shows all of its children when opened.
    const narrowed = filtering && (this.ancestors?.has(path) ?? false);
    const state: BranchState = { node, keys, visibleChildren: null, rendered: 0, more: null };
    if (narrowed) {
      const visibleChildren: number[] = [];
      const total = childCount(state);
      for (let index = 0; index < total; index += 1) {
        const childPath = childNode(state, index).path;
        if (this.ancestors?.has(childPath) || this.matches?.has(childPath)) visibleChildren.push(index);
      }
      state.visibleChildren = visibleChildren;
    }

    this.elements.set(path, details);
    this.branches.set(details, state);

    details.addEventListener("toggle", () => {
      if (details.open && state.rendered === 0) this.renderChildPage(details, state, 0);
    });

    if (openDepth > 0 || narrowed) {
      details.open = true;
      this.renderChildPage(details, state, openDepth - 1);
    }
  }

  /** Renders the next page of a branch's children (all of them under a filter); returns how many rows it built. */
  private renderChildPage(details: HTMLElement, state: BranchState, openDepth: number): number {
    const total = childCount(state);
    const narrowed = state.visibleChildren !== null;
    const end = narrowed ? total : Math.min(total, state.rendered + CHILD_PAGE_SIZE);

    state.more?.remove();
    state.more = null;

    for (let position = state.rendered; position < end; position += 1) {
      this.renderNode(details, childNode(state, position), openDepth, narrowed);
    }
    const built = end - state.rendered;
    state.rendered = end;

    if (end < total) {
      const remaining = total - end;
      state.more = details.createEl("button", {
        cls: "json-viewer__more",
        text: `Show ${Math.min(CHILD_PAGE_SIZE, remaining)} more (${remaining} remaining)`,
        attr: { type: "button" },
      });
    }

    return built;
  }

  private renderScalar(parent: HTMLElement, node: TreeNode): void {
    const type = valueType(node.value);
    const row = parent.createDiv({ cls: "json-viewer__row json-viewer__leaf" });
    row.addClass(`json-viewer__type-${type}`);
    row.dataset.path = node.path;
    row.createSpan({ cls: "json-viewer__key", text: node.label });
    row.createSpan({ cls: "json-viewer__badge", text: type });
    row.createSpan({ cls: "json-viewer__value", text: formatValue(node.value) });
    row.appendChild(this.copyTemplate.cloneNode(true));
    if (this.matches?.has(node.path)) row.addClass("json-viewer__match");
    this.elements.set(node.path, row);
  }
}

function childCount(state: BranchState): number {
  if (state.visibleChildren) return state.visibleChildren.length;
  return state.keys ? state.keys.length : (state.node.value as JsonValue[]).length;
}

/** The child at `position` among the children this branch shows. */
function childNode(state: BranchState, position: number): TreeNode {
  const index = state.visibleChildren ? state.visibleChildren[position] : position;
  const { path, value } = state.node;
  if (state.keys) {
    const key = state.keys[index];
    return {
      label: key,
      path: `${path}/${escapeJsonPointerSegment(key)}`,
      value: (value as { [key: string]: JsonValue })[key],
    };
  }
  return { label: `[${index}]`, path: `${path}/${index}`, value: (value as JsonValue[])[index] };
}

/** Where the child named by a JSON Pointer segment sits among the children this branch shows, or -1. */
function childPosition(state: BranchState, segment: string): number {
  let index: number;
  if (state.keys) {
    index = state.keys.indexOf(unescapeJsonPointerSegment(segment));
  } else {
    index = /^\d+$/.test(segment) ? Number(segment) : -1;
    if (index >= (state.node.value as JsonValue[]).length) index = -1;
  }
  if (index < 0 || !state.visibleChildren) return index;
  return state.visibleChildren.indexOf(index);
}

function nodeMatches(value: JsonValue, path: string, label: string, needle: string, matchPaths: boolean): boolean {
  if (label.toLowerCase().includes(needle)) return true;
  if (matchPaths && path.toLowerCase().includes(needle)) return true;
  if (Array.isArray(value) || isObject(value)) return false;
  return formatValue(value).toLowerCase().includes(needle);
}

/** Counts nodes, stopping once the count passes `limit`. */
function countNodes(roots: TreeNode[], limit: number): number {
  let count = 0;
  const stack: JsonValue[] = roots.map((root) => root.value);
  while (stack.length > 0 && count <= limit) {
    const value = stack.pop() as JsonValue;
    count += 1;
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (isObject(value)) {
      for (const key of Object.keys(value)) stack.push(value[key]);
    }
  }
  return count;
}

function parseJsonDocument(data: string, extension: string): JsonDocument {
  if (extension === "jsonl" || extension === "ndjson") {
    return parseJsonl(data);
  }
  return parseJson(data);
}

function parseJson(data: string): JsonDocument {
  const trimmed = data.trim();
  if (!trimmed) {
    return { mode: "json", roots: [], errors: [], skippedRecords: 0 };
  }

  try {
    return {
      mode: "json",
      roots: [{ label: "root", path: "", value: JSON.parse(data) as JsonValue }],
      errors: [],
      skippedRecords: 0,
    };
  } catch (error) {
    return {
      mode: "json",
      roots: [],
      errors: [formatJsonParseError(error, data, "JSON parse error")],
      skippedRecords: 0,
    };
  }
}

function parseJsonl(data: string): JsonDocument {
  const roots: TreeNode[] = [];
  const errors: JsonParseError[] = [];
  const records: JsonlRecord[] = [];
  const lines = data.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    try {
      records.push({
        line: index + 1,
        value: JSON.parse(line) as JsonValue,
      });
    } catch (error) {
      errors.push(formatJsonlParseError(error, line, index + 1));
    }
  });

  records.slice(0, JSONL_RENDER_LIMIT).forEach((record, index) => {
    roots.push({
      label: `line ${record.line}`,
      path: `/${index}`,
      value: record.value,
    });
  });

  return {
    mode: "jsonl",
    roots,
    errors,
    skippedRecords: Math.max(0, records.length - JSONL_RENDER_LIMIT),
  };
}

function renderParseErrors(parent: HTMLElement, errors: JsonParseError[]): void {
  const box = parent.createDiv({ cls: "json-viewer__errors" });
  box.createDiv({ cls: "json-viewer__errors-title", text: "Parse errors" });
  errors.forEach((error) => {
    const location = error.line
      ? ` (${error.label}, line ${error.line}${error.column ? `, column ${error.column}` : ""})`
      : ` (${error.label})`;
    box.createDiv({ cls: "json-viewer__error", text: `${error.message}${location}` });
  });
}

function renderJsonlSummary(parent: HTMLElement, document: JsonDocument): void {
  const summary = parent.createDiv({ cls: "json-viewer__jsonl-summary" });
  summary.createSpan({
    cls: "json-viewer__jsonl-pill",
    text: `${document.roots.length} rendered records`,
  });
  if (document.skippedRecords > 0) {
    summary.createSpan({
      cls: "json-viewer__jsonl-note",
      text: `${document.skippedRecords} additional records skipped for performance`,
    });
  }
}

function renderFilterStatus(parent: HTMLElement, query: string, result: FilterResult): void {
  parent.toggleClass("json-viewer__hidden", !query.trim());
  if (result.truncated) {
    parent.setText(`Showing the first ${FILTER_MATCH_LIMIT} matches`);
  } else {
    parent.setText(result.matches === 1 ? "1 match" : `${result.matches} matches`);
  }
}

/** The raw source is built only when its section is first opened, then in pages of RAW_PAGE_LINES. */
function renderRaw(parent: HTMLElement, data: string, mode: "json" | "jsonl"): void {
  const details = parent.createEl("details", { cls: "json-viewer__raw" });
  details.createEl("summary", { text: mode === "jsonl" ? "Raw JSONL" : "Raw JSON" });

  let pre: HTMLElement | null = null;
  let lines: string[] = [];
  let rendered = 0;
  let more: HTMLElement | null = null;

  const renderPage = (): void => {
    if (!pre) return;
    more?.remove();
    more = null;

    const end = Math.min(lines.length, rendered + RAW_PAGE_LINES);
    renderHighlightedLines(pre, lines, rendered, end);
    rendered = end;

    if (end < lines.length) {
      const remaining = lines.length - end;
      more = details.createEl("button", {
        cls: "json-viewer__more",
        text: `Show ${Math.min(RAW_PAGE_LINES, remaining)} more lines (${remaining} remaining)`,
        attr: { type: "button" },
      });
      more.addEventListener("click", renderPage);
    }
  };

  details.addEventListener("toggle", () => {
    if (!details.open || pre) return;
    pre = details.createEl("pre");
    lines = data.split("\n");
    renderPage();
  });
}

function renderOutline(
  parent: HTMLElement,
  items: OutlineItem[],
  truncated: boolean,
  onSelect: (path: string) => void,
): HTMLButtonElement[] {
  const aside = parent.createEl("aside", { cls: "json-viewer__outline" });
  aside.createDiv({ cls: "json-viewer__outline-title", text: "Outline" });

  if (items.length === 0) {
    aside.createDiv({ cls: "json-viewer__outline-empty", text: "No structure" });
    return [];
  }

  const buttons = items.map((item) => {
    const button = aside.createEl("button", {
      cls: "json-viewer__outline-item",
      attr: {
        "aria-label": `Go to ${item.path || "/"}`,
        type: "button",
      },
    });
    button.dataset.path = item.path;
    button.style.setProperty("--json-viewer-outline-depth", String(item.depth));
    button.createSpan({ cls: "json-viewer__outline-label", text: item.label });
    button.createSpan({ cls: "json-viewer__outline-meta", text: `${item.count}` });
    return button;
  });

  if (truncated) {
    aside.createDiv({
      cls: "json-viewer__outline-empty",
      text: `Showing the first ${OUTLINE_ITEM_LIMIT} entries`,
    });
  }

  aside.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(".json-viewer__outline-item");
    if (button) onSelect(button.dataset.path ?? "");
  });

  return buttons;
}

function filterOutline(buttons: HTMLButtonElement[], items: OutlineItem[], query: string): void {
  const needle = query.trim().toLowerCase();
  buttons.forEach((button, index) => {
    const item = items[index];
    const haystack = `${item.path || "/"} ${item.label}`.toLowerCase();
    button.toggleClass("json-viewer__hidden", needle !== "" && !haystack.includes(needle));
  });
}

/**
 * Collects branches in document order up to OUTLINE_MAX_DEPTH, lowering the depth while the
 * outline would exceed OUTLINE_ITEM_LIMIT (never below the first level of children).
 */
function collectOutline(roots: TreeNode[], mode: "json" | "jsonl"): { items: OutlineItem[]; truncated: boolean } {
  const maxDepth = outlineDepth(roots, mode);
  const items: OutlineItem[] = [];
  let truncated = false;

  const walk = (value: JsonValue, path: string, label: string, depth: number): void => {
    if (depth > maxDepth || truncated) return;

    const type = outlineType(value, mode, depth);
    if (!type) return;
    if (items.length >= OUTLINE_ITEM_LIMIT) {
      truncated = true;
      return;
    }

    const childCount = Array.isArray(value) ? value.length : isObject(value) ? Object.keys(value).length : 0;
    items.push({ label, path, depth, type, count: childCount });

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], `${path}/${index}`, `[${index}]`, depth + 1);
      }
    } else if (isObject(value)) {
      for (const key of Object.keys(value)) {
        walk(value[key], `${path}/${escapeJsonPointerSegment(key)}`, key, depth + 1);
      }
    }
  };

  roots.forEach((root) => walk(root.value, root.path, root.label, 0));
  return { items, truncated };
}

function outlineDepth(roots: TreeNode[], mode: "json" | "jsonl"): number {
  let level: JsonValue[] = roots.filter((root) => outlineType(root.value, mode, 0)).map((root) => root.value);
  let total = level.length;

  for (let depth = 1; depth <= OUTLINE_MAX_DEPTH; depth += 1) {
    const next: JsonValue[] = [];
    for (const value of level) {
      const children = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [];
      for (const child of children) {
        if (Array.isArray(child) || isObject(child)) next.push(child);
      }
    }
    total += next.length;
    if (next.length === 0) return OUTLINE_MAX_DEPTH;
    if (total > OUTLINE_ITEM_LIMIT) return Math.max(1, depth - 1);
    level = next;
  }

  return OUTLINE_MAX_DEPTH;
}

function addAncestorPaths(path: string, paths: Set<string>): void {
  let current = path;
  while (current !== "") {
    current = parentPointerPath(current);
    paths.add(current);
  }
}

function parentPointerPath(path: string): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  return path.slice(0, slash);
}

function renderHighlightedLines(parent: HTMLElement, lines: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    const lineEl = parent.createDiv({ cls: "json-viewer__source-line" });
    lineEl.createSpan({ cls: "json-viewer__line-number", text: String(index + 1) });
    const code = lineEl.createSpan({ cls: "json-viewer__source-code" });
    highlightJsonLine(code, lines[index]);
  }
}

function highlightJsonLine(parent: HTMLElement, line: string): void {
  const keyMatch = line.match(/^(\s*)"((?:[^"\\]|\\.)*)"\s*(:)(.*)$/);
  if (keyMatch) {
    parent.appendText(keyMatch[1]);
    parent.createSpan({ cls: "json-viewer__tok-key", text: `"${keyMatch[2]}"` });
    parent.createSpan({ cls: "json-viewer__tok-punctuation", text: keyMatch[3] });
    highlightJsonValue(parent, keyMatch[4]);
    return;
  }

  highlightJsonValue(parent, line);
}

function highlightJsonValue(parent: HTMLElement, value: string): void {
  let cursor = 0;

  while (cursor < value.length) {
    const token = nextJsonToken(value, cursor);
    if (!token) {
      parent.appendText(value[cursor]);
      cursor += 1;
      continue;
    }

    if (token.start > cursor) {
      parent.appendText(value.slice(cursor, token.start));
    }
    parent.createSpan({ cls: tokenClass(token.text), text: token.text });
    cursor = token.end;
  }
}

function nextJsonToken(value: string, start: number): { start: number; end: number; text: string } | null {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  if (index >= value.length) return null;

  const char = value[index];
  if (char === "\"") {
    let end = index + 1;
    while (end < value.length) {
      const current = value[end];
      if (current === "\"" && value[end - 1] !== "\\") break;
      end += 1;
    }
    return { start: index, end: Math.min(value.length, end + 1), text: value.slice(index, end + 1) };
  }

  if ("{}[]:,".includes(char)) {
    return { start: index, end: index + 1, text: char };
  }

  const rest = value.slice(index);
  const scalar = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|^(?:true|false|null)\b/);
  if (!scalar) return null;
  return { start: index, end: index + scalar[0].length, text: scalar[0] };
}

function tokenClass(token: string): string {
  if (token.startsWith("\"")) return "json-viewer__tok-string";
  if (token === "true" || token === "false") return "json-viewer__tok-boolean";
  if (token === "null") return "json-viewer__tok-null";
  if (/^-?\d/.test(token)) return "json-viewer__tok-number";
  return "json-viewer__tok-punctuation";
}

function createButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon json-viewer__button",
    attr: { "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

async function copyToClipboard(text: string, notice: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(notice);
}

function formatJsonParseError(error: unknown, data: string, label: string): JsonParseError {
  const message = getErrorMessage(error);
  const position = parseJsonErrorPosition(message);
  if (position === null) return { label, message };
  const location = lineColumnFromPosition(data, position);
  return { label, message, line: location.line, column: location.column };
}

function formatJsonlParseError(error: unknown, line: string, lineNumber: number): JsonParseError {
  const message = getErrorMessage(error);
  const position = parseJsonErrorPosition(message);
  const column = position === null ? undefined : Math.max(1, Math.min(line.length + 1, position + 1));
  return { label: `line ${lineNumber}`, message, line: lineNumber, column };
}

function parseJsonErrorPosition(message: string): number | null {
  const match = message.match(/position (\d+)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function lineColumnFromPosition(data: string, position: number): { line: number; column: number } {
  const before = data.slice(0, position);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function outlineType(value: JsonValue, mode: "json" | "jsonl", depth: number): OutlineItem["type"] | null {
  if (mode === "jsonl" && depth === 0) return "jsonl";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return null;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonFile(file: TFile | null): file is TFile {
  return file instanceof TFile && JSON_EXTENSIONS.includes(file.extension.toLowerCase());
}
