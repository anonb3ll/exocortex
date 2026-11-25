/**
 * Chrome Built-in AI Integration & Feature Detection (`window.ai` / Gemini Nano)
 * Spec Section 3.1
 */

export interface BuiltInAiCapabilities {
  available: 'readily' | 'after-download' | 'no';
}

/**
 * Explicit Async Capability Guardrail for Chrome Built-in AI Prompt API
 */
export async function getLanguageModel() {
  try {
    if (typeof window !== 'undefined' && 'ai' in window && 'languageModel' in (window as any).ai) {
      const capabilities: BuiltInAiCapabilities = await (window as any).ai.languageModel.capabilities();
      if (capabilities.available === 'readily') {
        return await (window as any).ai.languageModel.create();
      }
    }
  } catch (err) {
    console.warn("[Exocortex Built-in AI] Capability check or session creation failed:", err);
  }
  return null; // Graceful fallback to regex rule engine
}

/**
 * Zero-Shot Taxonomy Classification using Chrome Built-in AI Prompt API
 */
export async function classifyTaxonomyWithAi(title: string, textContent: string): Promise<{
  category: string;
  focusEntity: string;
  summary: string;
} | null> {
  const session = await getLanguageModel();
  if (!session) return null;

  try {
    const snippet = textContent.slice(0, 1500).replace(/\s+/g, ' ');
    const prompt = `Classify the following web page into exactly one of these canonical categories: [engineering, research, documentation, social, financial, admin, distraction]. Also extract the primary focus entity (e.g. project name, tool, topic) and write a 1-sentence summary.

Format your response as JSON:
{"category": "category_name", "focusEntity": "entity_name", "summary": "one_sentence_summary"}

Page Title: ${title}
Content: ${snippet}`;

    const response = await session.prompt(prompt);
    session.destroy?.();

    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        category: parsed.category || 'research',
        focusEntity: parsed.focusEntity || title,
        summary: parsed.summary || title
      };
    }
  } catch (err) {
    console.warn("[Exocortex Built-in AI] Taxonomy classification failed:", err);
  }
  return null;
}

/**
 * Zero-Latency Page Summarization for high-dwell pages
 */
export async function summarizePageWithAi(title: string, textContent: string): Promise<string | null> {
  const session = await getLanguageModel();
  if (!session) return null;

  try {
    const snippet = textContent.slice(0, 2000).replace(/\s+/g, ' ');
    const prompt = `Generate a concise 2-sentence executive summary of the following web page.

Page Title: ${title}
Content: ${snippet}`;

    const summary = await session.prompt(prompt);
    session.destroy?.();
    return summary ? summary.trim() : null;
  } catch (err) {
    console.warn("[Exocortex Built-in AI] Page summarization failed:", err);
    return null;
  }
}

/**
 * Entity Extraction
 */
export async function extractEntitiesWithAi(textContent: string): Promise<string[] | null> {
  const session = await getLanguageModel();
  if (!session) return null;

  try {
    const snippet = textContent.slice(0, 1500).replace(/\s+/g, ' ');
    const prompt = `Extract a list of named entities (projects, libraries, tools, frameworks, people) from the text below. Return a JSON array of strings.

Content: ${snippet}`;

    const response = await session.prompt(prompt);
    session.destroy?.();
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    console.warn("[Exocortex Built-in AI] Entity extraction failed:", err);
  }
  return null;
}
