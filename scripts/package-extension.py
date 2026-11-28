"""Build the unpacked Chromium extension ZIP from the tracked runtime files."""
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (
    "manifest.json", "background.js", "content.js",
    "popup/popup.html", "popup/popup.js", "popup/popup.css",
)
output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("PHISHSHIELD_EXTENSION.zip")
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as package:
    for filename in RUNTIME:
        item = zipfile.ZipInfo(filename, date_time=(2020, 1, 1, 0, 0, 0))
        item.compress_type = zipfile.ZIP_DEFLATED
        package.writestr(item, (ROOT / filename).read_bytes())
