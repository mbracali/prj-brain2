"""Obsidian-flavoured markdown parsing used by the indexer.

Pure functions, no I/O. Extracts frontmatter, headings, tags, wiki links,
embeds and local markdown links while ignoring fenced and inline code.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

import yaml

MARKDOWN_EXTS = {"md", "markdown"}
TEXT_EXTS = {"txt"}
JSON_EXTS = {"json"}
YAML_EXTS = {"yaml", "yml"}
PDF_EXTS = {"pdf"}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"}
MEDIA_EXTS = {"mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov"}
KNOWN_EXTS = MARKDOWN_EXTS | TEXT_EXTS | JSON_EXTS | YAML_EXTS | PDF_EXTS | IMAGE_EXTS | MEDIA_EXTS


def kind_for_ext(ext: str) -> str:
    ext = ext.lower()
    if ext in MARKDOWN_EXTS:
        return "markdown"
    if ext in PDF_EXTS:
        return "pdf"
    if ext in TEXT_EXTS:
        return "text"
    if ext in JSON_EXTS:
        return "json"
    if ext in YAML_EXTS:
        return "yaml"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in MEDIA_EXTS:
        return "media"
    return "other"


def split_ext(name: str) -> tuple[str, str]:
    """('Note.md') -> ('Note', 'md'); unknown extensions stay part of the stem."""
    stem, dot, ext = name.rpartition(".")
    if dot and stem and ext.lower() in KNOWN_EXTS:
        return stem, ext.lower()
    return name, ""


@dataclass
class Link:
    target: str  # path-ish target without #fragment or |alias
    kind: str  # wiki | embed | md
    line: int  # 0-based
    context: str
    fragment: str = ""
    alias: str = ""

    @property
    def target_stem(self) -> str:
        return link_stem(self.target)


@dataclass
class Heading:
    level: int
    text: str
    line: int


@dataclass
class ParsedNote:
    frontmatter: dict[str, Any] = field(default_factory=dict)
    body: str = ""
    title: str | None = None
    description: str = ""
    headings: list[Heading] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    links: list[Link] = field(default_factory=list)


def link_stem(target: str) -> str:
    base = posixpath.basename(target.strip().rstrip("/"))
    stem, _ = split_ext(base)
    return stem.lower()


FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.S)
FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
INLINE_CODE_RE = re.compile(r"(`+)(?:(?!\1).)+?\1")
WIKI_RE = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
MD_LINK_RE = re.compile(r"(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
TAG_RE = re.compile(r"(?:(?<=\s)|^)#([^\s#!@$%^&*(),.?\":{}|<>\[\]'`~+=;\\]+)")
URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
STRIP_MD_RE = re.compile(r"[*_~`>#]|!\[\[[^\]]*\]\]|\[\[([^\]|]*\|)?|\]\]|\[([^\]]*)\]\([^)]*\)")


def split_frontmatter(text: str) -> tuple[dict[str, Any], str, int]:
    """Return (frontmatter, body, number of lines consumed by the frontmatter)."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text, 0
    try:
        data = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    consumed = text[: m.end()].count("\n")
    return _jsonable(data), text[m.end():], consumed


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)  # dates, etc.


def _frontmatter_tags(fm: dict[str, Any]) -> list[str]:
    raw = fm.get("tags", fm.get("tag"))
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else re.split(r"[,\s]+", str(raw))
    return [str(t).lstrip("#") for t in items if str(t).strip("# ")]


def parse_markdown(text: str) -> ParsedNote:
    fm, body, offset = split_frontmatter(text)
    note = ParsedNote(frontmatter=fm, body=body)
    tags: list[str] = _frontmatter_tags(fm)

    in_fence: str | None = None
    first_paragraph: list[str] = []
    paragraph_done = False

    for i, raw_line in enumerate(body.split("\n")):
        line_no = i + offset
        line = raw_line.rstrip("\r")
        fence = FENCE_RE.match(line)
        if in_fence:
            if fence and fence.group(1)[0] == in_fence[0] and len(fence.group(1)) >= len(in_fence):
                in_fence = None
            continue
        if fence:
            in_fence = fence.group(1)
            if first_paragraph:
                paragraph_done = True
            continue

        h = HEADING_RE.match(line)
        if h:
            note.headings.append(Heading(len(h.group(1)), h.group(2).strip(), line_no))
            if first_paragraph:
                paragraph_done = True
        elif not paragraph_done:
            stripped = line.strip()
            if stripped:
                if not re.match(r"^(\||-{3,}|\*{3,}|!\[)", stripped):
                    first_paragraph.append(stripped)
            elif first_paragraph:
                paragraph_done = True

        scan = INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), line)
        scan = HTML_COMMENT_RE.sub("", scan)
        context = line.strip()

        for m in WIKI_RE.finditer(scan):
            inner = m.group(2)
            target, _, alias = inner.partition("|")
            target, _, fragment = target.partition("#")
            target = target.strip()
            if not target and not fragment:
                continue
            note.links.append(
                Link(
                    target=target,
                    kind="embed" if m.group(1) else "wiki",
                    line=line_no,
                    context=context,
                    fragment=fragment.strip(),
                    alias=alias.strip(),
                )
            )
        for m in MD_LINK_RE.finditer(scan):
            href = m.group(3)
            if URL_SCHEME_RE.match(href) or href.startswith("#"):
                continue
            target, _, fragment = unquote(href).partition("#")
            note.links.append(
                Link(
                    target=target,
                    kind="embed" if m.group(1) else "md",
                    line=line_no,
                    context=context,
                    fragment=fragment,
                    alias=m.group(2),
                )
            )
        if not h:
            for m in TAG_RE.finditer(scan):
                tag = m.group(1).rstrip("/")
                if tag and not tag.replace("/", "").isdigit():
                    tags.append(tag)

    seen: set[str] = set()
    for t in tags:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            note.tags.append(t)

    title = fm.get("title")
    if not title:
        h1 = next((h for h in note.headings if h.level == 1), None)
        title = h1.text if h1 else None
    note.title = str(title) if title else None

    desc = fm.get("description") or fm.get("summary")
    if not desc:
        desc = " ".join(first_paragraph)
        desc = STRIP_MD_RE.sub(lambda m: m.group(2) or "", desc)
        desc = re.sub(r"\s+", " ", desc).strip()
    note.description = shorten(str(desc), 200)
    return note


def shorten(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return cut + "…"


WIKI_REWRITE_RE = WIKI_RE


def rewrite_wikilinks(text: str, should_rewrite, new_target_for) -> str:
    """Rewrite wiki links/embeds whose target satisfies ``should_rewrite(target)``.

    ``new_target_for(target)`` returns the replacement target text. Fragments
    (#heading) and aliases (|alias) are preserved.
    """

    def repl(m: re.Match[str]) -> str:
        inner = m.group(2)
        target_part, pipe, alias = inner.partition("|")
        target, hash_, fragment = target_part.partition("#")
        if not target.strip() or not should_rewrite(target.strip()):
            return m.group(0)
        new_inner = new_target_for(target.strip()) + (hash_ + fragment) + (pipe + alias)
        return f"{m.group(1)}[[{new_inner}]]"

    return WIKI_RE.sub(repl, text)
