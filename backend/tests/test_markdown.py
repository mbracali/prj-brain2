from brain2.vaults.markdown import parse_markdown, rewrite_wikilinks, split_ext
from brain2.vaults.service import pick_link


def test_frontmatter_title_tags_description():
    note = parse_markdown(
        "---\ntitle: Hello\ntags: [a, b]\n---\n# Heading\n\nFirst **para** with [[Link]].\n\nSecond."
    )
    assert note.frontmatter["title"] == "Hello"
    assert note.title == "Hello"
    assert note.tags == ["a", "b"]
    assert note.description == "First para with Link."
    assert [(h.level, h.text, h.line) for h in note.headings] == [(1, "Heading", 4)]


def test_links_embeds_aliases_and_fragments():
    note = parse_markdown("See [[Folder/Note#Sec|alias]] and ![[img.png]] and [x](other%20note.md) [w](https://x.y)")
    got = [(ln.target, ln.kind, ln.fragment, ln.alias) for ln in note.links]
    assert ("Folder/Note", "wiki", "Sec", "alias") in got
    assert ("img.png", "embed", "", "") in got
    assert ("other note.md", "md", "", "x") in got
    assert len(got) == 3
    assert note.links[0].target_stem == "note"


def test_code_is_ignored():
    note = parse_markdown("```\n[[NotALink]] #nottag\n```\n`[[inline]]` #real")
    assert note.links == []
    assert note.tags == ["real"]


def test_tags_rules():
    note = parse_markdown("#one text #two/sub #123 a#b #three, ## Heading")
    assert note.tags == ["one", "two/sub", "three"]


def test_split_ext():
    assert split_ext("Note.md") == ("Note", "md")
    assert split_ext("v1.2 notes") == ("v1.2 notes", "")


def test_pick_link_resolution():
    paths = ["a/Note.md", "b/c/Note.md", "Note.md"]
    assert pick_link("Note", None, paths) == "Note.md"
    assert pick_link("c/Note", None, paths) == "b/c/Note.md"
    assert pick_link("a/Note.md", None, paths) == "a/Note.md"
    assert pick_link("Note", "b/c/x.md", ["a/Note.md", "b/c/Note.md"]) == "b/c/Note.md"
    assert pick_link("Missing", None, paths) is None


def test_rewrite_wikilinks_preserves_fragment_and_alias():
    out = rewrite_wikilinks("[[Old#h|a]] [[Other]] ![[Old]]", lambda t: t == "Old", lambda t: "New")
    assert out == "[[New#h|a]] [[Other]] ![[New]]"
