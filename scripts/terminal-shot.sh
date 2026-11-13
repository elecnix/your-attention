#!/usr/bin/env bash
# Render one command's terminal output to a PNG, with nothing but tmux and a headless browser.
#
#   scripts/terminal-shot.sh -o shot.png -W 100 -H 30 -- your-attention install
#
# The command runs in a tmux session of the given size, so the capture is what a terminal of that size draws. ANSI
# colours survive: tmux captures them, and the HTML the browser renders carries them.
#
# Needs: tmux, and google-chrome (or chromium) on PATH. Nothing is sent anywhere.
set -euo pipefail

cols=100
rows=30
out='shot.png'
while getopts 'W:H:o:' opt; do
  case "$opt" in
    W) cols=$OPTARG ;;
    H) rows=$OPTARG ;;
    o) out=$OPTARG ;;
    *) echo "usage: $0 [-W cols] [-H rows] -o shot.png -- command..." >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
# Checked before $1 is read: with set -u, an empty argument list aborts on the test itself.
[ "$#" -gt 0 ] || { echo "usage: $0 -o shot.png -- command..." >&2; exit 2; }
[ "$1" = '--' ] && shift
[ "$#" -gt 0 ] || { echo "usage: $0 -o shot.png -- command..." >&2; exit 2; }

browser=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
[ -n "$browser" ] || { echo "no chrome or chromium on PATH" >&2; exit 1; }

socket=$(mktemp -u /tmp/terminal-shot.XXXXXX)
session=shot-$$
cleanup() { tmux -u -f /dev/null -S "$socket" kill-server 2>/dev/null || true; rm -rf "$socket" "$dir"; }
dir=$(mktemp -d)
trap cleanup EXIT

# sleep keeps the pane open after the command exits, so its last screen is still there to capture.
tmux -u -f /dev/null -S "$socket" new-session -d -s "$session" -x "$cols" -y "$rows" \
  "sh -c '$*; echo \"[exited \$?]\"; sleep 600'"

# Wait for the exit marker, then for the screen to stop changing, so the capture does not race a redraw.
for _ in $(seq 1 600); do
  tmux -u -f /dev/null -S "$socket" capture-pane -p -t "$session" | grep -q '\[exited ' && break
  sleep 0.2
done
before=''
for _ in $(seq 1 100); do
  now=$(tmux -u -f /dev/null -S "$socket" capture-pane -p -t "$session")
  [ "$now" = "$before" ] && break
  before=$now
  sleep 0.2
done
tmux -u -f /dev/null -S "$socket" capture-pane -p -e -t "$session" > "$dir/screen.ansi"

python3 - "$dir/screen.ansi" "$dir/screen.html" "$cols" "$rows" <<'PY'
import html, re, sys
src, dest, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
text = open(src, encoding='utf-8', errors='replace').read()
SGR = re.compile(r'\x1b\[([0-9;]*)m')
BASIC = {30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510', 34: '#2472c8', 35: '#bc3fbc',
         36: '#11a8cd', 37: '#e5e5e5', 90: '#7f7f7f', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
         94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#ffffff'}
def palette(i):
    steps = [0, 95, 135, 175, 215, 255]
    if i < 16:
        return list(BASIC.values())[i % 8 + (8 if i >= 8 else 0)]
    if i < 232:
        i -= 16
        r, g, b = steps[i // 36], steps[(i // 6) % 6], steps[i % 6]
        return f'#{r:02x}{g:02x}{b:02x}'
    v = 8 + (i - 232) * 10
    return f'#{v:02x}{v:02x}{v:02x}'
out, fg, bg, bold, pos = [], None, None, False, 0
for m in SGR.finditer(text):
    out.append((fg, bg, bold, text[pos:m.start()]))
    codes = [c for c in m.group(1).split(';') if c] or ['0']
    i = 0
    while i < len(codes):
        c = codes[i]
        if c == '0': fg, bg, bold = None, None, False
        elif c == '1': bold = True
        elif c == '22': bold = False
        elif c in ('38', '48') and i + 2 < len(codes) and codes[i + 1] == '5':
            if c == '38': fg = palette(int(codes[i + 2]))
            else: bg = palette(int(codes[i + 2]))
            i += 2
        elif c == '39': fg = None
        elif c == '49': bg = None
        elif c.isdigit() and int(c) in BASIC:
            n = int(c)
            if 30 <= n <= 37 or 90 <= n <= 97: fg = BASIC[n]
            elif 40 <= n <= 47 or 100 <= n <= 107: bg = BASIC[n - 10]
        i += 1
    pos = m.end()
out.append((fg, bg, bold, text[pos:]))
pieces = []
for fg, bg, bold, chunk in out:
    style = ';'.join(filter(None, [f'color:{fg}' if fg else '', f'background:{bg}' if bg else '',
                                   'font-weight:700' if bold else '']))
    piece = html.escape(chunk)
    pieces.append(f'<span style="{style}">{piece}</span>' if style else piece)
open(dest, 'w', encoding='utf-8').write(
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#1e1e1e}'
    f'pre{{margin:0;padding:12px;color:#e5e5e5;font:14px/1.35 "DejaVu Sans Mono",monospace;white-space:pre}}'
    '</style><pre>' + ''.join(pieces) + '</pre>')
PY

"$browser" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=$((cols * 9 + 24)),$((rows * 19 + 24)) --screenshot="$out" "file://$dir/screen.html" >/dev/null 2>&1
echo "$out"
