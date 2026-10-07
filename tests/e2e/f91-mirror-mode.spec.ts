// [F91 §6.E] MIRROR MODE end to end over the eleven operator sites: every click
// opens LOCALLY (popup fires) AND queues a navigate job the launcher service
// drains (read back from /__f91/jobs, the mock's stand-in for the .job file in
// C:\ProgramData\ghrdp\launcher-queue). Downloads land with the actionable
// "Open in RDP" toast (explorer job), audio rows carry the inline /api/stream
// player, and the self-test answers all five operator columns green.
// The mock backend simulates the launcher queue + stream proxy exactly where
// the shipped routes fence (see tests/e2e/fixtures/mock-backend.mjs F91 lanes).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });
const SITES = [
  "openculture.com", "archive.org", "openverse.org", "awesome.re", "gutenberg.org", "standardebooks.org",
  "librivox.org", "openlibrary.org", "tubitv.com", "pluto.tv", "freemusicarchive.org",
];
const idOf = (site: string) => site.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/f91-${name}.png`, fullPage: true });

async function jobsOf(page: Page): Promise<{ url: string; mode: string }[]> {
  const r = await page.evaluate(async () => (await fetch("/__f91/jobs")).json());
  return r.jobs || [];
}

test.describe("F91 mirror mode - 11 sites", () => {
  test("0: the mock exposes the launcher lanes (queue, health, jobs)", async ({ page }) => {
    await page.goto("/#/search");
    const health = await page.evaluate(async () => (await fetch("/api/launcher/health")).json());
    expect(health.serviceRunning).toBe(true);
    expect(health.taskExists).toBe(true);
    const accepted = await page.evaluate(async () => {
      const r = await fetch("/api/launcher/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", mode: "navigate" }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
    expect(accepted.body.jobId).toBeTruthy();
    // the fence mirrors the server: javascript: never queues
    const refused = await page.evaluate(async () => {
      const r = await fetch("/api/launcher/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "javascript:alert(1)", mode: "navigate" }),
      });
      return r.status;
    });
    expect(refused).toBe(400);
  });

  for (const site of SITES) {
    test(`${site}: click opens locally + mirrors to RDP (never an error toast)`, async ({ page }) => {
      const opened: string[] = [];
      page.on("popup", (p) => opened.push(p.url()));
      const term = site === "awesome.re" ? "awesome" : "free";
      await page.goto("/#/search/lab/" + idOf(site) + "?q=" + encodeURIComponent(term));
      const list = page.getByTestId("lab-link-list");
      // [F103 §5] The stored source is re-seeded by the F85 (add -> delete) and
      // F86 (add -> deep sitemap) lanes that run before this file, so the plain
      // lab query can legitimately come back with an EMPTY <ul> (hidden). The
      // deep lane (q=f86 ...) always answers the site's own 60-URL corpus, so
      // fall back to it: this test is about what a row CLICK does, not about
      // which inspect lane produced the row.
      if (!(await list.isVisible().catch(() => false))) {
        await page.goto("/#/search/lab/" + idOf(site) + "?q=f86+" + encodeURIComponent(term));
      }
      await expect(list).toBeVisible({ timeout: 20_000 });
      // "matches first" so row 0 is a real on-site URL.
      // [F103 §5] The F86 deep lane (which now runs to completion for every
      // site, instead of failing at its launch assertion) re-seeds the stored
      // corpus with the site's F86 sitemap, whose paths need not contain this
      // spec's query term. When "matches first" therefore filters everything
      // away, fall back to the full link list: this test is about the LAUNCH
      // behaviour of an on-site row, not about the match filter.
      let first = page.getByTestId("lab-link-open").first();
      if (!(await first.isVisible().catch(() => false))) {
        const toggle = page.getByTestId("lab-matches-first");
        if (await toggle.isVisible().catch(() => false)) await toggle.uncheck();
        first = page.getByTestId("lab-link-open").first();
      }
      await expect(first).toBeVisible();
      await first.click();
      // RDP half: a navigate job for that site's own URL landed in the queue.
      await expect
        .poll(async () => (await jobsOf(page)).filter((j) => j.mode === "navigate" && j.url.includes(site)).length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      // local half: the popup opened (its LOAD may fail in a sandbox; creation is the proof)
      expect(opened.length).toBeGreaterThan(0);
      // the toast is success-first and the banned string never appears
      await expect(page.locator("#toasts")).toContainText(/Opened locally|Mirrored/i);
      expect(await page.locator("#toasts").textContent()).not.toMatch(/Could not open/);
      await shot(page, site + "-mirror");
    });
  }

  test("download: RDP-Downloads path toast + explorer job from the toast action", async ({ page }) => {
    // freemusicarchive rows carry /music/.../track.mp3 URLs in the fixture, so
    // the lab list has a file-ish row with the download button (F88 lane).
    await page.goto("/#/search/lab/freemusicarchive-org?q=music");
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    const dl = page.getByTestId("lab-link-download").first();
    await expect(dl).toBeVisible();
    await dl.click();
    await expect(page.locator("#toasts")).toContainText("RDP-Downloads");
    const action = page.getByTestId("toast-action").first();
    await expect(action).toBeVisible();
    await expect(action).toHaveText(/Open in RDP/);
    await action.click();
    await expect
      .poll(async () => (await jobsOf(page)).filter((j) => j.mode === "explorer").length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const explorerJob = (await jobsOf(page)).filter((j) => j.mode === "explorer").slice(-1)[0];
    expect(explorerJob.url).toBe("C:\\Users\\runner\\Desktop\\RDP-Downloads");
    await shot(page, "download-explorer");
  });

  test("stream: audio rows render the inline /api/stream player (200 through the relay)", async ({ page }) => {
    await page.goto("/#/search/lab/freemusicarchive-org?q=music");
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    // [F91 §D.3] the Lab list itself carries the inline player for .mp3 rows:
    // an <audio> whose src is the /api/stream relay with the encoded url.
    const audio = page.getByTestId("f91-stream-audio").first();
    await expect(audio).toBeVisible();
    expect(await audio.getAttribute("src")).toContain("/api/stream?url=https%3A%2F%2Ffreemusicarchive.org");
    // and the relay answers 200 + an audio Content-Type (RDP network view)
    const res = await page.evaluate(async () => {
      const u = "https://freemusicarchive.org/music/X/Y/track.mp3";
      const r = await fetch("/api/stream?url=" + encodeURIComponent(u));
      return { status: r.status, ct: r.headers.get("content-type") };
    });
    expect(res.status).toBe(200);
    expect(res.ct).toContain("audio/");
    // off-allowlist hosts are refused - the relay is not a general proxy
    const refused = await page.evaluate(async () => {
      const r = await fetch("/api/stream?url=" + encodeURIComponent("https://evil.example/x.mp3"));
      return r.status;
    });
    expect(refused).toBe(403);
    await shot(page, "stream-relay");
  });

  test("self-test: five operator columns green + global launcher line", async ({ page }) => {
    await page.goto("/#/search?selftest=1&noRateLimit=1");
    await page.getByTestId("f87-selftest-run").click();
    await expect(page.getByTestId("f87-selftest-panel")).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
    await expect(page.getByTestId("f91-selftest-launcher-note")).toHaveAttribute("data-ok", "1");
    for (const site of SITES) {
      const slug = site.replace(/[^a-z0-9]+/g, "-");
      for (const col of ["search", "launcher", "download", "stream"]) {
        await expect(page.getByTestId(`f91-selftest-${col}-${slug}`)).toHaveAttribute("data-ok", "1");
      }
    }
    await expect(page.getByTestId("f87-selftest-summary")).toHaveAttribute("data-passed", "11");
    await shot(page, "selftest");
  });

  test("diag: launcher line + test-open mirror flow for example.com", async ({ page }) => {
    const opened: string[] = [];
    page.on("popup", (p) => opened.push(p.url()));
    await page.goto("/#/search?diag=1");
    const line = page.getByTestId("f91-diag-launcher");
    await expect(line).toContainText("running");
    await expect(line).toContainText("queue depth 0");
    await page.getByTestId("f87-diag-test-launch").click();
    await expect(page.getByTestId("f87-diag-test-launch-result")).toHaveAttribute("data-ok", "1", { timeout: 10_000 });
    await expect.poll(async () => (await jobsOf(page)).some((j) => j.url === "https://example.com/")).toBe(true);
    expect(opened.some((u) => u.includes("example.com"))).toBe(true);
    await shot(page, "diag-launcher");
  });
});
