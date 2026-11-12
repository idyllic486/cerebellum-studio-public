#!/bin/bash
# Local Mac launcher. It reads the selected PDF and never uploads it.
set -euo pipefail
atlas_tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This launcher is for macOS. Use prepare_atlas_pdf.py directly on other systems."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Python 3.10 or newer is required. Install Python from python.org, then run this tool again."
  exit 1
fi
atlas_input_pdf="$(/usr/bin/osascript <<'APPLESCRIPT'
POSIX path of (choose file with prompt "Select the original atlas PDF. The original will remain unchanged." of type {"com.adobe.pdf"})
APPLESCRIPT
)"
atlas_result_dir="$HOME/Desktop/cerebellum-atlas-index-$(date +%Y%m%d-%H%M%S)"
atlas_environment="$atlas_tool_dir/.venv-atlas"
if [[ ! -x "$atlas_environment/bin/python" ]]; then
  python3 -m venv "$atlas_environment"
fi
echo "Preparing the local PDF reader. First use requires an internet connection for the pinned Python dependency."
"$atlas_environment/bin/python" -m pip install -r "$atlas_tool_dir/requirements-atlas-pdf.txt"
echo "Indexing the selected PDF locally. Large files may take several minutes."
"$atlas_environment/bin/python" "$atlas_tool_dir/prepare_atlas_pdf.py" --input "$atlas_input_pdf" --output "$atlas_result_dir" --index-only
echo "Done. Share preparation-report.json and the ZIP files inside packs. Do not share or modify the original PDF."
/usr/bin/open -R "$atlas_result_dir/preparation-report.json"
