#!/usr/bin/env bash
# [F88 §D.1] Fetch each operator site's search response ONCE and cache it as an
# e2e fixture. Run locally when fixtures need a refresh; the responses are
# committed so CI never hits the live sites.
set -u
OUT="$(dirname "$0")/../tests/e2e/fixtures/f88-real-responses"
mkdir -p "$OUT"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
get() { curl -fsSL -A "$UA" --max-time 25 "$1" -o "$2" && echo "ok  $2" || echo "FAIL $2 <- $1"; }
get 'https://www.openculture.com/?s=Free+Online+Philosophy+Courses'            "$OUT/openculture-com-search.html"
get 'https://archive.org/advancedsearch.php?q=A+Matter+of+Life+and+Death&output=json&rows=50' "$OUT/archive-org-search.json"
get 'https://api.openverse.org/v1/images/?q=Saturn%27s+Rings+in+Ultraviolet+Light&page_size=50' "$OUT/openverse-org-search.json"
get 'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md'    "$OUT/awesome-readme.md"
get 'https://www.gutenberg.org/ebooks/search/?query=philosophy'                "$OUT/gutenberg-org-search.html"
get 'https://librivox.org/api/feed/audiobooks/?title=philosophy&format=json'   "$OUT/librivox-org-search.json"
get 'https://openlibrary.org/search.json?q=philosophy&limit=50'                "$OUT/openlibrary-org-search.json"
get 'https://standardebooks.org/ebooks?query=philosophy'                       "$OUT/standardebooks-org-search.html"
get 'https://freemusicarchive.org/search?quicksearch=ambient'                  "$OUT/freemusicarchive-org-search.html"
get 'https://tubitv.com/search/ambient'                                        "$OUT/tubitv-com-search.html"
get 'https://pluto.tv/en/search/ambient'                                       "$OUT/pluto-tv-search.html"
ls -la "$OUT"
