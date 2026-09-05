import { describe, expect, it } from "vitest";
import { webFetchTool } from "../tools/webFetch.js";
import {
  isMeaningfulProductEvidence,
  isMeaningfulProductMetadataEvidence,
} from "../tools/competitiveIntelligence.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;
describe("oversized product metadata evidence", () => {
  it("keeps truncated body fail-closed while completed metadata can prove product identity", async () => {
    const description =
      "Todoist helps people organize tasks, projects, deadlines, recurring work, priorities, completed tasks, and collaborative productivity workflows across devices.";
    const html =
      '<html><head><meta property="og:title" content="Todoist task manager"><meta name="description" content="' +
      description +
      '"></head><body>' +
      "x".repeat(220_000) +
      '<div style="display:none">untrusted suffix</div></body></html>';
    const result = await webFetchTool("https://www.todoist.com/", 15_000, {
      lookup: publicLookup,
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(result).toMatchObject({
      ok: false,
      status: 200,
      truncated: true,
      textExcerpt: "",
    });
    expect(
      isMeaningfulProductEvidence(
        { ...result, ok: true, textExcerpt: result.metadataExcerpt ?? "" },
        { candidateKey: "todoist.com", title: "Todoist task manager" },
      ),
    ).toBe(false);
    expect(result.metadataExcerpt).toContain("Todoist");
    expect(result.metadataExcerpt).not.toContain("untrusted suffix");
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        { candidateKey: "todoist.com", title: "Todoist task manager" },
        "Todoist task manager for organizing projects and collaborative work",
      ),
    ).toBe(true);
  });

  it("ignores product-looking metadata injected outside document head", async () => {
    const html =
      '<html><head><meta property="og:title" content="Todoist"></head><body>' +
      '<meta name="description" content="Todoist helps teams organize tasks projects priorities deadlines recurring work and collaboration across devices">' +
      "x".repeat(220_000) +
      "</body></html>";
    const result = await webFetchTool("https://www.todoist.com/", 15_000, {
      lookup: publicLookup,
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(result).toMatchObject({
      truncated: true,
      textExcerpt: "",
      metadataExcerpt: "Todoist",
    });
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        { candidateKey: "todoist.com", title: "Todoist" },
        "Todoist task manager",
      ),
    ).toBe(false);
  });

  it("ignores product-looking meta markup embedded inside head scripts", async () => {
    const html =
      '<html><head><meta property="og:title" content="Todoist"><script>' +
      '<meta name="description" content="Todoist organizes tasks projects deadlines priorities and collaboration across devices">' +
      "</script></head><body>" +
      "x".repeat(220_000) +
      "</body></html>";
    const result = await webFetchTool("https://www.todoist.com/", 15_000, {
      lookup: publicLookup,
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(result).toMatchObject({ truncated: true, metadataExcerpt: "Todoist" });
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        { candidateKey: "todoist.com", title: "Todoist" },
        "Todoist task manager",
      ),
    ).toBe(false);
  });

  it("rejects challenge metadata even when independent discovery names the product", () => {
    expect(
      isMeaningfulProductMetadataEvidence(
        {
          ok: false,
          status: 200,
          contentType: "text/html; charset=utf-8",
          finalUrl: "https://www.todoist.com/",
          textExcerpt: "",
          metadataExcerpt:
            "Todoist task manager\nVerify you are human to continue. Checking your browser before accessing Todoist.",
          truncated: true,
          error: "HTML response exceeded the byte limit and cannot be verified safely.",
        },
        { candidateKey: "todoist.com", title: "Todoist task manager" },
        "Todoist task manager for organizing projects",
      ),
    ).toBe(false);
  });

  it("does not promote an incomplete metadata tag at the byte boundary", async () => {
    const prefix =
      '<html><head><meta property="og:title" content="Todoist"><meta name="description" content="';
    const html = prefix + "claim".repeat(60_000);
    const result = await webFetchTool("https://www.todoist.com/", 15_000, {
      lookup: publicLookup,
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(result).toMatchObject({
      truncated: true,
      textExcerpt: "",
      metadataExcerpt: "Todoist",
    });
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        { candidateKey: "todoist.com", title: "Todoist" },
        "Todoist task manager",
      ),
    ).toBe(false);
  });
});
