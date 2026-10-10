#!/usr/bin/env python3
"""
Generate raw layout fixtures (DocumentLayout JSON) for the sample documents.

  python3 scripts/make-layout-fixtures.py

Reference implementation of the layout contract in packages/shared/src/types.ts,
so parser work (T2) can start before the TypeScript ingest module (T1) exists.
No image preprocessing (no stamp suppression), so this is the worst case input.

  text-layer pages : pdftotext -bbox-layout, points scaled to 300 DPI pixels, conf 100
  scanned pages    : pdftoppm -r 300 → tesseract --psm 11 tsv, words with conf >= 0
  then             : skew estimated from tesseract line slopes, coordinates rotated,
                     words clustered into visual lines by y-centre
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "server", "test", "fixtures", "sample")
DPI = 300
SCALE = DPI / 72.0
MIN_TEXT_CHARS = 50

SAMPLES = [
    ("sample-ci", "KBAS-NB-26-0912_Commercial_Invoice.pdf", "invoice"),
    ("sample-pl", "SPG-PL-2609-117_Packing_List.pdf", "packing-list"),
    ("sample-bl", "BMLVHCM26090418_House_BL.pdf", "bill-of-lading"),
]


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def text_layer_pages(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "bbox.html")
        run(["pdftotext", "-bbox-layout", pdf, out])
        html = open(out, encoding="utf-8").read()
    # The XHTML has a DOCTYPE and namespace; strip both so ElementTree can parse it.
    html = re.sub(r"<!DOCTYPE[^>]*>", "", html)
    html = re.sub(r'\sxmlns="[^"]+"', "", html, count=1)
    root = ET.fromstring(html)
    pages = []
    for page in root.iter("page"):
        words = []
        for w in page.iter("word"):
            text = (w.text or "").strip()
            if not text:
                continue
            words.append({
                "text": text,
                "x0": round(float(w.get("xMin")) * SCALE, 1),
                "y0": round(float(w.get("yMin")) * SCALE, 1),
                "x1": round(float(w.get("xMax")) * SCALE, 1),
                "y1": round(float(w.get("yMax")) * SCALE, 1),
                "conf": 100,
            })
        pages.append({
            "width": round(float(page.get("width")) * SCALE),
            "height": round(float(page.get("height")) * SCALE),
            "words": words,
            "tess_lines": None,
        })
    return pages


def ocr_pages(pdf):
    pages = []
    with tempfile.TemporaryDirectory() as tmp:
        run(["pdftoppm", "-r", str(DPI), "-png", pdf, os.path.join(tmp, "p")])
        for img in sorted(f for f in os.listdir(tmp) if f.endswith(".png")):
            path = os.path.join(tmp, img)
            tsv = run(["tesseract", path, "-", "--psm", "11", "-l", "eng", "tsv"])
            size = run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]) if sys.platform == "darwin" else ""
            m_w = re.search(r"pixelWidth: (\d+)", size)
            m_h = re.search(r"pixelHeight: (\d+)", size)
            words, lines = [], {}
            rows = tsv.splitlines()
            header = rows[0].split("\t")
            idx = {k: i for i, k in enumerate(header)}
            width = height = None
            for r in rows[1:]:
                c = r.split("\t")
                if len(c) < len(header):
                    continue
                if c[idx["level"]] == "1":
                    width, height = int(c[idx["width"]]), int(c[idx["height"]])
                text = c[idx["text"]].strip()
                conf = float(c[idx["conf"]])
                if c[idx["level"]] != "5" or not text or conf < 0:
                    continue
                x0, y0 = int(c[idx["left"]]), int(c[idx["top"]])
                w = {"text": text, "x0": x0, "y0": y0,
                     "x1": x0 + int(c[idx["width"]]), "y1": y0 + int(c[idx["height"]]),
                     "conf": round(conf)}
                words.append(w)
                key = (c[idx["block_num"]], c[idx["par_num"]], c[idx["line_num"]])
                lines.setdefault(key, []).append(w)
            pages.append({
                "width": width or (int(m_w.group(1)) if m_w else 0),
                "height": height or (int(m_h.group(1)) if m_h else 0),
                "words": words,
                "tess_lines": list(lines.values()),
            })
    return pages


def estimate_skew(tess_lines):
    """Median slope (dy/dx) of tesseract lines with >= 3 words spanning >= 300px."""
    slopes = []
    for ws in tess_lines or []:
        if len(ws) < 3:
            continue
        xs = [(w["x0"] + w["x1"]) / 2 for w in ws]
        ys = [(w["y0"] + w["y1"]) / 2 for w in ws]
        if max(xs) - min(xs) < 300:
            continue
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        den = sum((x - mx) ** 2 for x in xs)
        if den == 0:
            continue
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
        if abs(slope) < 0.1:
            slopes.append(slope)
    if not slopes:
        return 0.0
    slopes.sort()
    return slopes[len(slopes) // 2]


def deskew(words, width, height, slope):
    """Rotate word boxes about the page centre so that lines with the given slope become horizontal."""
    if slope == 0:
        return words
    th = math.atan(slope)
    cos, sin = math.cos(th), math.sin(th)
    cx, cy = width / 2, height / 2
    out = []
    for w in words:
        mx, my = (w["x0"] + w["x1"]) / 2, (w["y0"] + w["y1"]) / 2
        hw, hh = (w["x1"] - w["x0"]) / 2, (w["y1"] - w["y0"]) / 2
        nx = cx + (mx - cx) * cos + (my - cy) * sin
        ny = cy - (mx - cx) * sin + (my - cy) * cos
        out.append({**w, "x0": round(nx - hw, 1), "y0": round(ny - hh, 1),
                    "x1": round(nx + hw, 1), "y1": round(ny + hh, 1)})
    return out


def group_lines(words):
    """Cluster words into visual lines by y-centre (tolerance = 0.5 × median word height)."""
    if not words:
        return []
    heights = sorted(w["y1"] - w["y0"] for w in words)
    tol = max(4.0, heights[len(heights) // 2] * 0.5)
    lines = []
    for w in sorted(words, key=lambda w: (w["y0"] + w["y1"]) / 2):
        yc = (w["y0"] + w["y1"]) / 2
        if lines and abs(yc - lines[-1]["yc"]) <= tol:
            ln = lines[-1]
            ln["words"].append(w)
            ln["yc"] = sum((x["y0"] + x["y1"]) / 2 for x in ln["words"]) / len(ln["words"])
        else:
            lines.append({"yc": yc, "words": [w]})
    result = []
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w["x0"])
        result.append({
            "text": " ".join(w["text"] for w in ws),
            "words": ws,
            "x0": min(w["x0"] for w in ws), "y0": min(w["y0"] for w in ws),
            "x1": max(w["x1"] for w in ws), "y1": max(w["y1"] for w in ws),
        })
    return result


def build(doc_id, file_name):
    pdf = os.path.join(ROOT, "samples", file_name)
    text = run(["pdftotext", "-layout", pdf, "-"])
    has_text = len(re.sub(r"\s", "", text)) >= MIN_TEXT_CHARS
    raw_pages = text_layer_pages(pdf) if has_text else ocr_pages(pdf)
    pages = []
    for i, p in enumerate(raw_pages, start=1):
        slope = estimate_skew(p["tess_lines"]) if not has_text else 0.0
        words = deskew(p["words"], p["width"], p["height"], slope)
        pages.append({
            "page": i,
            "width": p["width"],
            "height": p["height"],
            "source": "text" if has_text else "ocr",
            "skewDeg": round(math.degrees(math.atan(slope)), 3),
            "words": words,
            "lines": group_lines(words),
        })
    sha = hashlib.sha256(open(pdf, "rb").read()).hexdigest()
    return {"docId": doc_id, "fileName": file_name, "sha256": sha, "mime": "application/pdf", "pages": pages}


def main():
    os.makedirs(OUT, exist_ok=True)
    for doc_id, file_name, slug in SAMPLES:
        layout = build(doc_id, file_name)
        path = os.path.join(OUT, f"{slug}.layout.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(layout, f, indent=1, ensure_ascii=False)
        for p in layout["pages"]:
            print(f"{slug} p{p['page']}: source={p['source']} skew={p['skewDeg']}° "
                  f"words={len(p['words'])} lines={len(p['lines'])} size={p['width']}x{p['height']}")


if __name__ == "__main__":
    main()
