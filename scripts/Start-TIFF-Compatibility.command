#!/bin/bash
# Local Mac entry point. Input files are read only; output goes to a new Desktop folder.
set -euo pipefail
compat_tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This launcher is for macOS. Use prepare_tiff_compatibility.py on other systems."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Python 3.10 or newer is required. Install Python from python.org, then run this launcher again."
  exit 1
fi
compat_input="$(/usr/bin/osascript <<'APPLESCRIPT'
POSIX path of (choose file with prompt "Select the original TIFF. It will not be changed.")
APPLESCRIPT
)"
compat_environment="$compat_tool_dir/.venv-tiff"
if [[ ! -x "$compat_environment/bin/python" ]]; then python3 -m venv "$compat_environment"; fi
echo "Preparing pinned local TIFF tools. First use needs an internet connection; source images are never uploaded."
"$compat_environment/bin/python" -m pip install -r "$compat_tool_dir/requirements-tiff-compatibility.txt"
compat_inspection="$(mktemp -t cerebellum-tiff-inspection)"
trap 'rm -f "$compat_inspection"' EXIT
"$compat_environment/bin/python" "$compat_tool_dir/prepare_tiff_compatibility.py" --input "$compat_input" --inspect > "$compat_inspection"
cat "$compat_inspection"
compat_pages="$("$compat_environment/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["page_count"])' "$compat_inspection")"
compat_page="$(/usr/bin/osascript - "$compat_pages" <<'APPLESCRIPT'
on run argv
  set countText to item 1 of argv
  set answer to display dialog "This TIFF has " & countText & " page(s). Enter the page number (starting at 1). Choose only the anatomical section you have verified in Fiji/ImageJ. No page is selected by the software." default answer "1" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of answer
end run
APPLESCRIPT
)"
compat_result="$HOME/Desktop/cerebellum-tiff-$(date +%Y%m%d-%H%M%S)-$$"
"$compat_environment/bin/python" "$compat_tool_dir/prepare_tiff_compatibility.py" --input "$compat_input" --page "$compat_page" --output-directory "$compat_result"
echo "Done. Choose the NEW Classic TIFF in Cerebellum Studio. Keep the original TIFF and tiff-compatibility-report.json."
/usr/bin/open "$compat_result"
