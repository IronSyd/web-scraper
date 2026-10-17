"""Read-only geometry/text validation and rendering of a synthetic offline fixture."""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

PDF = Path(sys.argv[1]).resolve()
pdftoppm = os.environ.get("WSP_PDFTOPPM_EXE") or shutil.which("pdftoppm")
if not pdftoppm:
    raise SystemExit(
        "PDF verification requires Poppler pdftoppm on PATH or an absolute WSP_PDFTOPPM_EXE."
    )
POPLER = Path(pdftoppm)
if not POPLER.is_absolute() or not POPLER.is_file() or not os.access(POPLER, os.X_OK):
    raise SystemExit("WSP_PDFTOPPM_EXE must identify an existing absolute executable.")
reader = PdfReader(PDF)
texts = [page.extract_text() for page in reader.pages]
errors = []
rows = {}
for prefix in ("OTHER", "HISTORY", "AWARD"):
    for index in range(1, 5):
        start = f"{prefix}_{index}_START"
        end = f"{prefix}_{index}_END"
        starts = [i + 1 for i, text in enumerate(texts) if start in text]
        ends = [i + 1 for i, text in enumerate(texts) if end in text]
        rows[start] = {"start_pages": starts, "end_pages": ends}
        if len(starts) != 1 or starts != ends:
            errors.append(f"Split/missing row: {start}")
chart_top = [i + 1 for i, text in enumerate(texts) if "CHART_TOP_SENTINEL" in text]
chart_bottom = [i + 1 for i, text in enumerate(texts) if "CHART_BOTTOM_SENTINEL" in text]
if len(chart_top) != 1 or chart_top != chart_bottom:
    errors.append("Split/missing chart")
for token in ("HEADLINE_PRESERVED", "FAQ_PRESERVED", "CTA_PRESERVED", "FOOTER_PRESERVED"):
    if sum(text.count(token) for text in texts) != 1:
        errors.append(f"Missing/duplicate protected text: {token}")
for index in range(1, 21):
    if not re.search(rf"\bLanguage\s+{index}\b", " ".join(texts)):
        errors.append(f"Missing ranking name: Language {index}")
headers = {}
for token in ("OTHER_REPEAT_HEADER", "HISTORY_REPEAT_HEADER", "AWARD_REPEAT_HEADER"):
    pages = [i + 1 for i, text in enumerate(texts) if token in text]
    headers[token] = pages
    prefix = token.split("_")[0]
    content_pages = {
        i + 1
        for i, text in enumerate(texts)
        if any(f"{prefix}_{row}_START" in text for row in range(1, 5))
    }
    if not content_pages.issubset(pages):
        errors.append(f"Missing repeated header: {token}")
word_count = 0
chart_paths = []
with pdfplumber.open(PDF) as pdf:
    for index, page in enumerate(pdf.pages, 1):
        if abs(page.width - 1190.55) > 3 or abs(page.height - 841.89) > 3:
            errors.append(f"Unexpected A3 landscape page: {index}")
        for word in page.extract_words():
            word_count += 1
            if not (27 <= word["x0"] < word["x1"] <= page.width - 27):
                errors.append(f"Horizontal text clipping: page {index}")
            if not (27 <= word["top"] < word["bottom"] <= page.height - 27):
                errors.append(f"Vertical text clipping: page {index}")
        if not page.extract_words():
            errors.append(f"Blank page: {index}")
        for curve in page.curves:
            if curve.get("stroke") and curve["x1"] - curve["x0"] > 500:
                chart_paths.append(index)
                if not (
                    27 <= curve["x0"] < curve["x1"] <= page.width - 27
                    and 27 <= curve["top"] < curve["bottom"] <= page.height - 27
                ):
                    errors.append(f"Clipped chart path: page {index}")
if len(chart_paths) != 1 or chart_paths != chart_top:
    errors.append("Missing/split meaningful chart path")
render_dir = PDF.with_suffix("")
render_dir.mkdir(exist_ok=True)
render = subprocess.run(
    [str(POPLER), "-r", "120", "-png", str(PDF), str(render_dir / "page")],
    capture_output=True,
    timeout=45,
    check=False,
)
rendered = sorted(render_dir.glob("page-*.png"))
if render.returncode or len(rendered) != len(texts):
    errors.append("Incomplete all-page render")
print(
    json.dumps(
        {
            "synthetic": True,
            "pages": len(texts),
            "words": word_count,
            "rows": rows,
            "chart_top_pages": chart_top,
            "chart_bottom_pages": chart_bottom,
            "headers": headers,
            "chart_path_pages": chart_paths,
            "rendered_pages": len(rendered),
            "errors": sorted(set(errors)),
        }
    )
)
sys.exit(1 if errors else 0)
