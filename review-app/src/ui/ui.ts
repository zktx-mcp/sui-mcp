// Shared atoms for internal cards.
import { shortHex, formatUtc } from "../format.js";

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export type ButtonVariant = "primary" | "secondary" | "danger";

export function button(label: string, onClick: () => void, variant: ButtonVariant = "primary"): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className =
    variant === "primary" ? "ui-btn ui-btn--primary" : variant === "danger" ? "ui-btn ui-btn--danger" : "ui-btn";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

// Inline-SVG icon button. `svgMarkup` is a trusted constant from our own code,
// never user data, so assigning it as innerHTML carries no injection surface.
export function iconButton(svgMarkup: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "ui-icon-btn";
  node.setAttribute("aria-label", ariaLabel);
  node.innerHTML = svgMarkup;
  node.addEventListener("click", onClick);
  return node;
}

// A horizontal group of buttons that share one width: each direct .ui-btn child
// is sized equally and the group wraps to full-width stacked rows when too narrow,
// so a short and a long label still read as a matched pair.
export function buttonRow(...buttons: HTMLElement[]): HTMLElement {
  const node = element("div", "ui-btn-row");
  node.append(...buttons);
  return node;
}

// A single standalone button placed in a right-aligned action row, so a solo control reads
// as the section's action (and gains the row's top spacing) instead of a bare left-aligned
// button flush against the text above it.
export function endRow(btn: HTMLElement): HTMLElement {
  const node = buttonRow(btn);
  node.classList.add("ui-btn-row--end");
  return node;
}

export function link(text: string, href: string): HTMLAnchorElement {
  const node = document.createElement("a");
  node.className = "ui-link";
  node.textContent = text;
  node.href = href;
  return node;
}

export function input(options: {
  type?: string;
  value?: string;
  placeholder?: string;
  id?: string;
  name?: string;
}): HTMLInputElement {
  const node = document.createElement("input");
  node.type = options.type ?? "text";
  node.className = node.type === "checkbox" ? "ui-checkbox" : "ui-input";
  if (options.value !== undefined) {
    node.value = options.value;
  }
  if (options.placeholder !== undefined) {
    node.placeholder = options.placeholder;
  }
  if (options.id) {
    node.id = options.id;
  }
  if (options.name) {
    node.name = options.name;
  }
  node.autocomplete = "off";
  return node;
}

export function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const node = document.createElement("label");
  const checkbox = control.tagName === "INPUT" && (control as HTMLInputElement).type === "checkbox";
  node.className = checkbox ? "ui-field ui-field--check" : "ui-field";
  const label = element("span", undefined, labelText);
  if (checkbox) node.append(control, label);
  else node.append(label, control);
  return node;
}

export function select(options: {
  value?: string;
  id?: string;
  name?: string;
  choices: ReadonlyArray<{ value: string; label: string }>;
  onChange?: (value: string) => void;
}): HTMLSelectElement {
  const node = document.createElement("select");
  node.className = "ui-select";
  for (const choice of options.choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    if (options.value === choice.value) {
      option.selected = true;
    }
    node.append(option);
  }
  if (options.id) {
    node.id = options.id;
  }
  if (options.name) {
    node.name = options.name;
  }
  if (options.onChange) {
    node.addEventListener("change", () => options.onChange!(node.value));
  }
  return node;
}

export function card(title?: string): HTMLElement {
  const node = element("section", "ui-card");
  if (title) {
    node.append(element("h2", "ui-card-head", title));
  }
  return node;
}

// A group in one document, without another card boundary.
export function section(title?: string): HTMLElement {
  const node = element("section", "ui-section");
  if (title) node.append(element("h2", "ui-section-title", title));
  return node;
}

export function row(label: string, value: string | Node): HTMLElement {
  const node = element("div", "ui-row");
  node.append(element("span", "ui-row-label", label));
  const valueNode = element("span", "ui-row-value");
  if (typeof value === "string") {
    valueNode.textContent = value;
  } else {
    valueNode.append(value);
  }
  node.append(valueNode);
  return node;
}

export type StatusKind = "success" | "failure" | "pending" | "neutral";

// Shared outcome glyphs.
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const STATUS_ICONS: Record<StatusKind, string> = {
  success: CHECK_ICON,
  failure: CLOSE_ICON,
  pending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  neutral: ""
};

// Prominent result banner: the single, reusable way to show an outcome (a chain
// receipt's execution status now, an execution result later) with an icon and
// color, not color alone.
export function statusBanner(kind: StatusKind, label: string): HTMLElement {
  const node = element("div", `ui-status-banner ui-status-banner--${kind}`);
  node.setAttribute("role", "status");
  const icon = STATUS_ICONS[kind];
  if (icon) {
    const glyph = element("span", "ui-status-icon");
    glyph.innerHTML = icon;
    node.append(glyph);
  }
  node.append(element("span", undefined, label));
  return node;
}

// Reusable transaction-fact block: a headline title, an optional trailing value
// (monospace, e.g. a signed amount), and muted monospace meta lines that keep the
// minimal display while exposing the full value via `title`. One component for a
// receipt's balance/object/Move-call facts and, later, the execution facts.
export function detailItem(options: {
  title: string;
  trailing?: string;
  // Tints the trailing value for a signed balance/amount: "up" (gain) or "down"
  // (loss). Reusable for a receipt's balance changes and, later, execution results.
  trailingTone?: "up" | "down";
  metas?: ReadonlyArray<{ label?: string; value: string; full?: string }>;
}): HTMLElement {
  const item = element("div", "ui-detail-item");
  const head = element("div", "ui-detail-head");
  head.append(element("span", "ui-detail-title", options.title));
  if (options.trailing !== undefined) {
    const trailing = mono(options.trailing);
    trailing.classList.add("ui-detail-trailing");
    if (options.trailingTone) {
      trailing.classList.add(`ui-detail-trailing--${options.trailingTone}`);
    }
    head.append(trailing);
  }
  item.append(head);
  for (const meta of options.metas ?? []) {
    const line = element("div", "ui-detail-meta");
    if (meta.label) {
      line.append(element("span", "ui-detail-metalabel", meta.label));
    }
    const value = mono(meta.value);
    if (meta.full && meta.full !== meta.value) {
      value.title = meta.full;
    }
    line.append(value);
    item.append(line);
  }
  return item;
}

// Collapsed-by-default disclosure for a secondary fact group. Returns the
// <details>; the caller appends the group's content into `.body` (kept separate
// so its padding is consistent). Mirrors the native-<details> pattern the review
// page already uses for collapsible records.
export function accordion(summaryText: string, open = false): { details: HTMLDetailsElement; body: HTMLElement } {
  const details = document.createElement("details");
  details.className = "ui-accordion";
  details.open = open;
  const summary = document.createElement("summary");
  summary.className = "ui-accordion-summary";
  summary.append(element("span", undefined, summaryText));
  const body = element("div", "ui-accordion-body");
  details.append(summary, body);
  return { details, body };
}

export type FeedbackKind = "ok" | "error";

// Result/error feedback tied to an action: persistent (it stays until the next
// render), and able to carry a diagnostic detail line.
export function feedback(kind: FeedbackKind, message: string, detail?: string): HTMLElement {
  const node = element("div", kind === "error" ? "ui-feedback ui-feedback--error" : "ui-feedback ui-feedback--ok");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.append(element("span", undefined, message));
  if (detail) {
    node.append(element("span", "ui-feedback-detail", detail));
  }
  return node;
}

// Placeholder card shown in a slot whose content is empty, unsupported, or
// unavailable. Keeps the slot's position so the layout does not collapse.
export function placeholder(message: string): HTMLElement {
  return element("div", "ui-placeholder", message);
}

// Quiet boundary/scope note (tier T4).
export function note(text: string): HTMLElement {
  return element("p", "ui-note", text);
}

// Monospace span for ids, addresses, and digests.
export function mono(text: string): HTMLElement {
  return element("span", "ui-mono", text);
}

// Compact address/hash with its complete value available to readers.
export function monoShort(value: string): HTMLElement {
  const node = mono(shortHex(value));
  node.title = value;
  node.setAttribute("aria-label", value);
  node.tabIndex = 0;
  return node;
}

export function timeValue(value: string): HTMLElement {
  const node = element("time", undefined, formatUtc(value));
  node.dateTime = value;
  node.title = value;
  node.setAttribute("aria-label", value);
  return node;
}

// Inline info marker. Keeps the visible copy minimal while the full detail is a
// hover/focus tooltip (and is exposed to assistive tech via aria-label).
export function info(detail: string): HTMLElement {
  const node = element("span", "ui-info", "i");
  node.title = detail;
  node.setAttribute("aria-label", detail);
  node.setAttribute("role", "img");
  node.tabIndex = 0;
  return node;
}
