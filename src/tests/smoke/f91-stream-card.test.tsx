// [F91 §D/§6.B] streamRouter tables + StreamCard rendering per route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";

vi.mock("@/lib/api", () => ({ getKey: () => "tok", apiBase: () => "" }));

import { extensionOf, hasMediaRoute, routeContent, streamSrc } from "@/lib/streamRouter";
import { StreamCard } from "@/components/search/StreamCard";

const mount = (props: { url: string; mimeType?: string | null; title?: string }) =>
  render(
    <MemoryRouter>
      <StreamCard suffix="t" {...props} />
    </MemoryRouter>,
  );

beforeEach(() => vi.unstubAllGlobals());

describe("F91 streamRouter", () => {
  it("extension wins, live hosts second, mime fallback last", () => {
    expect(routeContent("https://ia800000.us.archive.org/a/b.mp3", null)).toBe("audio-inline");
    expect(routeContent("https://download.librivox.org/x.M4A")).toBe("audio-inline");
    expect(routeContent("https://example.com/movie.mkv")).toBe("video-rdp");
    expect(routeContent("https://example.com/movie.mp4?raw=1")).toBe("video-rdp");
    expect(routeContent("https://tubitv.com/live/100001396")).toBe("live-rdp");
    expect(routeContent("https://pluto.tv/us/on-demand/show")).toBe("live-rdp");
    expect(routeContent("https://m.youtube.com/watch?v=x")).toBe("live-rdp");
    expect(routeContent("https://example.com/podcast", "audio/mpeg")).toBe("audio-inline");
    expect(routeContent("https://example.com/podcast", "video/mp4")).toBe("video-rdp");
    expect(routeContent("https://gutenberg.org/ebooks/84", "text/html")).toBe("generic");
    // a tubitv .mp4 FILE still routes video (extension first, per the file)
    expect(routeContent("https://tubitv.com/movie.mp4")).toBe("video-rdp");
  });

  it("extensionOf ignores query/hash and weird paths", () => {
    expect(extensionOf("https://x.com/a/b.mp3?t=1#z")).toBe("mp3");
    expect(extensionOf("https://x.com/dir.ted/take")).toBe(""); // dot in a DIR segment is not an extension
    expect(extensionOf("https://x.com/file.PDF")).toBe("pdf");
    expect(extensionOf("")).toBe("");
    expect(streamSrc("https://x.com/a b.mp3")).toBe("/api/stream?url=" + encodeURIComponent("https://x.com/a b.mp3"));
    expect(hasMediaRoute("https://x.com/a.pdf")).toBe(false);
    expect(hasMediaRoute("https://vimeo.com/123")).toBe(true);
  });
});

describe("F91 StreamCard", () => {
  it("audio-inline renders a real <audio controls> pointed at /api/stream, url encoded", () => {
    mount({ url: "https://ia800000.us.archive.org/01_dreamers.mp3", title: "Dreamers" });
    const el = screen.getByTestId("f91-stream-audio") as HTMLAudioElement;
    expect(el.tagName).toBe("AUDIO");
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.getAttribute("src")).toBe("/api/stream?url=" + encodeURIComponent("https://ia800000.us.archive.org/01_dreamers.mp3"));
    expect(screen.getByTestId("f91-stream-card").getAttribute("data-route")).toBe("audio-inline");
  });

  it("video-rdp and live-rdp render the Watch buttons with the operator's labels", () => {
    const { unmount } = mount({ url: "https://archive.org/movie.mp4" });
    const btn = screen.getByTestId("f91-stream-watch-rdp");
    expect(btn.textContent).toContain("Watch in RDP");
    unmount();
    mount({ url: "https://tubitv.com/live/1" });
    expect(screen.getByTestId("f91-stream-watch-rdp").textContent).toContain("Watch Live in RDP");
  });

  it("generic URLs render NOTHING (the plain mirror Open button stays the only action)", () => {
    const r = mount({ url: "https://gutenberg.org/ebooks/84" });
    expect(screen.queryByTestId("f91-stream-card")).toBeNull();
    expect(r.container.innerHTML).toBe("");
  });

  it("clicking Watch in RDP is a mirror click: local tab + navigate job via /api/launcher/queue", async () => {
    const openSpy = vi.fn(() => ({ closed: false }));
    vi.stubGlobal("open", openSpy);
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, jobId: "j9" }) } as unknown as Response));
    vi.stubGlobal("fetch", fetchFn);
    mount({ url: "https://pluto.tv/us/on-demand/x" });
    fireEvent.click(screen.getByTestId("f91-stream-watch-rdp"));
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const call = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/api/launcher/queue"));
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({ url: "https://pluto.tv/us/on-demand/x", mode: "navigate" });
  });
});
