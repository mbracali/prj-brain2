declare module "markdown-it-emoji" {
  import type { PluginSimple } from "markdown-it";
  export const full: PluginSimple;
  export const light: PluginSimple;
  export const bare: PluginSimple;
}

declare module "markdown-it-emoji/lib/data/full.mjs" {
  const data: Record<string, string>;
  export default data;
}

declare module "markdown-it-footnote" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}

/** App version from package.json (set from the release tag by CI). */
declare const __APP_VERSION__: string;
