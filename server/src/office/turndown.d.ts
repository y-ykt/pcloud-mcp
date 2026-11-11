// © 2026 Yasuhiko Yokote

/**
 * Type declarations for `turndown` and `turndown-plugin-gfm` (only the part this server uses).
 *
 * **`@types/turndown` is not used.** It requires the DOM types (`HTMLElement` and others),
 * which conflicts with the Node-only configuration (`lib` does not include `dom`).
 * Bringing in the DOM types makes browser-only APIs appear in completion.
 */
declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "**" | "__";
    hr?: string;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    use(plugin: unknown): this;
    keep(filter: string | string[]): this;
    remove(filter: string | string[]): this;
  }
}

declare module "turndown-plugin-gfm" {
  /** Enables tables, strikethrough and task lists together. */
  export const gfm: unknown;
  export const tables: unknown;
  export const strikethrough: unknown;
  export const taskListItems: unknown;
}
