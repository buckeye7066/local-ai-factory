/** Canonicalize an HTTP evidence URL for deterministic provenance checks. */
export function canonicalHttpEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function canonicalEvidenceUrlSet(urls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of urls) {
    const canonical = canonicalHttpEvidenceUrl(raw);
    if (canonical) out.add(canonical);
  }
  return out;
}

export function matchingEvidenceUrls(
  urls: Iterable<string>,
  allowed: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    const canonical = canonicalHttpEvidenceUrl(raw);
    if (canonical && allowed.has(canonical)) out.add(canonical);
  }
  return [...out];
}
