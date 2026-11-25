import type { CognitiveStateFrame } from "../db";
import { classifyTaxonomyWithAi } from "../models/built-in-ai";
import type { ContentKind } from "../dwell-message";
import { displayHost, hostMatchesAny, hostMatchesDomain } from "../host-match";

export interface TaxonomyPage {
  url: string;
  title: string;
  excerpt?: string;
  siteName?: string;
  /** Author, or the channel on a video page. */
  byline?: string;
  /** Content kind from page metadata ("video", "article", "page"). */
  contentKind?: ContentKind;
}

export interface TaxonomyClassification {
  intentCategory: CognitiveStateFrame["userState"]["intentCategory"];
  primaryFocusEntity: string;
  workingStateSummary: string;
  cognitiveLoadLevel: CognitiveStateFrame["userState"]["cognitiveLoadLevel"];
  frictionScore: number;
}

// Matched against the parsed hostname on label boundaries. These used to be
// substring tests on the whole URL, so "x.com" also matched netflix.com and
// dropbox.com, and any URL that merely mentioned one of these sites in its
// query string was classified as that site.
const DISTRACTION_DOMAINS = [
  "twitter.com",
  "x.com",
  "reddit.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "tiktok.com"
] as const;
const COMMUNICATION_DOMAINS = ["slack.com", "discord.com", "teams.microsoft.com", "mail.google.com"] as const;
const DEV_DOMAINS = ["github.com", "stackoverflow.com", "npm.im", "developer.mozilla.org"] as const;
const OPS_DOMAINS = [
  "linear.app",
  "aws.amazon.com",
  "console.cloud.google.com",
  "notion.so",
  "trello.com"
] as const;

function parseUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase() };
  } catch {
    return { host: "", path: "" };
  }
}

/** A video title without the " - YouTube" style suffix sites append to it. */
function stripSiteSuffix(title: string, siteName: string): string {
  if (!title || !siteName) return title;
  const lower = title.toLowerCase();
  const site = siteName.toLowerCase();
  for (const separator of [" - ", " | ", " — ", " – ", " · "]) {
    const suffix = `${separator}${site}`;
    if (lower.endsWith(suffix)) return title.slice(0, title.length - suffix.length).trim();
  }
  return title;
}

export function classifyIntentAndFocus(page: TaxonomyPage): TaxonomyClassification {
  const { host, path } = parseUrl(page.url || "");

  // Distraction / High Dopamine sites
  if (hostMatchesAny(host, DISTRACTION_DOMAINS)) {
    // The category is unchanged — Focus Shield and drift detection key on it.
    // But a specific video the user chose to watch is not an anonymous feed:
    // name it, so "what was that video" has an answer.
    if (page.contentKind === "video") {
      const site = page.siteName || displayHost(host);
      const videoTitle = stripSiteSuffix(page.title || "", site);
      return {
        intentCategory: "Distraction / Rabbit Hole",
        primaryFocusEntity: videoTitle || `${site} video`,
        workingStateSummary: page.byline ? `Watching ${page.byline} on ${site}` : `Watching a video on ${site}`,
        cognitiveLoadLevel: "Low",
        frictionScore: 1
      };
    }
    return {
      intentCategory: "Distraction / Rabbit Hole",
      primaryFocusEntity: page.siteName || "Social Feed",
      workingStateSummary: `Browsing ${page.siteName || "social media"}`,
      cognitiveLoadLevel: "Low",
      frictionScore: 1
    };
  }

  // Communication & Async
  if (hostMatchesAny(host, COMMUNICATION_DOMAINS)) {
    return {
      intentCategory: "Communication & Async",
      primaryFocusEntity: page.title || "Team Communication",
      workingStateSummary: `Messages on ${page.siteName || "Chat"}`,
      cognitiveLoadLevel: "Medium",
      frictionScore: 2
    };
  }

  // Deep Work (Coding / Dev)
  const isGitHub = hostMatchesDomain(host, "github.com");
  const isLocal = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1";
  if (hostMatchesAny(host, DEV_DOMAINS) || isLocal || host.startsWith("docs.") || host.includes(".docs.")) {
    let focus = page.title;
    if (isGitHub) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        focus = `${parts[0]}/${parts[1]}`;
      }
    } else if (host === "localhost" || host.endsWith(".localhost")) {
      focus = "Localhost Dev Environment";
    }

    return {
      intentCategory: "Deep Work (Drafting/Coding)",
      primaryFocusEntity: focus || page.title || "Code Workspace",
      workingStateSummary: page.title ? `Working on ${page.title}` : "Software Development",
      cognitiveLoadLevel: "High",
      frictionScore: 3
    };
  }

  // Task Execution & Ops. Jira is matched by name because it is self-hosted
  // under arbitrary domains and served under /jira on Atlassian cloud.
  if (hostMatchesAny(host, OPS_DOMAINS) || host.includes("jira") || path.startsWith("/jira")) {
    return {
      intentCategory: "Task Execution & Ops",
      primaryFocusEntity: page.title || "Project Task",
      workingStateSummary: `Task management in ${page.siteName || "Ops Tool"}`,
      cognitiveLoadLevel: "Medium",
      frictionScore: 2
    };
  }

  // Default: Research & Gathering
  return {
    intentCategory: "Research & Gathering",
    primaryFocusEntity: page.title || "Web Research",
    workingStateSummary: page.excerpt ? page.excerpt.substring(0, 100) : `Reading ${page.title || "Documentation"}`,
    cognitiveLoadLevel: "Medium",
    frictionScore: 2
  };
}

/**
 * Hybrid taxonomy classification: Chrome window.ai zero-shot prompt with fallback to regex rules
 */
export async function classifyIntentAndFocusAsync(page: TaxonomyPage): Promise<TaxonomyClassification> {
  const fallback = classifyIntentAndFocus(page);

  // Try Built-in AI zero-shot classification if available
  const aiResult = await classifyTaxonomyWithAi(page.title, page.excerpt || "");
  if (aiResult) {
    const categoryMap: Record<string, CognitiveStateFrame["userState"]["intentCategory"]> = {
      engineering: "Deep Work (Drafting/Coding)",
      research: "Research & Gathering",
      documentation: "Research & Gathering",
      social: "Distraction / Rabbit Hole",
      distraction: "Distraction / Rabbit Hole",
      admin: "Task Execution & Ops",
      financial: "Task Execution & Ops"
    };

    const mappedCategory = categoryMap[aiResult.category.toLowerCase()] || fallback.intentCategory;

    return {
      intentCategory: mappedCategory,
      primaryFocusEntity: aiResult.focusEntity || fallback.primaryFocusEntity,
      workingStateSummary: aiResult.summary || fallback.workingStateSummary,
      cognitiveLoadLevel: fallback.cognitiveLoadLevel,
      frictionScore: fallback.frictionScore
    };
  }

  return fallback;
}
