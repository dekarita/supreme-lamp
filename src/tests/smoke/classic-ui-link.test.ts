// [F43] jsdom gate: v2 TopBar "Classic UI" link resolves to ui=v1 and is i18n-keyed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync("src/components/layout/AppShell.tsx", "utf8");
const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
const si = JSON.parse(readFileSync("src/i18n/si.json", "utf8"));

describe("F43 Classic UI escape link", () => {
  it("is present with a stable id/testid and ui=v1 target", () => {
    expect(shell).toContain('id="classicUiLink"');
    expect(shell).toContain('data-testid="classic-ui-link"');
    expect(shell).toMatch(/searchParams\.set\(\s*["']ui["']\s*,\s*["']v1["']\s*\)/);
    expect(shell).toContain("toggle.classicUi");
  });

  it("is i18n-keyed in en and si with no credential text", () => {
    expect(en.toggle.classicUi.short).toMatch(/Classic UI/i);
    expect(si.toggle.classicUi.short.length).toBeGreaterThan(0);
    const blob = JSON.stringify(en.toggle.classicUi) + JSON.stringify(si.toggle.classicUi);
    expect(blob).not.toMatch(/password|token|secret/i);
  });
});
