import type { SourceTier } from "@/lib/types";
import { domainOf } from "@/lib/util";

// Source reliability, decided in code so it is consistent run-to-run.
// The model sees the tier next to each result and the system prompt tells it
// which tiers are acceptable evidence for which kind of claim.

const NEWS = new Set([
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com", "nytimes.com",
  "theverge.com", "techcrunch.com", "arstechnica.com", "wired.com", "cnbc.com",
  "bbc.com", "bbc.co.uk", "theguardian.com", "economist.com", "axios.com",
  "zdnet.com", "venturebeat.com", "theinformation.com", "forbes.com", "businessinsider.com",
  "engadget.com", "9to5mac.com", "infoq.com", "wikipedia.org",
]);

const COMMUNITY = new Set([
  "reddit.com", "news.ycombinator.com", "stackoverflow.com", "quora.com", "medium.com",
  "dev.to", "g2.com", "capterra.com", "trustradius.com", "getapp.com", "producthunt.com",
  "x.com", "twitter.com", "linkedin.com", "youtube.com", "substack.com",
]);

const PRIMARY_SUFFIXES = [".gov", ".gov.uk", ".gov.in", ".europa.eu", ".edu", ".int"];

function matchesSet(domain: string, set: Set<string>): boolean {
  for (const d of set) if (domain === d || domain.endsWith("." + d)) return true;
  return false;
}

// "app.hubspot.com" -> "hubspot"
function brandLabel(domain: string): string {
  const parts = domain.split(".");
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) return parts[parts.length - 3]; // co.uk etc.
  return parts.length >= 2 ? parts[parts.length - 2] : domain;
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function classifySource(opts: {
  url: string;
  title: string;
  query: string;
  includeDomains?: string[];
}): SourceTier {
  const domain = domainOf(opts.url);

  // The model explicitly targeted this domain (e.g. the vendor's site) → official.
  if (opts.includeDomains?.some((d) => domain === d || domain.endsWith("." + d))) {
    return "official";
  }
  if (PRIMARY_SUFFIXES.some((s) => domain.endsWith(s))) return "primary";
  if (domain === "github.com" && /\/releases|\/changelog/i.test(opts.url)) return "primary";
  if (matchesSet(domain, NEWS)) return "news";
  if (matchesSet(domain, COMMUNITY)) return "community";

  // Brand named in the query and this is that brand's own domain → official.
  const brand = normal(brandLabel(domain));
  if (brand.length >= 3 && normal(opts.query).includes(brand)) return "official";

  // Affiliate-style roundups ("Top 10 CRMs 2026", "Best X for Y").
  if (/\b(top|best)\s+\d+\b|\bbest\b.*\b20\d\d\b|\b\d+\s+best\b/i.test(opts.title)) return "listicle";

  return "other";
}

export const TIER_LABEL: Record<SourceTier, string> = {
  official: "Official (vendor/organisation's own site)",
  primary: "Primary (government, standards body, official release notes)",
  news: "Reputable news/reference",
  community: "Community/reviews (opinion, not authoritative)",
  listicle: "Roundup/affiliate list (low reliability)",
  other: "Other website (unverified reliability)",
};
