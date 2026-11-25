/** Deterministic lexical fallback used only when the model runtime is unavailable. */
export function computeFallbackVector(text: string, dimensions = 384): number[] {
  const vector = new Array(dimensions).fill(0);
  const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);

  for (const word of words) {
    let hash = 0;
    for (const character of word) {
      hash = (hash << 5) - hash + character.charCodeAt(0);
      hash |= 0;
    }
    vector[Math.abs(hash) % dimensions] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}
