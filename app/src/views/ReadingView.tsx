import { useEffect, useMemo, useRef } from "react";
import { openLink } from "../actions";
import { api, rawUrl } from "../lib/api";
import { bridge } from "../lib/bridge";
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, displayName, extOf } from "../lib/links";
import { renderMarkdown } from "../markdown/render";
import { useWorkspace } from "../store";

const MAX_EMBED_DEPTH = 3;

/** Extracts the section under `heading` (until the next heading of the same or higher level). */
export function sliceSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    return m && m[2].toLowerCase() === want;
  });
  if (start < 0) return text;
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function findHeadingLine(text: string, heading: string): number | null {
  const want = heading.trim().toLowerCase();
  const lines = text.split("\n");
  const i = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    return m && m[2].toLowerCase() === want;
  });
  return i >= 0 ? i : null;
}

async function hydrateEmbeds(root: HTMLElement, vaultId: string, fromPath: string, depth: number) {
  const resolver = useWorkspace.getState().resolver;
  const embeds = Array.from(root.querySelectorAll<HTMLElement>(".internal-embed:not([data-hydrated])"));
  for (const el of embeds) {
    el.dataset.hydrated = "1";
    const target = el.dataset.href ?? "";
    const fragment = el.dataset.fragment ?? "";
    const alias = el.dataset.alias ?? "";
    const resolved = el.dataset.resolved || (target ? resolver.resolve(target, fromPath) : null);
    if (!resolved) {
      el.className = "internal-embed is-unresolved";
      el.textContent = `Missing: ${target}`;
      continue;
    }
    const ext = extOf(resolved);
    if (IMAGE_EXTS.has(ext)) {
      const img = document.createElement("img");
      img.src = rawUrl(vaultId, resolved);
      img.alt = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : displayName(resolved);
      if (/^\d+(x\d+)?$/.test(alias)) img.style.width = `${alias.split("x")[0]}px`;
      el.replaceChildren(img);
      el.classList.add("image-embed");
    } else if (ext === "pdf") {
      const frame = document.createElement("iframe");
      frame.src = rawUrl(vaultId, resolved) + (fragment ? `#${fragment}` : "");
      frame.className = "pdf-embed";
      el.replaceChildren(frame);
    } else if (AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
      const media = document.createElement(AUDIO_EXTS.has(ext) ? "audio" : "video");
      media.controls = true;
      media.src = rawUrl(vaultId, resolved);
      el.replaceChildren(media);
    } else if (ext === "md" || ext === "markdown") {
      if (depth >= MAX_EMBED_DEPTH || resolved === fromPath) {
        el.innerHTML = "";
        el.append(linkEl(resolved, target));
        continue;
      }
      try {
        const file = await api.readFile(vaultId, resolved);
        let text = file.content ?? "";
        if (fragment) text = sliceSection(text, fragment);
        const { html } = renderMarkdown(text, { resolver, path: resolved });
        el.classList.add("markdown-embed");
        el.innerHTML = `<div class="markdown-embed-title"></div><div class="markdown-embed-content markdown-rendered">${html}</div>`;
        el.querySelector(".markdown-embed-title")!.append(linkEl(resolved, displayName(resolved) + (fragment ? ` > ${fragment}` : "")));
        await hydrateEmbeds(el, vaultId, resolved, depth + 1);
      } catch {
        el.textContent = `Could not load ${target}`;
      }
    } else {
      el.innerHTML = "";
      el.append(linkEl(resolved, target));
    }
  }
}

function linkEl(path: string, label: string) {
  const a = document.createElement("a");
  a.href = "#";
  a.className = "internal-link";
  a.dataset.resolved = path;
  a.dataset.href = path;
  a.textContent = label;
  return a;
}

export function ReadingView({
  text,
  path,
  onToggleTask,
  focusLine,
  focusNonce,
}: {
  text: string;
  path: string;
  onToggleTask?: (line: number, checked: boolean) => void;
  focusLine?: number;
  focusNonce?: number;
}) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const resolver = useWorkspace((s) => s.resolver);
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text, { resolver, path }).html, [text, resolver, path]);

  useEffect(() => {
    if (ref.current) hydrateEmbeds(ref.current, vaultId, path, 0);
  }, [html, vaultId, path]);

  useEffect(() => {
    if (focusLine === undefined || !ref.current) return;
    const blocks = Array.from(ref.current.querySelectorAll<HTMLElement>("[data-line]"));
    let best: HTMLElement | null = null;
    for (const b of blocks) {
      if (Number(b.dataset.line) <= focusLine) best = b;
      else break;
    }
    best?.scrollIntoView({ block: "start" });
    best?.classList.add("flash");
    setTimeout(() => best?.classList.remove("flash"), 1200);
  }, [focusNonce, focusLine, html]);

  const onClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    const box = el.closest<HTMLInputElement>("input.task-checkbox");
    if (box) {
      e.preventDefault();
      onToggleTask?.(Number(box.dataset.taskLine), !box.hasAttribute("checked"));
      return;
    }
    const fold = el.closest<HTMLElement>(".callout.is-collapsible .callout-title");
    if (fold) {
      fold.parentElement!.classList.toggle("is-collapsed");
      return;
    }
    const tag = el.closest<HTMLElement>("a.tag");
    if (tag) {
      e.preventDefault();
      useWorkspace.getState().set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${tag.dataset.tag}` });
      return;
    }
    const internal = el.closest<HTMLAnchorElement>("a.internal-link");
    if (internal) {
      e.preventDefault();
      const fragment = internal.dataset.fragment ? `#${internal.dataset.fragment}` : "";
      if (internal.dataset.resolved) {
        const heading = internal.dataset.fragment || undefined;
        useWorkspace.getState().openFile(internal.dataset.resolved, { newTab: mod, heading });
      } else {
        openLink((internal.dataset.href ?? "") + fragment, path, mod);
      }
      return;
    }
    const a = el.closest<HTMLAnchorElement>("a[href]");
    if (a) {
      const href = a.getAttribute("href") ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        e.preventDefault();
        bridge.openExternal(href);
      } else if (href.startsWith("#")) {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        ref.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
      }
    }
  };

  return <div className="markdown-rendered reading-view" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
