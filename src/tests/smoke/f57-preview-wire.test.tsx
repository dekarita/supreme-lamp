// [F57 §3/§5] Preview full wire per MIME: image / video / audio / pdf /
// markdown / code / unsupported, the loading spinner, and the CORS-safe
// "preview restricted by external host" fallback. Markdown + code render
// escaped HTML (no script injection into the dashboard origin).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@/i18n";
import { ExplorerPreview } from "@/pages/file-explorer/ExplorerPreview";
import FileExplorer from "@/pages/FileExplorer";
import { rendererFor, highlightCode, renderMarkdown } from "@/lib/explorer/preview";

const realFetch = globalThis.fetch;

function bytesFetch(mime: string, body: string) {
  const blob = { size: body.length, type: mime, text: async () => body } as unknown as Blob;
  const mock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => mime }, blob: async () => blob }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("F57 preview per MIME", () => {
  it("maps the plan's extension table to renderers", () => {
    expect(rendererFor({ name: "a.png" })).toBe("image");
    expect(rendererFor({ name: "a.mp4" })).toBe("video");
    expect(rendererFor({ name: "a.mp3" })).toBe("audio");
    expect(rendererFor({ name: "a.pdf" })).toBe("pdf");
    expect(rendererFor({ name: "a.md" })).toBe("markdown");
    expect(rendererFor({ name: "a.ts" })).toBe("code");
    expect(rendererFor({ name: "a.bin" })).toBe("unsupported");
    expect(rendererFor({ name: "x", mime: "image/webp" })).toBe("image");
    expect(rendererFor({ name: "x.txt", mime: "text/markdown" })).toBe("markdown");
  });

  it("renders the image / video / audio / pdf wires", async () => {
    bytesFetch("image/png", "png");
    const { unmount } = render(<ExplorerPreview entry={{ id: "i1", name: "shot.png", sizeBytes: 3 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-image")).toBeTruthy());
    expect(screen.getByTestId("preview-image").getAttribute("style")).toContain("max-width: 100%");
    unmount();

    bytesFetch("video/mp4", "mp4");
    const v = render(<ExplorerPreview entry={{ id: "v1", name: "clip.mp4", sizeBytes: 3 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-video")).toBeTruthy());
    expect(screen.getByTestId("preview-video").hasAttribute("controls")).toBe(true);
    v.unmount();

    bytesFetch("audio/mpeg", "mp3");
    const a = render(<ExplorerPreview entry={{ id: "a1", name: "tone.mp3", sizeBytes: 3 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-audio")).toBeTruthy());
    a.unmount();

    bytesFetch("application/pdf", "%PDF-1.4");
    render(<ExplorerPreview entry={{ id: "p1", name: "doc.pdf", sizeBytes: 8 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-pdf")).toBeTruthy());
    expect(screen.getByTestId("preview-pdf").getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("renders markdown and code, escaped, and never fetches an unsupported type", async () => {
    bytesFetch("text/markdown", "# Title\n\n- item\n\n<script>alert(1)</script>");
    const md = render(<ExplorerPreview entry={{ id: "m1", name: "readme.md", sizeBytes: 8 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-markdown")).toBeTruthy());
    const html = screen.getByTestId("preview-markdown").innerHTML;
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html.includes("<script")).toBe(false);
    md.unmount();

    bytesFetch("text/typescript", "const x = 1; // note");
    render(<ExplorerPreview entry={{ id: "c1", name: "main.ts", sizeBytes: 8 }} />);
    await waitFor(() => expect(screen.getByTestId("preview-code")).toBeTruthy());
    const pre = screen.getByTestId("preview-code");
    expect(pre.getAttribute("data-lang")).toBe("typescript");
    expect(pre.innerHTML).toContain("tok-k");
    expect(pre.innerHTML).toContain("tok-c");
  });

  it("shows the stylized unsupported card with size + download and skips the fetch", () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<ExplorerPreview entry={{ id: "u1", name: "archive.7z", sizeBytes: 2048 }} />);
    expect(screen.getByTestId("preview-unsupported")).toBeTruthy();
    expect(screen.getByTestId("preview-unsupported").textContent).toContain("2048 B");
    expect(screen.getByTestId("preview-download").getAttribute("href")).toBe("/api/fx/preview?id=u1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the labeled CORS-restricted note instead of throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ExplorerPreview entry={{ id: "r1", name: "remote.png", sizeBytes: 9, remote: true }} />);
    await waitFor(() => expect(screen.getByTestId("preview-note")).toBeTruthy());
    expect(screen.getByTestId("preview-note").getAttribute("data-kind")).toBe("restricted");
    expect(screen.getByTestId("preview-note").textContent || "").toMatch(/restricted/i);
  });

  it("shows the spinner while the bytes are buffering", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      const blob = { size: 3, type: "image/png", text: async () => "png" } as unknown as Blob;
      return { ok: true, status: 200, headers: { get: () => "image/png" }, blob: async () => blob };
    }) as unknown as typeof fetch;
    render(<ExplorerPreview entry={{ id: "s1", name: "slow.png", sizeBytes: 3 }} />);
    expect(screen.getByTestId("preview-spinner")).toBeTruthy();
    release(null);
    await waitFor(() => expect(screen.getByTestId("preview-image")).toBeTruthy());
  });

  it("wires the page preview panel to the selected file's renderer", async () => {
    bytesFetch("text/markdown", "# hi");
    render(<FileExplorer />);
    const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes("session-report.md"));
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByTestId("explorer-row-button"));
    expect(screen.getByTestId("explorer-preview").getAttribute("data-renderer")).toBe("markdown");
    await waitFor(() => expect(screen.queryByTestId("preview-markdown")).toBeTruthy());
  });
});

describe("F57 preview renderers (pure)", () => {
  it("renderMarkdown escapes raw HTML and highlightCode tokenizes", () => {
    expect(renderMarkdown("<b>x</b>")).toContain("&lt;b&gt;");
    expect(renderMarkdown("```js\nconst a = 1\n```")).toContain('data-lang="js"'.replace("js", "js"));
    const hl = highlightCode('const s = "q"; // c', "javascript");
    expect(hl).toContain("tok-k");
    expect(hl).toContain("tok-s");
    expect(hl).toContain("tok-c");
  });
});
