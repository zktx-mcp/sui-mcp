// Shared PTB (Mermaid) graph renderer — the single source for turning Mermaid
// text into an SVG for reviewed and executed transactions. Caching and error
// handling live in one place. The surrounding chrome (name toggle, Mermaid
// source, diagnostics, boundary note) stays with each caller.
//
// An opt-in pan/zoom mode (wheel to zoom toward the cursor, drag to pan, plus
// zoom-in/out/center controls) makes a large graph legible. It is off by default
// for callers that only need a static diagram.
import mermaid from "mermaid";
import { section, element, iconButton, info } from "./ui.js";
import { t } from "../i18n/i18n.js";

// Mermaid is themed from the app's own design tokens (read live from the document),
// so the graph's nodes, edges, edge-label backgrounds, and text follow light/dark
// exactly like the rest of the page. Mermaid injects an id-scoped <style> into the
// SVG that wins over external CSS, so the theme MUST be configured here (theme "base"
// + themeVariables), not overridden in ui.css.
function mermaidConfig() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string): string => s.getPropertyValue(name).trim();
  return {
    startOnLoad: false,
    suppressErrorRendering: true,
    // securityLevel "strict" keeps Mermaid from emitting click handlers or inline
    // scripts, so the rendered SVG is safe to inject as innerHTML under the page CSP.
    securityLevel: "strict" as const,
    theme: "base" as const,
    themeVariables: {
      background: v("--ui-surface"),
      mainBkg: v("--ui-surface-2"),
      primaryColor: v("--ui-surface-2"),
      primaryBorderColor: v("--ui-border-strong"),
      primaryTextColor: v("--ui-text"),
      nodeBorder: v("--ui-border-strong"),
      nodeTextColor: v("--ui-text"),
      lineColor: v("--ui-border-strong"),
      edgeLabelBackground: v("--ui-surface"),
      secondaryColor: v("--ui-surface-2"),
      tertiaryColor: v("--ui-surface"),
      fontSize: "12px"
    },
    // `curve: "basis"` draws smooth curved edges instead of straight polylines.
    flowchart: { useMaxWidth: true, curve: "basis" as const }
  };
}

let initialized = false;
let mermaidThemeKey: string | undefined;
function ensureMermaid(): void {
  const key = document.documentElement.getAttribute("data-theme") ?? "light";
  if (initialized && key === mermaidThemeKey) {
    return;
  }
  mermaid.initialize(mermaidConfig());
  mermaidThemeKey = key;
  initialized = true;
  // Cached SVGs were painted for the previous theme; drop them so the next render
  // repaints with the new tokens.
  svgCache.clear();
}

// Module-level so an exact-same graph renders instantly from cache and a changed
// graph keeps the previous SVG visible while the new one renders (no blank flash).
// Each page loads its own bundle, so this state is per page, never cross-page.
const disposers = new WeakMap<Element, () => void>();
export function disposePtbGraphs(root: HTMLElement): void {
  for (const element of root.querySelectorAll(".ui-ptb-graph")) disposers.get(element)?.();
}
let renderSequence = 0;
const svgCache = new Map<string, string>();

const ZOOM_IN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ZOOM_OUT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const CENTER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>';

export type PtbGraphView = {
  // Append this where the graph should appear.
  readonly element: HTMLElement;
  // Render (or re-render) the given Mermaid text into the element.
  render(mermaidText: string): Promise<"rendered" | "failed" | "discarded">;
  dispose(): void;
};

export function createPtbGraphView(labels?: {
  rendering?: string;
  failed?: string;
  panZoom?: boolean;
  zoomIn?: string;
  zoomOut?: string;
  center?: string;
}): PtbGraphView {
  ensureMermaid();
  const renderingLabel = labels?.rendering ?? "Rendering the transaction graph…";
  const failedLabel = labels?.failed ?? "The transaction graph could not be rendered";
  const element = document.createElement("div");
  element.className = "ui-ptb-graph";

  // Without pan/zoom the SVG is injected straight into the element (review page's
  // current behaviour). With it, the SVG lives in a transformed content layer
  // inside a clipping viewport, and a controls overlay sits on top.
  const interactive = labels?.panZoom === true;
  const content = interactive ? document.createElement("div") : element;
  let panZoom: PanZoomHandle | undefined;
  if (interactive) {
    element.classList.add("ui-ptb-graph--interactive");
    content.className = "ui-ptb-graph-content";
    element.append(content);
    panZoom = attachPanZoom(element, content);
    element.append(buildControls(panZoom, labels));
  }
  content.textContent = renderingLabel;

  let lastText: string | undefined;
  let lastRenderedSvg: string | undefined;
  let renderedText: string | undefined;
  let renderedTheme: string | undefined;
  let showingSvg = false;
  let disposed = false;
  let revision = 0;
  type RenderOutcome = "rendered" | "failed" | "discarded";
  let latestRender: Promise<RenderOutcome> = Promise.resolve("discarded");
  const renderSvg = async (text: string, requestedRevision: number): Promise<RenderOutcome> => {
    if (disposed) return "discarded";
    lastText = text;
    // Re-init Mermaid when the app theme changed since the last render so the SVG is
    // repainted with the current tokens (this also clears the now-stale SVG cache).
    try { ensureMermaid(); }
    catch (error) {
      showingSvg = false;
      content.textContent = `${failedLabel}: ${error instanceof Error ? error.message : String(error)}`;
      element.classList.add("ui-ptb-graph--error");
      return "failed";
    }
    if (showingSvg && lastRenderedSvg && renderedText === text && renderedTheme === mermaidThemeKey) return "rendered";
    element.classList.remove("ui-ptb-graph--error");
    const cached = svgCache.get(text);
    if (cached) {
      // Already rendered this exact graph: inject synchronously, no flash.
      content.innerHTML = cached;
      showingSvg = true;
      lastRenderedSvg = cached;
      renderedText = text;
      renderedTheme = mermaidThemeKey;
      panZoom?.center();
      return "rendered";
    }
    // Keep the previous graph visible while the new one renders so a refresh
    // never blanks to a placeholder.
    if (!lastRenderedSvg) {
      content.textContent = renderingLabel;
    }
    renderSequence += 1;
    try {
        const rendered = await mermaid.render(`ptb-graph-${renderSequence}`, text);
        if (disposed || requestedRevision !== revision) return "discarded" as const;
        svgCache.set(text, rendered.svg);
        lastRenderedSvg = rendered.svg;
        renderedText = text;
        renderedTheme = mermaidThemeKey;
        content.innerHTML = rendered.svg;
        showingSvg = true;
        panZoom?.center();
        return "rendered" as const;
    } catch (error: unknown) {
        if (disposed || requestedRevision !== revision) return "discarded" as const;
        // Name the failure rather than hiding it behind the placeholder text.
        content.textContent = `${failedLabel}: ${error instanceof Error ? error.message : String(error)}`;
        showingSvg = false;
        element.classList.add("ui-ptb-graph--error");
        return "failed" as const;
    }
  };
  const render = (text: string): Promise<RenderOutcome> => {
    const requestedRevision = ++revision;
    const completion = renderSvg(text, requestedRevision).then((outcome) =>
      outcome === "discarded" && !disposed && requestedRevision !== revision ? latestRender : outcome);
    latestRender = completion;
    return completion;
  };

  // Re-render through the theme-aware Mermaid config whenever the app theme toggles,
  // so the graph's colours follow light/dark. Self-disconnects once off the DOM.
  const themeObserver = new MutationObserver(() => {
    if (!content.isConnected) {
      themeObserver.disconnect();
      return;
    }
    if (lastText !== undefined) {
      render(lastText);
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const dispose = () => { disposed = true; revision += 1; themeObserver.disconnect(); };
  disposers.set(element, dispose);
  return { element, render, dispose };
}

type PanZoomHandle = { center: () => void; zoomBy: (factor: number) => void };

// A button press or 100 CSS pixels of wheel travel uses a 1.1x zoom step
// (the reciprocal for zooming out). Small trackpad deltas contribute
// proportionally; equal total travel has the same effect across event rates.
const ZOOM_STEP = 1.1;
const WHEEL_PIXELS_PER_STEP = 100;

// Wheel-to-zoom (toward the cursor) and drag-to-pan, applied as a CSS transform on
// the content layer (CSSOM transforms are not subject to the style-src CSP). The
// clipping + cursor come from the stylesheet; this only writes the transform.
function attachPanZoom(viewport: HTMLElement, content: HTMLElement): PanZoomHandle {
  const state = { scale: 1, x: 0, y: 0 };
  const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
  const apply = (): void => {
    content.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  };
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const nextScale = clamp(state.scale * factor, 0.2, 8);
    const ratio = nextScale / state.scale;
    state.x = cx - ratio * (cx - state.x);
    state.y = cy - ratio * (cy - state.y);
    state.scale = nextScale;
    apply();
  };
  // Reset to 1:1 and center the graph in the viewport. The content's layout
  // height (offsetHeight, transform-independent) decides the vertical offset, so a
  // graph shorter than the viewport sits centered instead of pinned to the top.
  const center = (): void => {
    state.scale = 1;
    state.x = 0;
    const viewportHeight = viewport.clientHeight;
    const contentHeight = content.offsetHeight;
    state.y = contentHeight > 0 && contentHeight < viewportHeight ? (viewportHeight - contentHeight) / 2 : 0;
    apply();
  };

  viewport.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY === 0) return;
      // Wheel deltas can be pixels, text lines, or pages. Use this viewport's
      // rendered line/page size; a normal line height falls back to one em.
      let unit = 1;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        const style = getComputedStyle(viewport);
        unit = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize);
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        unit = viewport.clientHeight;
      }
      const pixels = event.deltaY * unit;
      if (!Number.isFinite(pixels) || pixels === 0) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, ZOOM_STEP ** (-pixels / WHEEL_PIXELS_PER_STEP));
    },
    { passive: false }
  );

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  viewport.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("ui-ptb-graph--grabbing");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    state.x += event.clientX - lastX;
    state.y += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  });
  const endDrag = (): void => {
    dragging = false;
    viewport.classList.remove("ui-ptb-graph--grabbing");
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("dblclick", center);

  return { center, zoomBy: (factor) => {
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, factor);
  } };
}

function buildControls(handle: PanZoomHandle, labels?: { zoomIn?: string; zoomOut?: string; center?: string }): HTMLElement {
  const controls = element("div", "ui-ptb-graph-controls");
  controls.append(
    iconButton(ZOOM_IN_ICON, labels?.zoomIn ?? "Zoom in", () => handle.zoomBy(ZOOM_STEP)),
    iconButton(ZOOM_OUT_ICON, labels?.zoomOut ?? "Zoom out", () => handle.zoomBy(1 / ZOOM_STEP)),
    iconButton(CENTER_ICON, labels?.center ?? "Center", () => handle.center())
  );
  // A click on a control must not also start a pan on the viewport beneath it.
  controls.addEventListener("pointerdown", (event) => event.stopPropagation());
  return controls;
}

// Graph-card title-bar eye icons: a password-style show/hide for the package-name ↔ raw-address
// toggle.
const EYE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.3 13.3 0 0 1-2.4 3.1M6.1 6.1A13.4 13.4 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.9-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

// Shared presentation does not imply shared evidence provenance. Every caller
// identifies whether its diagram came from local preparation or a chain receipt.
export function transactionGraph(opts: { source: "review" | "receipt"; mermaid: { text: string; namedText: string } }): HTMLElement {
  return createTransactionGraph(opts).node;
}

export function createTransactionGraph(opts: { source: "review" | "receipt"; mermaid: { text: string; namedText: string } }) {
  const panel = section();
  panel.classList.add("transaction-graph");
  // Title bar: the "Transaction graph" text with its diagnostics-only ⓘ tooltip right
  // beside it; the eye action sits on the far side.
  const head = element("h2", "ui-section-title");
  const title = element("span", "ptb-graph-title", opts.source === "review" ? "Transaction being reviewed" : "Executed transaction");
  title.append(" ", info(opts.source === "review" ? t.receipt.graphReviewTip : t.receipt.graphTip));
  head.append(title);
  panel.append(head);
  let { text, namedText } = opts.mermaid;
  let showingNames = true;

  // One graph surface serves both the review and observed result cards.
  const slot = element("div", "ui-chain-receipt-ptb");
  let view: PtbGraphView | undefined, disposed = false;
  const render = () => {
    if (disposed) return Promise.resolve("discarded" as const);
    if (!view) {
      try {
        view = createPtbGraphView({ rendering: t.receipt.graphRendering, failed: t.receipt.graphFailed,
          panZoom: true, zoomIn: t.receipt.graphZoomIn, zoomOut: t.receipt.graphZoomOut, center: t.receipt.graphCenter });
        slot.replaceChildren(view.element);
      } catch {
        slot.replaceChildren(element("p", "ui-note", "The transaction graph could not be displayed. Transaction facts remain available below."));
        return Promise.resolve("failed" as const);
      }
    }
    return view.render(showingNames ? namedText : text);
  };

  const actions = element("div", "ui-ptb-actions");
  const eyeButton = iconButton(EYE_ICON, t.receipt.graphShowAddresses, () => {
      showingNames = !showingNames;
      eyeButton.innerHTML = showingNames ? EYE_ICON : EYE_OFF_ICON;
      eyeButton.setAttribute("aria-label", showingNames ? t.receipt.graphShowAddresses : t.receipt.graphShowNames);
      void render();
    });
  if (namedText !== text) actions.append(eyeButton);
  head.append(actions);

  panel.append(slot);
  const ready = render();
  return { node: panel, ready, update: (mermaid: typeof opts.mermaid) => {
    text = mermaid.text; namedText = mermaid.namedText;
    actions.replaceChildren(...(namedText !== text ? [eyeButton] : []));
    return render();
  }, dispose: () => { disposed = true; view?.dispose(); } };
}
