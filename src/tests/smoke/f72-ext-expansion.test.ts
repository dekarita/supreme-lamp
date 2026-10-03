// [F71 §B#5 / F72.1] MIME badge and compound archive-name regression cells.
import { describe, expect, it } from "vitest";
import { extensionOf } from "@/lib/explorer/preview";
import { fileExtension } from "@/pages/search/tokens";

const MIME_CASES: Array<[string, string]> = [
  ["application/vnd.rar", "rar"],
  ["application/x-rar-compressed", "rar"],
  ["application/x-7z-compressed", "7z"],
  ["application/vnd.debian.binary-package", "deb"],
  ["application/x-rpm", "rpm"],
  ["application/vnd.android.package-archive", "apk"],
  ["application/x-apple-diskimage", "dmg"],
  ["application/x-raw-disk-image", "img"],
  ["application/x-subrip", "srt"],
  ["text/x-ssa", "ass"],
  ["text/vtt", "vtt"],
  ["application/wasm", "wasm"],
  ["text/x-python", "py"],
  ["application/javascript", "js"],
  ["application/typescript", "ts"],
  ["text/x-go", "go"],
  ["text/x-rust", "rs"],
  ["text/x-java-source", "java"],
  ["text/x-c", "c"],
  ["text/x-c++src", "cpp"],
  ["text/x-chdr", "h"],
  ["application/x-msdownload", "exe"],
  ["application/x-msi", "msi"],
  ["application/gzip", "tar.gz"],
];

describe("F72 expanded file-extension badges", () => {
  it.each(MIME_CASES)("maps %s to .%s", (mime, expected) => {
    expect(fileExtension({ mimeType: mime, sourceUrl: "", title: "opaque" })).toBe(expected);
  });

  it("preserves tar.gz, tar.xz, and tar.bz2 before the single-dot fallback", () => {
    expect(extensionOf("release.tar.gz")).toBe("tar.gz");
    expect(extensionOf("release.TAR.XZ")).toBe("tar.xz");
    expect(extensionOf("release.tar.bz2")).toBe("tar.bz2");
    expect(fileExtension({ mimeType: "", sourceUrl: "", title: "release.tar.gz" })).toBe("tar.gz");
  });

  it("falls through from unknown MIME to a validated URL basename, then title", () => {
    expect(fileExtension({ mimeType: "application/x-unlisted", sourceUrl: "https://downloads.example.org/file.7z", title: "untitled" })).toBe("7z");
    expect(fileExtension({ mimeType: "application/x-unlisted", sourceUrl: "http://downloads.example.org/file.zip", title: "archive.tgz" })).toBe("tgz");
    expect(fileExtension({ mimeType: "application/x-unlisted", sourceUrl: "", title: "no-extension" })).toBeNull();
  });
});
