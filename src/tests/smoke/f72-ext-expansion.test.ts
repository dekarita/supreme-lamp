// [F72 §1.1] Vitest: MIME_TO_EXT expansion + compound extension detection.
// Validates the 20+ new MIME→ext mappings and the compound .tar.gz/.tar.xz/
// .tar.bz2 detection in extensionOf() (src/lib/explorer/preview.ts).
import { describe, it, expect } from "vitest";
import { extensionOf } from "@/lib/explorer/preview";
import { fileExtension } from "@/pages/search/tokens";

describe("F72 §1.1 compound extensionOf()", () => {
  it("detects .tar.gz compound extension", () => {
    expect(extensionOf("archive.tar.gz")).toBe("tar.gz");
  });
  it("detects .tar.xz compound extension", () => {
    expect(extensionOf("data.tar.xz")).toBe("tar.xz");
  });
  it("detects .tar.bz2 compound extension", () => {
    expect(extensionOf("backup.tar.bz2")).toBe("tar.bz2");
  });
  it("detects .tar.zst compound extension", () => {
    expect(extensionOf("pkg.tar.zst")).toBe("tar.zst");
  });
  it("falls through to simple extension for non-compound", () => {
    expect(extensionOf("file.pdf")).toBe("pdf");
    expect(extensionOf("readme.md")).toBe("md");
    expect(extensionOf("image.tar")).toBe("tar");
  });
  it("returns empty string for no extension", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("")).toBe("");
    expect(extensionOf(null as any)).toBe("");
  });
  it("case-insensitive", () => {
    expect(extensionOf("Archive.TAR.GZ")).toBe("tar.gz");
    expect(extensionOf("File.PDF")).toBe("pdf");
  });
});

describe("F72 §1.1 new MIME_TO_EXT entries", () => {
  const cases: Array<[string, string, string]> = [
    // Archive formats
    ["application/vnd.rar", "rar", "RAR archive"],
    ["application/x-rar-compressed", "rar", "RAR compressed"],
    ["application/x-7z-compressed", "7z", "7-Zip"],
    ["application/gzip", "gz", "gzip"],
    ["application/x-tar", "tar", "tar"],
    ["application/x-xz", "xz", "xz"],
    ["application/x-bzip2", "bz2", "bzip2"],
    // Package / installer
    ["application/vnd.debian.binary-package", "deb", "Debian package"],
    ["application/x-rpm", "rpm", "RPM package"],
    ["application/vnd.android.package-archive", "apk", "Android APK"],
    ["application/x-apple-diskimage", "dmg", "macOS disk image"],
    ["application/x-raw-disk-image", "img", "raw disk image"],
    ["application/x-msdownload", "exe", "Windows executable"],
    ["application/x-msi", "msi", "Windows installer"],
    // Subtitles
    ["application/x-subrip", "srt", "SRT subtitle"],
    ["text/vtt", "vtt", "WebVTT subtitle"],
    // WebAssembly
    ["application/wasm", "wasm", "WebAssembly"],
    // Source code
    ["text/x-python", "py", "Python"],
    ["application/javascript", "js", "JavaScript"],
    ["application/typescript", "ts", "TypeScript"],
    ["text/x-go", "go", "Go"],
    ["text/x-rust", "rs", "Rust"],
    ["text/x-java-source", "java", "Java"],
    ["text/x-csrc", "c", "C source"],
    ["text/x-c++src", "cpp", "C++ source"],
    ["text/x-chdr", "h", "C header"],
  ];

  for (const [mime, ext, label] of cases) {
    it(`MIME "${mime}" -> ".${ext}" (${label})`, () => {
      expect(fileExtension({ mimeType: mime, sourceUrl: "", title: "" })).toBe(ext);
    });
  }
});

describe("F72 §1.1 compound URL detection via fileExtension()", () => {
  it("returns tar.gz from URL path", () => {
    expect(fileExtension({ mimeType: null, sourceUrl: "https://example.com/releases/pkg-1.0.tar.gz", title: "" })).toBe("tar.gz");
  });
  it("returns tar.xz from title fallback", () => {
    expect(fileExtension({ mimeType: null, sourceUrl: "https://example.com/details/item", title: "package-2.0.tar.xz" })).toBe("tar.xz");
  });
  it("original MIME entries still work", () => {
    expect(fileExtension({ mimeType: "application/pdf", sourceUrl: "", title: "" })).toBe("pdf");
    expect(fileExtension({ mimeType: "video/mp4", sourceUrl: "", title: "" })).toBe("mp4");
    expect(fileExtension({ mimeType: "audio/flac", sourceUrl: "", title: "" })).toBe("flac");
  });
});