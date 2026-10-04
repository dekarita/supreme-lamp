// [F81 §2.3/Q7=B] Query intent classifier. Heuristic, no model: scans the
// trimmed lowercase query for a few cheap tokens and returns one of six
// intents ("code" | "paper" | "video" | "book" | "repo" | "general"). The
// submit() flow reads `classifyIntent(query)` to weight the default
// fan-out set: matching adapters get +2 slot priority, non-matching ones
// still ship so a misfire never zeroes out a source.
export type QueryIntent = "code" | "paper" | "video" | "book" | "repo" | "general";

interface IntentRule {
  intent: QueryIntent;
  /** Words/extensions/file hints that pull a query toward this intent. */
  needles: string[];
}

const RULES: IntentRule[] = [
  {
    intent: "paper",
    needles: [
      ".pdf", "paper", "papers", "preprint", "preprints", "arxiv", "doi",
      "research", "study", "thesis", "dissertation", "journal", "et al",
      "abstract", "manuscript", "citations", "scholar", "scholarly",
      "පත්‍රය", "පර්යේෂණ", "සඟරාව",
    ],
  },
  {
    intent: "code",
    needles: [
      ".zip", ".tar", ".tar.gz", ".tgz", "source code", "source-code",
      "github", "gitlab", "bitbucket", "npm", "pypi", "maven", "cargo",
      "release", "installer", "binary", "compiles", "library", "framework",
      "software", "package", "download",
    ],
  },
  {
    intent: "video",
    needles: [
      ".mp4", ".mkv", ".webm", "video", "videos", "youtube", "vimeo",
      "tutorial", "course", "lecture", "stream", "playback", "playlist",
      "දෘශ්‍ය", "වීඩියෝ",
    ],
  },
  {
    intent: "book",
    needles: [
      ".epub", ".mobi", "book", "books", "novel", "isbn", "kindle",
      "ebook", "audiobook", ".mp3", "librivox", "gutenberg", "doab",
      "පොත",
    ],
  },
  {
    intent: "repo",
    needles: [
      "github.com", "repo", "repository", "git clone", "checkout",
      "branch", "main branch", "open source project", "fork",
    ],
  },
];

/** Returns the first intent whose needle list matches, or "general". */
export function classifyIntent(raw: string): QueryIntent {
  const q = String(raw || "").trim().toLowerCase();
  if (!q) return "general";
  for (const r of RULES) {
    for (const n of r.needles) {
      if (q.includes(n)) return r.intent;
    }
  }
  return "general";
}

/** Adapter-id → intent mapping (a small, hand-curated list). Adapters not
 *  listed are treated as general-purpose and keep their normal fan-out slot.
 *  The submit flow lifts matching adapters to the top of the resolved set
 *  while preserving uniqueness + the F58 cap of 8. */
const ADAPTER_INTENT: Record<string, QueryIntent> = {
  "github-releases": "code",
  "sourceforge": "code",
  "internet-archive": "general",
  "arxiv-public": "paper",
  "arxiv": "paper",
  "biorxiv": "paper",
  "pubmed-central": "paper",
  "doaj": "paper",
  "wikipedia-public": "general",
  "wikisource": "book",
  "project-gutenberg": "book",
  "standard-ebooks": "book",
  "librivox": "book",
  "ia-open-library": "book",
  "hathitrust": "book",
  "doab": "book",
  "google-books": "book",
  "google-books-public": "book",
  "cc-marked-youtube": "video",
  "wikimedia-commons": "video",
  "blender-studio": "video",
  "bandcamp": "video",
  "oer-commons": "general",
  "ssrn": "paper",
};

/** Reorder the candidate adapter set so adapters whose intent matches the
 *  classified query come first. Length preserved, dedup preserved. The
 *  server still applies its 8-cap. */
export function rankAdaptersByIntent(adapters: string[], intent: QueryIntent): string[] {
  if (intent === "general") return adapters;
  const head: string[] = [];
  const tail: string[] = [];
  for (const id of adapters) {
    if (ADAPTER_INTENT[id] === intent) head.push(id);
    else tail.push(id);
  }
  return [...head, ...tail];
}