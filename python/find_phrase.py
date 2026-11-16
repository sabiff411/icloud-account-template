#!/usr/bin/env python3
"""Search one account's notes, Drive documents and scans for a wallet passphrase.

    find_phrase.py <email>

Looks for the words people use ("secret recovery phrase", "passphrase", "seed",
"mnemonic", "wallet"), for 12/24-word blocks of plausible wordlist words, and
for wallet addresses (0x…, bc1…, 1…/3…).
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, "/opt/icloud3/python")
from bulk_images import EXPORT  # noqa: E402

KEYWORDS = (
    "passphrase", "pass phrase", "recovery phrase", "secret phrase", "seed phrase",
    "mnemonic", "secret recovery", "wallet", "trust wallet", "metamask", "exodus",
)
ADDRESS = re.compile(r"\b(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b")
WORD = r"[a-z]{3,8}"
BLOCK12 = re.compile(rf"\b(?:{WORD}[\s,;]+){{11}}{WORD}\b")
TEXT_SUFFIX = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".rtf"}
DOC_SUFFIX = {".pdf"}


def pdf_text(path: Path) -> str:
    try:
        import pymupdf

        with pymupdf.open(str(path)) as doc:
            return "\n".join(page.get_text() for page in doc)
    except Exception as error:  # noqa: BLE001
        return f"[pdf error {error}]"


def docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", "ignore")
        xml = re.sub(r"</w:p>", "\n", xml)
        return re.sub(r"<[^>]+>", " ", xml)
    except Exception as error:  # noqa: BLE001
        return f"[docx error {error}]"


def text_of(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in DOC_SUFFIX:
        return pdf_text(path)
    if suffix == ".docx":
        return docx_text(path)
    if suffix in TEXT_SUFFIX:
        try:
            return path.read_text(errors="ignore")
        except Exception:
            return ""
    return ""


def hits(label: str, text: str) -> None:
    lower = text.lower()
    for keyword in KEYWORDS:
        index = lower.find(keyword)
        while index != -1:
            snippet = " ".join(text[max(0, index - 90) : index + 160].split())
            print(f"  [{label}] {keyword!r}: …{snippet}…")
            index = lower.find(keyword, index + len(keyword))
            break
    for match in ADDRESS.finditer(text):
        print(f"  [{label}] ADDRESS {match.group(0)}")
    for match in BLOCK12.finditer(text):
        words = re.split(r"[\s,;]+", match.group(0))
        if 11 <= len(words) <= 25:
            print(f"  [{label}] {len(words)}-WORD BLOCK: {' '.join(words)}")


def main() -> None:
    email = sys.argv[1]
    base = EXPORT / email
    roots = [
        base / "Notes" / "txt",
        base / "Notes" / "html",
        base / "Drive",
        base / "Scan" / "ocr",
    ]
    scanned = 0
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            text = text_of(path)
            if not text.strip():
                continue
            scanned += 1
            hits(str(path.relative_to(base)), text)
    print(f"scanned {scanned} text-bearing files")


if __name__ == "__main__":
    main()
