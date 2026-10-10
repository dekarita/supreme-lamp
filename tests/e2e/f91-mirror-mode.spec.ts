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
// [WP-09 / #203] In-page fetches below must use the MOCK base, never a
// relative path: from the :5173 preview a relative /api/* (or /__f91/*) fetch
// silently hits the vite SPA fallback (200 + index.html) instead of the mock,
// which reads green for a dead contract. f79's `backend` constant is the same
// value. This file predates its first full CI run, so these fetches are
// corrected HERE, before the lane can reach them.
const MOCK = process.env.F78_MOCK_URL || "http://127.0.0.1:7331";
const SITES = [
  "openculture.com", "archive.org", "openverse.org", "awesome.re", "gutenberg.org", "standardebooks.org",
  "librivox.org", "openlibrary.org", "tubitv.com", "pluto.tv", "freemusicarchive.org",
];
const idOf = (site: string) => site.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/f91-${name}.png`, fullPage: true });


// [WP-09 / #203] WHY THIS FILE ISOLATES THE PUBLIC INTERNET AND CLOSES POPUPS.
//
// Honorary mention of a DISPROVEN hypothesis, because the next person to read
// this will otherwise repeat it:
//   HYPOTHESIS (this file's first fix, run 38024144029 -> 38024230807):
//     the lane went from ~1m44s (run 37285114245, 2b66c11) to a systematic
//     job-ceiling timeout on the commit that added THIS spec (run 37289316623,
//     1827d3f0). This spec opens a popup at a REAL third-party operator site
//     (pluto.tv, tubitv.com, archive.org, ...) and used to leave it open;
//     Playwright's per-test teardown closes the whole context, and a context
//     close waits for every page in it, so a wedged external load plus
//     workers:1 would stall the entire run.
//   RESULT: the lane STILL did not go green after this fix - it failed at the
//     new 18m step bound (run 38024230807, 04:29:17Z -> 04:47:51Z). The
//     readable evidence that fix's instrumentation produced points somewhere
//     else entirely: tests/e2e/f86-ten-sites-deep.spec.ts:101, "librivox.org:
//     add -> Lab >= 50 URLs -> row opens in RDP (tier) -> download", failing
//     its 60s budget twice, as test #100 of the run. So the popup theory is at
//     best INCOMPLETE, and the ~18m is being consumed by accumulated per-test
//     timeouts across the site-loop specs, not by one wedged teardown.
//
// The two changes below are KEPT, because they are correct on their own merits
// and cost no assertion - they are just no longer claimed as THE fix:
//   1. every external navigation is FULFILLED with a stub, so no test waits on
//      a third-party host (the spec's own comment already said "its LOAD may
//      fail in a sandbox; creation + correct target is the proof" - the URL is
//      the assertion, the page body never was);
//   2. every popup this file opens is closed explicitly in a finally, so no
//      context teardown can block on it.
async function isolateExternalNetwork(page: Page): Promise<void> {
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "";
    try {
      if (isLocal) return void (await route.continue());
      return void (await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><meta charset=utf-8><title>ghrdp e2e stub</title><p>stub",
      }));
    } catch {
      // A route that raced with a page close cannot fail the lane.
      try {
        await route.continue();
      } catch {
        /* already handled */
      }
    }
  });
}

/** Close every page in the context except the fixture page. */
async function closeExtraPages(page: Page): Promise<void> {
  for (const other of page.context().pages()) {
    if (other === page) continue;
    try {
      await other.close({ runBeforeUnload: false });
    } catch {
      /* a page that is already gone is the goal, not a failure */
    }
  }
}

async function jobsOf(page: Page): Promise<{ url: string; mode: string }[]> {
  const r = await page.evaluate(async (mock) => (await fetch(mock + "/__f91/jobs")).json(), MOCK);
  return r.jobs || [];
}

// [F104 §1.4] Row-visibility helpers. The plain lab query can legitimately
// match ZERO rows: with "matches first" on, the list IS the matching set, so
// an empty filter is an empty (invisible) <ul>. Showing the full list is not
// cheating - this file is about what a row CLICK does, not about the filter.
async function openRowCount(page: Page): Promise<number> {
  return page.getByTestId("lab-link-open").count();
}

async function showFullList(page: Page): Promise<void> {
  const toggle = page.getByTestId("lab-matches-first");
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  if (await toggle.isChecked()) {
    await toggle.uncheck();
    await page.waitForTimeout(500);
  }
}

async function showAllRows(page: Page): Promise<void> {
  if ((await openRowCount(page)) > 0) return;
  await showFullList(page);
}

// [F104 §1.4] Last resort for the site loop: the deep lane always answers the
// site's own 60-URL corpus. Re-applies showAllRows after the reload (the
// checkbox is fresh state on a fresh page).
async function ensureRows(page: Page, site: string, term: string): Promise<void> {
  await showAllRows(page);
  if ((await openRowCount(page)) > 0) return;
  await page.goto("/#/search/lab/" + idOf(site) + "?q=f86+" + encodeURIComponent(term));
  await expect(page.getByTestId("lab-inspector")).toBeVisible({ timeout: 20_000 });
  await showAllRows(page);
}

test.describe("F91 mirror mode - 11 sites", () => {
  test("0: the mock exposes the launcher lanes (queue, health, jobs)", async ({ page }) => {
    await isolateExternalNetwork(page);
    await page.goto("/#/search");
    const health = await page.evaluate(async (mock) => (await fetch(mock + "/api/launcher/health")).json(), MOCK);
    expect(health.serviceRunning).toBe(true);
    expect(health.taskExists).toBe(true);
    const accepted = await page.evaluate(async (mock) => {
      const r = await fetch(mock + "/api/launcher/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", mode: "navigate" }),
      });
      return { status: r.status, body: await r.json() };
    }, MOCK);
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
    expect(accepted.body.jobId).toBeTruthy();
    // the fence mirrors the server: javascript: never queues
    const refused = await page.evaluate(async (mock) => {
      const r = await fetch(mock + "/api/launcher/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "javascript:alert(1)", mode: "navigate" }),
      });
      return r.status;
    }, MOCK);
    expect(refused).toBe(400);
  });

  for (const site of SITES) {
    test(`${site}: click opens locally + mirrors to RDP (never an error toast)`, async ({ page }) => {
      const term = site === "awesome.re" ? "awesome" : "free";
      await isolateExternalNetwork(page);
      let popup: Page | null = null;
      try {
      await page.goto("/#/search/lab/" + idOf(site) + "?q=" + encodeURIComponent(term));
      await expect(page.getByTestId("lab-inspector")).toBeVisible({ timeout: 20_000 });
      await ensureRows(page, site, term);
      await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
      // "matches first" so row 0 is a real on-site URL
      const first = page.getByTestId("lab-link-open").first();
      await expect(first).toBeVisible();
      // [F104 §1.3] the popup is async delivery: WAIT for the new page instead
      // of asserting a listener array the event may not have reached yet (that
      // race was the CI red - the queue job landed while opened.length was
      // still 0). A blocked popup now fails LOUDLY here instead of flaking.
      const opened = await Promise.all([
        page.context().waitForEvent("page", { timeout: 15_000 }),
        first.click(),
      ]);
      popup = opened[0];
      expect(popup).toBeTruthy();
      // RDP half: a navigate job for that site's own URL landed in the queue.
      await expect
        .poll(async () => (await jobsOf(page)).filter((j) => j.mode === "navigate" && j.url.includes(site)).length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      // local half: the popup's URL is the row's own site (its LOAD may fail
      // in a sandbox; creation + correct target is the proof).
      await expect.poll(() => (popup as Page).url(), { timeout: 10_000 }).not.toBe("about:blank");
      expect((popup as Page).url()).toContain(site);
      // the toast is success-first and the banned string never appears
      await expect(page.locator("#toasts")).toContainText(/Opened locally|Mirrored/i);
      expect(await page.locator("#toasts").textContent()).not.toMatch(/Could not open/);
      await shot(page, site + "-mirror");
      } finally {
        await closeExtraPages(page);
      }
    });
  }

  test("download: RDP-Downloads path toast + explorer job from the toast action", async ({ page }) => {
    await isolateExternalNetwork(page);
    // [F104 §1.4] the file-ish row lives in the F88 search-endpoint lane (the
    // plain + deep lanes carry pages only): archive.org's "a matter of life
    // and death" case answers an .mp4 row. matches:false, so the full list
    // must be shown first.
    await page.goto("/#/search/lab/archive-org?q=" + encodeURIComponent("f88 a matter of life and death"));
    await expect(page.getByTestId("lab-inspector")).toBeVisible({ timeout: 20_000 });
    await showFullList(page);
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
    await isolateExternalNetwork(page);
    // [F104 §1.4] the .mp3 row lives in the F88 search-endpoint lane:
    // openculture's "free online philosophy courses" case (matches:false, so
    // the full list must be shown first).
    await page.goto("/#/search/lab/openculture-com?q=" + encodeURIComponent("f88 free online philosophy courses"));
    await expect(page.getByTestId("lab-inspector")).toBeVisible({ timeout: 20_000 });
    await showFullList(page);
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    // [F91 §D.3] the Lab list itself carries the inline player for .mp3 rows:
    // an <audio> whose src is the /api/stream relay with the encoded url.
    const audio = page.getByTestId("f91-stream-audio").first();
    await expect(audio).toBeVisible();
    expect(await audio.getAttribute("src")).toContain("/api/stream?url=https%3A%2F%2Fwww.openculture.com");
    // and the relay answers 200 + an audio Content-Type (RDP network view)
    const res = await page.evaluate(async (mock) => {
      const u = "https://www.openculture.com/audio/platos-republic-lecture.mp3";
      const r = await fetch(mock + "/api/stream?url=" + encodeURIComponent(u));
      return { status: r.status, ct: r.headers.get("content-type") };
    }, MOCK);
    expect(res.status).toBe(200);
    expect(res.ct).toContain("audio/");
    // off-allowlist hosts are refused - the relay is not a general proxy
    const refused = await page.evaluate(async (mock) => {
      const r = await fetch(mock + "/api/stream?url=" + encodeURIComponent("https://evil.example/x.mp3"));
      return r.status;
    }, MOCK);
    expect(refused).toBe(403);
    await shot(page, "stream-relay");
  });

  test("self-test: five operator columns green + global launcher line", async ({ page }) => {
    await isolateExternalNetwork(page);
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
    // [F104 §2] the diag round trip (health read + queue write + popup) gets
    // the full 45 s: it flaked at the default budget on loaded runners.
    test.setTimeout(45_000);
    await isolateExternalNetwork(page);
    let popup: Page | null = null;
    try {
    await page.goto("/#/search?diag=1");
    const line = page.getByTestId("f91-diag-launcher");
    await expect(line).toContainText("running");
    await expect(line).toContainText("queue depth 0");
    // pin the RDP half to its wire proof BEFORE clicking, and wait for the
    // popup page instead of an event-listener array (same §1.3 race class).
    const respPromise = page.waitForResponse(
      (r) => r.url().includes("/api/launcher/queue") && r.status() === 200,
      { timeout: 30_000 },
    );
    const opened = await Promise.all([
      page.context().waitForEvent("page", { timeout: 30_000 }),
      page.getByTestId("f87-diag-test-launch").click(),
    ]);
    popup = opened[0];
    expect((await respPromise).status()).toBe(200);
    await expect(page.getByTestId("f87-diag-test-launch-result")).toHaveAttribute("data-ok", "1", { timeout: 10_000 });
    await expect.poll(async () => (await jobsOf(page)).some((j) => j.url === "https://example.com/")).toBe(true);
    await expect.poll(() => (popup as Page).url(), { timeout: 10_000 }).not.toBe("about:blank");
    expect((popup as Page).url()).toContain("example.com");
    await shot(page, "diag-launcher");
    } finally {
      await closeExtraPages(page);
    }
  });
});
