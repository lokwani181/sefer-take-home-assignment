#!/usr/bin/env python3
"""
Generate raw DocumentLayout fixtures for the T7 synthetic shipments (samples/synthetic/*),
so the parser's generalization tests run offline and deterministically.

  python3 server/test/parse/fixtures/make-synthetic-layouts.py

Reuses the reference layout implementation in scripts/make-layout-fixtures.py (text layer via
pdftotext -bbox-layout; scans via pdftoppm 300 dpi + tesseract --psm 11, deskew, y-clustered
lines; no stamp suppression = worst case). Output: server/test/parse/fixtures/synthetic/<case>/<file>.layout.json
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
spec = importlib.util.spec_from_file_location("layoutref", os.path.join(ROOT, "scripts", "make-layout-fixtures.py"))
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)

SYN = os.path.join(ROOT, "samples", "synthetic")
OUT = os.path.join(HERE, "synthetic")


def build(pdf, doc_id):
    file_name = os.path.basename(pdf)
    text = ref.run(["pdftotext", "-layout", pdf, "-"])
    has_text = len(re.sub(r"\s", "", text)) >= ref.MIN_TEXT_CHARS
    raw_pages = ref.text_layer_pages(pdf) if has_text else ref.ocr_pages(pdf)
    pages = []
    for i, p in enumerate(raw_pages, start=1):
        slope = ref.estimate_skew(p["tess_lines"]) if not has_text else 0.0
        words = ref.deskew(p["words"], p["width"], p["height"], slope)
        pages.append({
            "page": i, "width": p["width"], "height": p["height"],
            "source": "text" if has_text else "ocr",
            "skewDeg": round(ref.math.degrees(ref.math.atan(slope)), 3),
            "words": words, "lines": ref.group_lines(words),
        })
    sha = ref.hashlib.sha256(open(pdf, "rb").read()).hexdigest()
    return {"docId": doc_id, "fileName": file_name, "sha256": sha, "mime": "application/pdf", "pages": pages}


def main():
    only = sys.argv[1:]
    for case in sorted(os.listdir(SYN)):
        d = os.path.join(SYN, case)
        if not os.path.isdir(d) or (only and case not in only):
            continue
        os.makedirs(os.path.join(OUT, case), exist_ok=True)
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(".pdf"):
                continue
            layout = build(os.path.join(d, f), f"{case}:{f}")
            path = os.path.join(OUT, case, f[:-4] + ".layout.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(layout, fh, indent=1, ensure_ascii=False)
            for p in layout["pages"]:
                print(f"{case}/{f} p{p['page']}: source={p['source']} skew={p['skewDeg']} words={len(p['words'])} lines={len(p['lines'])}")


if __name__ == "__main__":
    main()
