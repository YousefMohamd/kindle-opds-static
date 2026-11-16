#!/usr/bin/env python3
"""Build Quran EPUBs with the tafsir embedded as endnotes (RliBook WS1).

Zero-step tafsir: the delivered EPUB already contains the commentary.
Tap an ayah number -> jump to its tafsir note; the note links back.
No plugin, no ZIP, no install steps — on a stock Kindle, in KOReader,
or anywhere else that reads EPUB. Send-to-Kindle converts EPUB -> KFX;
the notes use the standard EPUB3 footnote mechanism (epub:type
"noteref" / "footnote"), which degrades gracefully to plain internal
hyperlinks if a converter drops the popup behaviour.

Why prebuilt, not built at send time
------------------------------------
* The bot is a Cloudflare Worker on the free tier (10 ms CPU budget
  per request). Parsing a 3.2 MB StarDict file, rewriting 114 chapter
  files and re-zipping a ~4 MB EPUB at send time would blow that
  budget on every delivery.
* Building once, offline, lets us VERIFY the result (every ayah
  linked, every link resolving, per-surah counts exact) instead of
  hoping a runtime build worked.
* The combined files are published as GitHub Release assets on the
  RliBook repo (exactly how the upstream zeeyado project already
  publishes its plain Quran EPUBs). Nothing is hosted on our server:
  the bot fetches the combined EPUB at send time and streams it,
  the website links the release asset — the same pattern as today.

Inputs (never bundled, fetched at build time):
* Quran EPUBs: zeeyado/quran-ebook release v0.10.0 (GPL-3.0).
* Tafsir ZIPs: StarDict sets from zeeyado/quran-ebook main/release/
  (keys are "Surah + ayah number", e.g. 'Abasa 1 — NOT words).

Outputs: one EPUB per (edition x tafsir) combination, named
  <edition-stem>--tafsir-<tafsir-id>.epub
plus a manifest.json (file, size, sha256, release URL) for the upload.

Usage:
  python3 build-quran-tafsir.py build --epub <file-or-URL>
      --tafsir <file-or-URL> --tafsir-id muyassar
      --tafsir-name "التفسير الميسر" --tafsir-lang ar --out out.epub
  python3 build-quran-tafsir.py build-all --out-dir out/ [--langs ar,en]
      [--cache-dir cache/]   # all 51 hafs combinations (see COMBOS)
  python3 build-quran-tafsir.py verify --epub out.epub --tafsir-id muyassar

Exit code is non-zero on any failed assertion — a bad build never
ships silently. Requires Python 3.9+ (standard library only).
"""

import argparse
import hashlib
import io
import json
import os
import re
import struct
import sys
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# Fixed data (verified live 2026-11-16 against the v0.10.0 release and the
# Muyassar / Ibn Kathir (en) StarDict sets).
# ---------------------------------------------------------------------------

QURAN_TAG = "v0.10.0"
QURAN_DOWNLOAD_BASE = (
    "https://github.com/zeeyado/quran-ebook/releases/download"
)
QURAN_TAFSIR_BASE = (
    "https://raw.githubusercontent.com/zeeyado/quran-ebook/main/release"
)
# Release tag for the combined EPUBs on YousefMohamd/kindle-opds-static.
COMBINED_TAG = "quran-tafsir-v1"
COMBINED_BASE = (
    "https://github.com/YousefMohamd/kindle-opds-static"
    f"/releases/download/{COMBINED_TAG}"
)

# Surah names EXACTLY as they appear as StarDict key prefixes, in
# canonical surah order (1..114). The build asserts the per-surah
# entry count against AYAH_COUNTS, so a wrong spelling fails loudly.
SURAH_NAMES = [
    "Al-Fatihah", "Al-Baqarah", "Ali 'Imran", "An-Nisa", "Al-Ma'idah",
    "Al-An'am", "Al-A'raf", "Al-Anfal", "At-Tawbah", "Yunus", "Hud",
    "Yusuf", "Ar-Ra'd", "Ibrahim", "Al-Hijr", "An-Nahl", "Al-Isra",
    "Al-Kahf", "Maryam", "Taha", "Al-Anbya", "Al-Hajj", "Al-Mu'minun",
    "An-Nur", "Al-Furqan", "Ash-Shu'ara", "An-Naml", "Al-Qasas",
    "Al-'Ankabut", "Ar-Rum", "Luqman", "As-Sajdah", "Al-Ahzab", "Saba",
    "Fatir", "Ya-Sin", "As-Saffat", "Sad", "Az-Zumar", "Ghafir",
    "Fussilat", "Ash-Shuraa", "Az-Zukhruf", "Ad-Dukhan", "Al-Jathiyah",
    "Al-Ahqaf", "Muhammad", "Al-Fath", "Al-Hujurat", "Qaf",
    "Adh-Dhariyat", "At-Tur", "An-Najm", "Al-Qamar", "Ar-Rahman",
    "Al-Waqi'ah", "Al-Hadid", "Al-Mujadila", "Al-Hashr", "Al-Mumtahanah",
    "As-Saf", "Al-Jumu'ah", "Al-Munafiqun", "At-Taghabun", "At-Talaq",
    "At-Tahrim", "Al-Mulk", "Al-Qalam", "Al-Haqqah", "Al-Ma'arij",
    "Nuh", "Al-Jinn", "Al-Muzzammil", "Al-Muddaththir", "Al-Qiyamah",
    "Al-Insan", "Al-Mursalat", "An-Naba", "An-Nazi'at", "'Abasa",
    "At-Takwir", "Al-Infitar", "Al-Mutaffifin", "Al-Inshiqaq",
    "Al-Buruj", "At-Tariq", "Al-A'la", "Al-Ghashiyah", "Al-Fajr",
    "Al-Balad", "Ash-Shams", "Al-Layl", "Ad-Duhaa", "Ash-Sharh",
    "At-Tin", "Al-'Alaq", "Al-Qadr", "Al-Bayyinah", "Az-Zalzalah",
    "Al-'Adiyat", "Al-Qari'ah", "At-Takathur", "Al-'Asr", "Al-Humazah",
    "Al-Fil", "Quraysh", "Al-Ma'un", "Al-Kawthar", "Al-Kafirun",
    "An-Nasr", "Al-Masad", "Al-Ikhlas", "Al-Falaq", "An-Nas",
]

# Canonical ayah counts, same order as SURAH_NAMES. Total: 6236.
AYAH_COUNTS = [
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52,
    99, 128, 111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88,
    69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89,
    59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22,
    24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20,
    56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26,
    30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4,
    7, 3, 6, 3, 5, 4, 5, 6,
]
assert len(SURAH_NAMES) == 114 and len(AYAH_COUNTS) == 114
assert sum(AYAH_COUNTS) == 6236

# Tafsirs per Quran language: (id, display name, StarDict file).
# Mirrors the bot's QURAN_TAFSIRS (src/quran.ts). Warsh is excluded:
# its ayah numbering differs from the Hafs numbering the StarDict
# keys use (6214 vs 6236 ayahs), so a Warsh + tafsir file would
# mis-link. Hafs only.
TAFSIRS = {
    "ar": [
        ("muyassar", "التفسير الميسر", "quran_tafsir_muyassar_v1.1.zip"),
        ("saddi", "تفسير السعدي", "quran_tafsir_saddi_v1.1.zip"),
        ("baghawi", "تفسير البغوي", "quran_tafsir_baghawi_v1.1.zip"),
        ("ibn_kathir_ar", "تفسير ابن كثير", "quran_tafsir_ibn_kathir_ar_v1.1.zip"),
        ("wasit", "التفسير الوسيط (طنطاوي)", "quran_tafsir_wasit_v1.1.zip"),
        ("qurtubi", "تفسير القرطبي", "quran_tafsir_qurtubi_v1.1.zip"),
        ("tabari", "تفسير الطبري", "quran_tafsir_tabari_v1.1.zip"),
    ],
    "en": [
        ("tazkirul_quran_en", "Tazkirul Quran (Wahiduddin Khan)",
         "quran_tafsir_tazkirul_quran_en_v1.1.zip"),
        ("ibn_kathir_en", "Tafsir Ibn Kathir (Abridged)",
         "quran_tafsir_ibn_kathir_en_v1.1.zip"),
        ("maariful_quran", "Ma'ariful Qur'an (Mufti Shafi)",
         "quran_tafsir_maariful_quran_v1.1.zip"),
    ],
    "ur": [
        ("tazkir_ul_quran_ur", "Tazkir ul Quran (Wahiduddin Khan)",
         "quran_tafsir_tazkir_ul_quran_ur_v1.1.zip"),
        ("bayan_ul_quran", "Bayan ul Quran (Israr Ahmad)",
         "quran_tafsir_bayan_ul_quran_v1.1.zip"),
        ("ibn_kathir_ur", "Tafsir Ibn Kathir",
         "quran_tafsir_ibn_kathir_ur_v1.1.zip"),
        ("fi_zilal_ur", "Fi Zilal al-Quran (Qutb)",
         "quran_tafsir_fi_zilal_ur_v1.1.zip"),
    ],
    "bn": [
        ("ahsanul_bayaan", "Tafsir Ahsanul Bayaan",
         "quran_tafsir_ahsanul_bayaan_v1.1.zip"),
        ("abu_bakr_zakaria", "Tafsir Abu Bakr Zakaria",
         "quran_tafsir_abu_bakr_zakaria_v1.1.zip"),
        ("fathul_majid", "Tafsir Fathul Majid",
         "quran_tafsir_fathul_majid_v1.1.zip"),
        ("ibn_kathir_bn", "Tafsir Ibn Kathir",
         "quran_tafsir_ibn_kathir_bn_v1.1.zip"),
    ],
    "ru": [
        ("saddi_ru", "Tafsir al-Sa'di (Russian)",
         "quran_tafsir_saddi_ru_v1.1.zip"),
    ],
}

# Default translator per non-Arabic language (mirrors the bot) and
# the formats that exist for it in the v0.10.0 release.
TRANSLATORS = {
    "en": "sahih", "fr": "hamidullah", "de": "bubenheim",
    "es": "garcia", "tr": "diyanet", "ur": "jalandhari",
    "id": "ministry", "ru": "kuliev", "bn": "taisirul",
}
FORMATS = {
    "ar": ["arabic"],
    "en": ["bilingual", "interactive", "wbw"],
    "fr": ["bilingual", "interactive", "wbw-en"],
    "de": ["bilingual", "interactive", "wbw-en"],
    "es": ["bilingual", "interactive", "wbw-en"],
    "tr": ["bilingual", "interactive", "wbw", "wbw-en"],
    "ur": ["bilingual", "interactive", "wbw", "wbw-en"],
    "id": ["bilingual", "interactive", "wbw", "wbw-en"],
    "ru": ["bilingual", "interactive", "wbw-en"],
    "bn": ["bilingual", "interactive", "wbw", "wbw-en"],
}
RTL_LANGS = {"ar", "ur"}


def edition_filename(lang, fmt, narration="hafs"):
    """Release asset filename for one edition (mirrors bot quranFileName)."""
    if lang == "ar":
        return f"quran_{narration}_kfgqpc_inline_ar.epub"
    prefix = {"bilingual": "bilin", "interactive": "interactive"}.get(
        fmt, "wbw")
    suffix = "_enwbw" if fmt == "wbw-en" else ""
    return (f"quran_hafs_kfgqpc_{prefix}_ar-{lang}-"
            f"{TRANSLATORS[lang]}{suffix}.epub")


def combined_filename(edition_file, tafsir_id):
    stem = edition_file[:-len(".epub")]
    return f"{stem}--tafsir-{tafsir_id}.epub"


def fetch_bytes(url, cache_dir=None):
    """GET a URL (with a local cache when cache_dir is given)."""
    if cache_dir:
        name = hashlib.sha256(url.encode()).hexdigest()[:16] + "_" + \
            os.path.basename(url)
        path = os.path.join(cache_dir, name)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        data = _http_get(url)
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return data
    return _http_get(url)


def _http_get(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "RliBook-quran-builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        if r.status != 200:
            raise RuntimeError(f"GET {url} -> HTTP {r.status}")
        return r.read()

# ---------------------------------------------------------------------------
# StarDict parsing
# ---------------------------------------------------------------------------

def parse_stardict(zip_bytes):
    """Parse a tafsir ZIP into {(surah, ayah): html-text}.

    A StarDict set: .ifo (wordcount, idxoffsetbits), .idx (key NUL
    + 4-byte offset + 4-byte size, 8-byte offsets when idxoffsetbits
    is 64), .dict (the HTML fragments). Keys are "Surah + ayah
    number" — verified: 6236 entries, 114 surah prefixes, and the
    per-surah counts equal AYAH_COUNTS exactly.
    """
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = z.namelist()
        base = next(n for n in names if n.endswith(".ifo"))
        prefix = base[: -len(".ifo")]
        ifo = {}
        for line in z.read(base).decode("utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                ifo[k.strip()] = v.strip()
        wordcount = int(ifo.get("wordcount", "0"))
        bits64 = ifo.get("idxoffsetbits", "32") == "64"
        idx = z.read(prefix + ".idx")
        dct = z.read(prefix + ".dict")
    entries = {}
    i = 0
    fmt = ">QQ" if bits64 else ">II"
    step = 16 if bits64 else 8
    while i < len(idx):
        j = idx.index(b"\x00", i)
        key = idx[i:j].decode("utf-8")
        off, size = struct.unpack(fmt, idx[j + 1: j + 1 + step])
        entries[key] = dct[off:off + size].decode("utf-8")
        i = j + 1 + step
    assert len(entries) == wordcount, (
        f"idx entries {len(entries)} != ifo wordcount {wordcount}")
    # Map keys onto (surah, ayah). Coverage is usually complete
    # (6236/6236) but an abridged tafsir may legitimately omit a
    # surah — Ibn Kathir (English) has 6231 entries and no Al-Fil
    # at all. So per-surah counts must be <= the canonical count
    # (never more, never an out-of-range ayah), and the shortfall
    # is reported, not fatal: uncovered ayahs simply get no link.
    name_to_num = {name: n + 1 for n, name in enumerate(SURAH_NAMES)}
    by_ayah = {}
    per_surah = {n: 0 for n in range(1, 115)}
    for key, text in entries.items():
        prefix_name, _, ayah = key.rpartition(" ")
        if prefix_name not in name_to_num or not ayah.isdigit():
            raise AssertionError(f"unparsable StarDict key: {key!r}")
        s = name_to_num[prefix_name]
        a = int(ayah)
        assert 1 <= a <= AYAH_COUNTS[s - 1], (
            f"key {key!r}: ayah {a} out of range for surah {s}")
        by_ayah[(s, a)] = text
        per_surah[s] += 1
    missing = []
    for s in range(1, 115):
        assert per_surah[s] <= AYAH_COUNTS[s - 1], (
            f"surah {s} ({SURAH_NAMES[s-1]}): {per_surah[s]} entries, "
            f"more than the {AYAH_COUNTS[s-1]} ayahs — name mapping "
            f"is wrong")
        if per_surah[s] < AYAH_COUNTS[s - 1]:
            missing.append((SURAH_NAMES[s - 1],
                            AYAH_COUNTS[s - 1] - per_surah[s]))
    if missing:
        print(f"coverage: {len(by_ayah)}/6236 ayahs; missing: "
              f"{missing}", file=sys.stderr)
    return by_ayah, ifo.get("bookname", "")


def group_chunks(by_ayah):
    """Group ayahs whose tafsir text is identical (one commentary
    chunk often covers a range, e.g. 'Abasa 9-16).

    Returns {surah: [chunk, ...]} where a chunk is
    {ayahs: [n, ...], first: min(ayahs), text, note_id}.
    6236 ayahs -> 5278 distinct chunks for Muyassar.
    """
    by_text = {}
    for (s, a), text in by_ayah.items():
        by_text.setdefault(hashlib.sha256(text.encode()).hexdigest(),
                           {"surah": s, "ayahs": [], "text": text})
        by_text[hashlib.sha256(text.encode()).hexdigest()]["ayahs"].append(a)
    chunks = {}
    for c in by_text.values():
        c["ayahs"].sort()
        c["first"] = c["ayahs"][0]
        c["note_id"] = f"n-{c['surah']}-{c['first']}"
        chunks.setdefault(c["surah"], []).append(c)
    for s in chunks:
        chunks[s].sort(key=lambda c: c["first"])
    return chunks


# ---------------------------------------------------------------------------
# EPUB injection
# ---------------------------------------------------------------------------

XHTML_NS = "http://www.w3.org/1999/xhtml"
OPF_NS = "http://www.idpf.org/2007/opf"
OPS_NS = "http://www.idpf.org/2007/ops"
DC_NS = "http://purl.org/dc/elements/1.1/"
ET.register_namespace("", XHTML_NS)
ET.register_namespace("epub", OPS_NS)
ET.register_namespace("dc", DC_NS)

AYAH_ID_RE = re.compile(r"^ayah-(\d+)-(\d+)$")
SPAN_RE = re.compile(r"ayah-number")


def _parse_xhtml(data):
    return ET.fromstring(data)


def _xml_bytes(tree, kind="xhtml"):
    # ElementTree picks prefixes at serialisation time from the
    # global registry, so register the right default namespace for
    # the document being written (XHTML for chapters, OPF for the
    # package file — both use a default namespace in the original).
    if kind == "opf":
        ET.register_namespace("", OPF_NS)
        ET.register_namespace("dc", DC_NS)
    else:
        ET.register_namespace("", XHTML_NS)
        ET.register_namespace("epub", OPS_NS)
    return ET.tostring(tree, encoding="utf-8", xml_declaration=True)


def _all_text(tree):
    return "".join(tree.itertext())


def inject_tafsir(epub_bytes, chunks, tafsir_id, tafsir_name, tafsir_lang):
    """Return (new_epub_bytes, stats). Raises AssertionError on any
    structural surprise — a bad build never ships silently."""
    zin = zipfile.ZipFile(io.BytesIO(epub_bytes))
    order = zin.namelist()
    files = {n: zin.read(n) for n in order}
    assert files.get("mimetype", b"").strip() == b"application/epub+zip", \
        "mimetype entry missing or wrong"

    # --- locate the OPF -------------------------------------------------
    container = ET.fromstring(files["META-INF/container.xml"])
    ns_c = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    rootfile = container.find(".//c:rootfile", ns_c)
    opf_path = rootfile.get("full-path")
    opf_dir = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
    opf = ET.fromstring(files[opf_path])
    ns = {"opf": OPF_NS, "dc": DC_NS}
    manifest = opf.find("opf:manifest", ns)
    spine = opf.find("opf:spine", ns)

    # --- chapter files, in spine order ----------------------------------
    chapter_hrefs = []
    for ref in spine.findall("opf:itemref", ns):
        item = manifest.find(f"opf:item[@id='{ref.get('idref')}']", ns)
        if item is not None and item.get("media-type") == \
                "application/xhtml+xml":
            chapter_hrefs.append(item.get("href"))
    chapter_files = [h for h in chapter_hrefs
                     if re.match(r"chapter-\d+\.xhtml$", h)]
    assert len(chapter_files) == 114, \
        f"expected 114 chapter files, got {len(chapter_files)}"

    # --- note lookup: (surah, ayah) -> note id + file -------------------
    note_of = {}
    for s, clist in chunks.items():
        for c in clist:
            for a in c["ayahs"]:
                note_of[(s, a)] = (f"tafsir-{s}.xhtml", c["note_id"])

    # --- rewrite every chapter ------------------------------------------
    total_spans = 0
    linked = 0
    for href in chapter_files:
        path = opf_dir + href
        before = files[path].decode("utf-8")
        tree = _parse_xhtml(files[path])
        text_before = _all_text(tree)
        parent = {c: p for p in tree.iter() for c in p}
        # Every ayah-number span, with its nearest ancestor-or-self
        # carrying id="ayah-S-A" (the anchor sits on the span in the
        # Arabic/interactive editions, on the <p> in bilingual, on
        # the <div class="wbw-ayah"> in word-by-word).
        for span in list(tree.iter(f"{{{XHTML_NS}}}span")):
            cls = span.get("class") or ""
            if "ayah-number" not in cls.split():
                continue
            total_spans += 1
            node, ayah = span, None
            while node is not None:
                m = AYAH_ID_RE.match(node.get("id") or "")
                if m:
                    ayah = (int(m.group(1)), int(m.group(2)))
                    break
                node = parent.get(node)
            assert ayah is not None, \
                f"{path}: ayah-number span with no ayah-S-A ancestor"
            # An abridged tafsir may not cover this ayah (e.g. Ibn
            # Kathir (en) has no Al-Fil): leave the number unlinked
            # rather than linking it to the wrong note.
            if ayah not in note_of:
                continue
            target_file, note_id = note_of[ayah]
            a = ET.Element(f"{{{XHTML_NS}}}a", {
                "href": f"{target_file}#{note_id}",
                f"{{{OPS_NS}}}type": "noteref",
                "class": "tafsir-ref",
            })
            par = parent[span]
            idx = list(par).index(span)
            tail = span.tail
            span.tail = None
            # Detach FIRST: ElementTree append() does not remove the
            # element from its old parent, so appending before
            # removing would leave the span in two places.
            par.remove(span)
            a.append(span)
            a.tail = tail
            par.insert(idx, a)
            linked += 1
        # The text must be byte-identical apart from the added links:
        # injection must never lose or alter Quran text.
        assert _all_text(tree) == text_before, \
            f"{path}: text changed during injection"
        files[path] = _xml_bytes(tree, "xhtml")
    assert total_spans == 6236, \
        f"expected 6236 ayah-number spans, found {total_spans}"
    # Every tafsir entry must have been linked exactly once; ayahs
    # the tafsir does not cover stay unlinked (see above).
    assert linked == len(note_of), \
        f"linked {linked} ayahs but tafsir covers {len(note_of)}"

    # --- one note file per surah the tafsir covers ------------------------
    rtl = "rtl" if tafsir_lang in RTL_LANGS else "ltr"
    covered_surahs = sorted(chunks.keys())
    for s in covered_surahs:
        clist = chunks[s]
        parts = [
            '<?xml version="1.0" encoding="utf-8"?>',
            f'<html xmlns="{XHTML_NS}" xmlns:epub="{OPS_NS}" '
            f'xml:lang="{tafsir_lang}" lang="{tafsir_lang}" dir="{rtl}">',
            "<head><meta charset=\"utf-8\"/>",
            f"<title>{SURAH_NAMES[s-1]} — {tafsir_name}</title>",
            '<link rel="stylesheet" type="text/css" href="styles/base.css"/>',
            "<style>section.footnote{margin:1em 0} "
            "p.tafsir-back{margin-top:1.5em;font-size:.9em}</style>",
            "</head><body>",
            f"<h1>{SURAH_NAMES[s-1]} — {tafsir_name}</h1>",
        ]
        for c in clist:
            frag = _fragment_to_elements(c["text"])
            parts.append(
                f'<section epub:type="footnote" id="{c["note_id"]}">')
            parts.extend(frag)
            first = c["first"]
            parts.append(
                f'<p class="tafsir-back"><a epub:type="backlink" '
                f'href="chapter-{s}.xhtml#ayah-{s}-{first}">'
                f"↩ {s}:{first}</a></p>")
            parts.append("</section>")
        parts.append("</body></html>")
        data = "\n".join(parts).encode("utf-8")
        # The generated file must be well-formed XHTML.
        _parse_xhtml(data)
        files[opf_dir + f"tafsir-{s}.xhtml"] = data

    # --- OPF: manifest + spine + title + identifier ----------------------
    title_el = opf.find("opf:metadata/dc:title", ns)
    orig_title = title_el.text or ""
    title_el.text = f"{orig_title} + {tafsir_name}"
    ident_el = opf.find("opf:metadata/dc:identifier", ns)
    if ident_el is not None:
        ident_el.text = f"urn:uuid:{uuid.uuid4()}"
    modified = opf.find(
        "opf:metadata/opf:meta[@property='dcterms:modified']", ns)
    if modified is not None:
        modified.text = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
    for s in covered_surahs:
        item = ET.SubElement(manifest, f"{{{OPF_NS}}}item", {
            "id": f"tafsir-{s}",
            "href": f"tafsir-{s}.xhtml",
            "media-type": "application/xhtml+xml",
        })
        ET.SubElement(spine, f"{{{OPF_NS}}}itemref", {
            "idref": f"tafsir-{s}", "linear": "no",
        })
    files[opf_path] = _xml_bytes(opf, "opf")

    # --- navigation: one entry at the end of the TOC nav ------------------
    toc_path = opf_dir + "toc.xhtml"
    if toc_path in files:
        toc = files[toc_path].decode("utf-8")
        anchor = re.search(
            r'(<li><a href="chapter-114\.xhtml"[^<]*</a></li>)', toc)
        if anchor:
            entry = (anchor.group(1) +
                     f'\n            <li><a href="tafsir-1.xhtml">'
                     f"التفسير: {tafsir_name}</a></li>")
            toc = toc[:anchor.start()] + entry + toc[anchor.end():]
            _parse_xhtml(toc.encode("utf-8"))
            files[toc_path] = toc.encode("utf-8")
        else:
            print("warning: toc nav anchor not found — no nav entry added",
                  file=sys.stderr)

    # --- write the new EPUB (mimetype first, stored) ----------------------
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("mimetype", files["mimetype"],
                   compress_type=zipfile.ZIP_STORED)
        for name in order:
            if name == "mimetype":
                continue
            z.writestr(name, files[name],
                       compress_type=zipfile.ZIP_DEFLATED)
        for s in covered_surahs:
            z.writestr(opf_dir + f"tafsir-{s}.xhtml",
                       files[opf_dir + f"tafsir-{s}.xhtml"],
                       compress_type=zipfile.ZIP_DEFLATED)
    stats = {
        "tafsir_id": tafsir_id,
        "tafsir_name": tafsir_name,
        "ayahs_linked": linked,
        "ayahs_covered": len(note_of),
        "ayahs_unlinked": 6236 - linked,
        "chunks": sum(len(v) for v in chunks.values()),
        "note_files": len(covered_surahs),
        "orig_title": orig_title,
        "size": len(buf.getvalue()),
    }
    return buf.getvalue(), stats


def _fragment_to_elements(fragment):
    """Serialise a StarDict HTML fragment (<p><b>..</b></p><div>..</div>)
    into a list of well-formed XHTML strings.

    The fragments are HTML, not XHTML, so a strict XML parse fails
    on real upstream content: bare <br> (Sa'di, 8 fragments),
    unquoted attributes and the custom <quran ref=/9/26-26> cross-
    reference element (Tazkirul Quran, 77 fragments). This parser
    is tolerant like a browser -- void elements self-close, unquoted
    attributes are read as-is, stray end tags and unclosed tags are
    balanced -- and it turns <quran ref="/S/A-B"> into a real link
    to that verse. The note file is re-parsed after assembly, so a
    fragment this cannot balance still fails the build loudly.
    """
    from html.parser import HTMLParser
    import html as _html

    VOID = {"br", "hr", "img", "input", "meta", "link", "wbr"}

    class _P(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts = []
            self.stack = []

        def _attrs(self, attrs):
            out = ""
            for k, v in attrs:
                # Drop attribute names that are not valid XML names
                # (e.g. a stray word the parser read as an attribute
                # after a typo) — emitting them would break the file.
                if not re.match(r"^[A-Za-z_][A-Za-z0-9_.\-]*$", k or ""):
                    continue
                if v is None:
                    v = ""
                out += f' {k}="{_html.escape(v, quote=True)}"'
            return out

        def handle_starttag(self, tag, attrs):
            tag = tag.lower()
            if not re.match(r"^[a-z][a-z0-9-]*$", tag):
                # Not a real tag name (e.g. a typo the pre-fix did
                # not catch): keep it as literal text, never emit
                # it as markup.
                self.parts.append(_html.escape(f"<{tag}>"))
                return
            if tag == "quran":
                ref = dict(attrs).get("ref", "")
                m = re.match(r"^/(\d+)/(\d+)(?:-\d+)?$", ref)
                if m:
                    self.parts.append(
                        f'<a href="chapter-{m.group(1)}.xhtml'
                        f'#ayah-{m.group(1)}-{m.group(2)}">')
                    self.stack.append("a")
                else:
                    self.parts.append("<span>")
                    self.stack.append("span")
                return
            if tag in VOID:
                self.parts.append(f"<{tag}{self._attrs(attrs)}/>")
                return
            self.parts.append(f"<{tag}{self._attrs(attrs)}>")
            self.stack.append(tag)

        def handle_startendtag(self, tag, attrs):
            tag = tag.lower()
            if tag == "quran":
                return
            self.parts.append(f"<{tag}{self._attrs(attrs)}/>")

        def handle_endtag(self, tag):
            tag = tag.lower()
            if not re.match(r"^[a-z][a-z0-9-]*$", tag):
                return
            if tag in VOID:
                return
            if tag == "quran":
                tag = "a"
            # Close tags up to the matching one (browser behaviour
            # for a stray or mismatched end tag).
            if tag in self.stack:
                while self.stack:
                    top = self.stack.pop()
                    self.parts.append(f"</{top}>")
                    if top == tag:
                        break

        def handle_data(self, data):
            self.parts.append(_html.escape(data))

        def finish(self):
            while self.stack:
                self.parts.append(f"</{self.stack.pop()}>")
            return self.parts

    # Upstream typo: a stray "<" where ">" belongs, e.g. "<b<"
    # (Ibn Kathir bn, Al-Ma'arij 8-18: "<b< ৮-১৮ ..." means "<b>"
    # then the text). Replace it with the closing bracket.
    fragment = re.sub(r"<([a-zA-Z]+)<", r"<\1>", fragment)
    p = _P()
    p.feed(fragment)
    p.close()
    out = p.finish()
    assert out, "empty tafsir fragment"
    return out

# ---------------------------------------------------------------------------
# Verification (independent re-read of the built file)
# ---------------------------------------------------------------------------

def verify_epub(path, tafsir_id=None, expected_noterefs=None,
                expected_notes=None):
    """Re-open a built EPUB and check everything a reader needs.

    Returns a report dict. Raises AssertionError on any failure.
    expected_noterefs / expected_notes are the counts the build
    promised (the tafsir's covered ayahs / distinct chunks); when
    given they must match exactly.
    """
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None, "zip CRC failure"
        names = z.namelist()
        assert names[0] == "mimetype", "mimetype must be the first entry"
        info = z.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED, \
            "mimetype must be stored, not deflated"
        assert z.read("mimetype").strip() == b"application/epub+zip"
        files = {n: z.read(n) for n in names}
    container = ET.fromstring(files["META-INF/container.xml"])
    ns_c = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    opf_path = container.find(".//c:rootfile", ns_c).get("full-path")
    opf_dir = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
    opf = ET.fromstring(files[opf_path])
    ns = {"opf": OPF_NS, "dc": DC_NS}
    manifest = {i.get("id"): i for i in opf.find("opf:manifest", ns)}
    spine = [r.get("idref") for r in opf.find("opf:spine", ns)]
    note_items = sorted(i for i in manifest if i.startswith("tafsir-"))
    assert note_items, "no tafsir files in the manifest"
    # The spine keeps the original items (cover, toc, 114 chapters —
    # plus, in bilingual/interactive/wbw editions, the translator
    # endnotes file) and gains the note files at the end, linear="no".
    spine_items = list(opf.find("opf:spine", ns))
    spine = [r.get("idref") for r in spine_items]
    linear = {r.get("idref"): r.get("linear") for r in spine_items}
    assert "cover" in spine and "toc" in spine, "cover/toc lost from spine"
    for s in range(1, 115):
        assert f"chapter-{s}" in spine, f"chapter-{s} lost from spine"
    last_chapter = max(spine.index(f"chapter-{s}") for s in range(1, 115))
    for item_id in note_items:
        assert item_id in spine, f"{item_id} missing from spine"
        assert linear.get(item_id) == "no", f"{item_id} is not linear='no'"
        assert spine.index(item_id) > last_chapter, \
            f"{item_id} is not after the chapters in the spine"
    note_ids = set()
    for item_id in note_items:
        href = manifest[item_id].get("href")
        tree = ET.fromstring(files[opf_dir + href])
        for sec in tree.iter(f"{{{XHTML_NS}}}section"):
            assert sec.get(f"{{{OPS_NS}}}type") == "footnote"
            note_ids.add((href, sec.get("id")))
    # Every noteref link resolves to a real note; every backlink
    # resolves to a real ayah anchor. Bilingual/interactive/wbw
    # editions ALSO carry the translator's own endnotes links
    # (endnotes.xhtml#fn-...) — those are upstream's, so they are
    # checked against their own target file, while only the
    # tafsir-ref links (ours) are counted against the tafsir notes.
    ids_by_file = {}
    for name, data in files.items():
        if not name.endswith(".xhtml"):
            continue
        tree = ET.fromstring(data)
        ids_by_file[name.rsplit("/", 1)[-1]] = {
            el.get("id") for el in tree.iter() if el.get("id")}
    anchors = set()
    noterefs = 0
    for s in range(1, 115):
        tree = ET.fromstring(files[f"{opf_dir}chapter-{s}.xhtml"])
        for el in tree.iter():
            if el.get("id"):
                anchors.add((f"chapter-{s}.xhtml", el.get("id")))
        for a in tree.iter(f"{{{XHTML_NS}}}a"):
            if a.get(f"{{{OPS_NS}}}type") == "noteref":
                href, _, frag = a.get("href").partition("#")
                assert frag in ids_by_file.get(href, set()), \
                    f"dangling noteref: {a.get('href')}"
                if "tafsir-ref" in (a.get("class") or "").split():
                    noterefs += 1
                    assert (href, frag) in note_ids, \
                        f"tafsir noteref outside the notes: {a.get('href')}"
    assert noterefs > 0, "no noteref links found"
    if expected_noterefs is not None:
        assert noterefs == expected_noterefs, \
            f"expected {expected_noterefs} noterefs, got {noterefs}"
    backlinks = 0
    for item_id in note_items:
        href = manifest[item_id].get("href")
        tree = ET.fromstring(files[opf_dir + href])
        for a in tree.iter(f"{{{XHTML_NS}}}a"):
            if a.get(f"{{{OPS_NS}}}type") == "backlink":
                backlinks += 1
                href2, _, frag = a.get("href").partition("#")
                assert (href2, frag) in anchors, \
                    f"dangling backlink: {a.get('href')}"
    assert backlinks == len(note_ids), \
        f"backlinks {backlinks} != notes {len(note_ids)}"
    if expected_notes is not None:
        assert len(note_ids) == expected_notes, \
            f"expected {expected_notes} notes, got {len(note_ids)}"
    # All XHTML in the book still parses (chapters + notes + toc).
    for n, data in files.items():
        if n.endswith((".xhtml", ".opf", ".xml")):
            ET.fromstring(data)
    title = opf.find("opf:metadata/dc:title", ns).text
    size = os.path.getsize(path)
    return {
        "file": os.path.basename(path),
        "size": size,
        "title": title,
        "notes": len(note_ids),
        "noterefs": noterefs,
        "backlinks": backlinks,
        "tafsir_id": tafsir_id,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_source(spec, cache_dir=None):
    if spec.startswith("http://") or spec.startswith("https://"):
        return fetch_bytes(spec, cache_dir)
    with open(spec, "rb") as f:
        return f.read()


def cmd_build(args):
    epub_bytes = _load_source(args.epub, args.cache_dir)
    tafsir_bytes = _load_source(args.tafsir, args.cache_dir)
    by_ayah, bookname = parse_stardict(tafsir_bytes)
    print(f"tafsir: {bookname or args.tafsir_id} — "
          f"{len(by_ayah)} ayahs", file=sys.stderr)
    chunks = group_chunks(by_ayah)
    out, stats = inject_tafsir(epub_bytes, chunks, args.tafsir_id,
                               args.tafsir_name, args.tafsir_lang)
    with open(args.out, "wb") as f:
        f.write(out)
    report = verify_epub(args.out, args.tafsir_id,
                         expected_noterefs=stats["ayahs_linked"],
                         expected_notes=stats["chunks"])
    print(json.dumps({**stats, **report}, ensure_ascii=False, indent=2))
    return 0


def cmd_build_all(args):
    langs = [l.strip() for l in args.langs.split(",") if l.strip()]
    os.makedirs(args.out_dir, exist_ok=True)
    manifest = []
    epub_cache = {}
    tafsir_cache = {}
    for lang in langs:
        for tafsir_id, tafsir_name, tafsir_file in TAFSIRS.get(lang, []):
            for fmt in FORMATS[lang]:
                edition = edition_filename(lang, fmt)
                epub_url = f"{QURAN_DOWNLOAD_BASE}/{QURAN_TAG}/{edition}"
                if epub_url not in epub_cache:
                    print(f"fetch {edition} ...", file=sys.stderr)
                    epub_cache[epub_url] = fetch_bytes(
                        epub_url, args.cache_dir)
                tafsir_url = f"{QURAN_TAFSIR_BASE}/{tafsir_file}"
                if tafsir_url not in tafsir_cache:
                    print(f"fetch {tafsir_file} ...", file=sys.stderr)
                    tafsir_cache[tafsir_url] = parse_stardict(
                        fetch_bytes(tafsir_url, args.cache_dir))
                by_ayah, _ = tafsir_cache[tafsir_url]
                chunks = group_chunks(by_ayah)
                out_name = combined_filename(edition, tafsir_id)
                out_path = os.path.join(args.out_dir, out_name)
                print(f"build {out_name} ...", file=sys.stderr)
                out, stats = inject_tafsir(
                    epub_cache[epub_url], chunks, tafsir_id,
                    tafsir_name, lang)
                with open(out_path, "wb") as f:
                    f.write(out)
                report = verify_epub(
                    out_path, tafsir_id,
                    expected_noterefs=stats["ayahs_linked"],
                    expected_notes=stats["chunks"])
                digest = hashlib.sha256(out).hexdigest()
                manifest.append({
                    "lang": lang, "format": fmt, "narration": "hafs",
                    "tafsir": tafsir_id, "tafsir_name": tafsir_name,
                    "edition_file": edition, "file": out_name,
                    "url": f"{COMBINED_BASE}/{out_name}",
                    "size": report["size"], "sha256": digest,
                    "notes": report["notes"],
                })
                print(f"  ok {out_name} "
                      f"({report['size']} bytes, "
                      f"{report['notes']} notes)", file=sys.stderr)
    with open(os.path.join(args.out_dir, "manifest.json"), "w") as f:
        json.dump({"tag": COMBINED_TAG, "files": manifest}, f,
                  ensure_ascii=False, indent=2)
    print(f"built {len(manifest)} combined EPUBs -> {args.out_dir}")
    return 0


def cmd_verify(args):
    print(json.dumps(verify_epub(args.epub, args.tafsir_id),
                     ensure_ascii=False, indent=2))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build one combined EPUB")
    b.add_argument("--epub", required=True)
    b.add_argument("--tafsir", required=True)
    b.add_argument("--tafsir-id", required=True)
    b.add_argument("--tafsir-name", required=True)
    b.add_argument("--tafsir-lang", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--cache-dir")
    b.set_defaults(fn=cmd_build)
    a = sub.add_parser("build-all", help="build every hafs combination")
    a.add_argument("--out-dir", required=True)
    a.add_argument("--langs", default="ar,en,ur,bn,ru")
    a.add_argument("--cache-dir")
    a.set_defaults(fn=cmd_build_all)
    v = sub.add_parser("verify", help="verify a built EPUB")
    v.add_argument("--epub", required=True)
    v.add_argument("--tafsir-id")
    v.set_defaults(fn=cmd_verify)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
