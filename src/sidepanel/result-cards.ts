/**
 * Search result rows for the side panel, built with DOM nodes.
 *
 * Every string on a row — title, site, author, summary, URL — was captured
 * from a web page, so none of it is ever parsed as markup: each is assigned
 * through `textContent` or a checked attribute, never `innerHTML`. The
 * document is typed structurally so the rows can be unit-tested without a DOM.
 */
import type { VectorSearchResult } from "../lib/models/vector-search";
import { displayHost, hostnameOf } from "../lib/host-match";
import { formatDwell, formatRecallTime } from "./format-time";

export interface CardElement<Self> {
  className: string;
  textContent: string | null;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  appendChild(child: Self): unknown;
}

export interface CardDocument<E extends CardElement<E>> {
  createElement(tagName: string): E;
}

export interface CardContainer<E> {
  appendChild(child: E): unknown;
}

function element<E extends CardElement<E>>(doc: CardDocument<E>, tag: string, className?: string, text?: string): E {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The site a result came from: its declared name, else its hostname. */
export function resultSite(result: Pick<VectorSearchResult, "siteName" | "domain" | "url">): string {
  return result.siteName || displayHost(result.domain || hostnameOf(result.url)) || "";
}

/**
 * "YouTube · Fireship · video" — site, then author and kind when known.
 * A plain "page" is not announced: it says nothing a row does not already say.
 */
export function describeResultSource(
  result: Pick<VectorSearchResult, "siteName" | "domain" | "url" | "byline" | "contentKind">
): string {
  const parts = [resultSite(result)];
  if (result.byline) parts.push(result.byline);
  if (result.contentKind === "video" || result.contentKind === "article") parts.push(result.contentKind);
  return parts.filter(Boolean).join(" · ");
}

/** The source line plus how long the page was actually in front of the user. */
export function describeResultSourceAndDwell(
  result: Pick<VectorSearchResult, "siteName" | "domain" | "url" | "byline" | "contentKind" | "dwellTime">
): string {
  return [describeResultSource(result), formatDwell(result.dwellTime)].filter(Boolean).join(" · ");
}

export function buildResultCard<E extends CardElement<E>>(
  doc: CardDocument<E>,
  result: VectorSearchResult,
  now: number = Date.now()
): E {
  const isVector = result.matchKind === "vector" && result.cosineSimilarity !== null;
  const card = element(doc, "div", "timeline-item");

  const head = element(doc, "div");
  head.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";
  const badge = element(
    doc,
    "span",
    "badge",
    isVector ? `vector · cos ${result.cosineSimilarity!.toFixed(2)}` : "lexical"
  );
  badge.style.cssText = isVector ? "background: #064e3b; color: #6ee7b7;" : "background: #334155; color: #cbd5e1;";
  const when = element(doc, "span", "item-time", formatRecallTime(result.timestamp, now));
  when.style.cssText = "font-size: 0.73rem; color: #94a3b8;";
  head.appendChild(badge);
  head.appendChild(when);
  card.appendChild(head);

  const titleRow = element(doc, "div", "item-title");
  const link = element(doc, "a", "item-link", result.title || "Untitled Page");
  // Only a web address becomes a link; anything else stays inert text.
  if (/^https?:\/\//i.test(result.url)) {
    link.setAttribute("href", result.url);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener");
  }
  titleRow.appendChild(link);
  card.appendChild(titleRow);

  const meta = element(doc, "div", "item-meta");
  meta.appendChild(element(doc, "span", "item-source", describeResultSourceAndDwell(result)));
  meta.appendChild(element(doc, "span", undefined, " • "));
  const reopen = element(doc, "button", "restore-btn", "Reopen Tab");
  reopen.setAttribute("data-url", result.url);
  meta.appendChild(reopen);
  card.appendChild(meta);

  if (result.summary) card.appendChild(element(doc, "div", "item-excerpt", result.summary));
  return card;
}

export function appendResultCards<E extends CardElement<E>>(
  doc: CardDocument<E>,
  container: CardContainer<E>,
  results: VectorSearchResult[],
  now: number = Date.now()
): void {
  for (const result of results) container.appendChild(buildResultCard(doc, result, now));
}
