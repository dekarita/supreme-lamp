set -euo pipefail
# [F40] INFORMATION-ARCHITECTURE REGRESSION LOCK.
# The rebuild moved content between tiers; these assertions pin the shape the
# operator asked for so a later pass cannot silently undo it: three tiers,
# compact type, times in the sticky bottom bar, diagnostics hidden until
# opened, the username as a mono chip, mirror stats in the T2 card, and the
# activity pills in the top bar. Ids may move; these properties may not.
ui=payloads/ui.html
test -f "$ui" || { echo 'F40: ui.html is missing' >&2; exit 1; }

# --- §1 T3 drawers are CLOSED by default -----------------------------------
# A drawer carrying `open` would leak diagnostics onto the calm surface this
# rebuild exists to create.
drawers=$(grep -cE '<details[^>]*id="drawer[^"]*"' "$ui" || true)
[ "${drawers:-0}" -ge 5 ] || { echo "F40: expected 5 T3 drawers, found ${drawers:-0}" >&2; exit 1; }
if grep -oE '<details[^>]*id="drawer[^"]*"[^>]*>' "$ui" | grep -qE '(^|[[:space:]])open([[:space:]>]|="")'; then
  echo 'F40: a T3 drawer is open by default - diagnostics must stay hidden until opened' >&2
  exit 1
fi

# --- §2 Comfort base stays <= 16px, Large is persisted ---------------------
base=$(sed -n 's/^html{font-size:\([0-9]\{1,2\}\)px !important}$/\1/p' "$ui" | tail -1)
test -n "$base" || { echo 'F40: the Comfort base font-size rule is missing' >&2; exit 1; }
[ "$base" -le 16 ] || { echo "F40: Comfort base is ${base}px (>16px) - this pass is a type REBALANCE" >&2; exit 1; }
grep -qF 'html[data-text="large"]{font-size:17px !important}' "$ui" \
  || { echo 'F40: the Large accessibility size is missing' >&2; exit 1; }
grep -qF 'ghrdp:textScale' "$ui" || { echo 'F40: the accessibility size is not persisted' >&2; exit 1; }
grep -qF 'Accessibility size' "$ui" || { echo 'F40: the toggle must be labelled "Accessibility size"' >&2; exit 1; }

# --- §3 times leave the card grid for the sticky bottom bar ----------------
bb=$(grep -n 'id="bottomBar"' "$ui" | head -1 | cut -d: -f1)
test -n "$bb" || { echo 'F40: the sticky bottom status bar is missing' >&2; exit 1; }
for id in timerElapsed timerRemaining timerRdpUsage lastRdpLogon; do
  ln=$(grep -n "id=\"$id\"" "$ui" | head -1 | cut -d: -f1)
  test -n "$ln" || { echo "F40: the $id field is missing" >&2; exit 1; }
  [ "$ln" -gt "$bb" ] || { echo "F40: $id sits above the bottom status bar - times must leave the card grid" >&2; exit 1; }
done
fields=$(sed -n "${bb},\$p" "$ui" | sed -n '1,/<\/footer>/p' | grep -c 'class="bb-item"' || true)
[ "${fields:-0}" -ge 4 ] || { echo "F40: the bottom bar holds ${fields:-0} time fields (needs 4+)" >&2; exit 1; }

# --- §4 RDP USERNAME is a mono semibold chip -------------------------------
chip=$(grep -oE 'id="credUser"[^>]*' "$ui" | head -1)
test -n "$chip" || { echo 'F40: the RDP username element is missing' >&2; exit 1; }
grep -q 'font-family:ui-monospace' <<< "$chip" || { echo 'F40: the RDP username is not a mono chip' >&2; exit 1; }
grep -q 'font-weight:600' <<< "$chip" || { echo 'F40: the RDP username chip is not semibold' >&2; exit 1; }

# --- §5 mirror v2 stats live in the T2 card --------------------------------
mir=$(awk '/id="sec-mirror"/{f=1} f && /<\/section>/{exit} f{print}' "$ui")
test -n "$mir" || { echo 'F40: the MIRROR T2 card is missing' >&2; exit 1; }
grep -qF 'id="ringFill"' <<< "$mir" || { echo 'F40: the mirror SVG progress ring is missing' >&2; exit 1; }
grep -qF 'mini-grid' <<< "$mir" || { echo 'F40: the mirror 6-stat mini-grid is missing' >&2; exit 1; }
tiles=$(grep -c 'class="tile"' <<< "$mir" || true)
[ "${tiles:-0}" -eq 6 ] || { echo "F40: the mirror mini-grid holds ${tiles:-0} tiles (expected 6)" >&2; exit 1; }
grep -qF 'tabular-nums' <<< "$mir" || { echo 'F40: the mirror stats must use tabular-nums' >&2; exit 1; }

# --- §6 the top bar carries the activity pills ------------------------------
tb=$(awk '/id="topbar"/{f=1} f && /<\/header>/{exit} f{print}' "$ui")
test -n "$tb" || { echo 'F40: the sticky top bar is missing' >&2; exit 1; }
for pill in pillConn pillWatcher pillRust pillClock; do
  grep -qF "id=\"$pill\"" <<< "$tb" || { echo "F40: the top bar is missing the $pill activity pill" >&2; exit 1; }
done

echo 'F40 IA gates PASS'
