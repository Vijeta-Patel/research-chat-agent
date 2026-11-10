import { GoogleGenAI } from "@google/genai";
import { config } from "@/lib/config";

// OPTIONAL 4th recall retriever: hosted embeddings over distilled conversation
// summaries. Only active when GEMINI_API_KEY is set; everything works without it.
// Local embedding models were measured and rejected (they ranked "that database
// thing" closer to the CRM or F1 chats than to the Postgres one); gemini-embedding-001
// ranked all test queries correctly, but by small margins — so it only ever
// contributes ranks to fusion, never decides alone.

let client: GoogleGenAI | null = null;
let disabledUntil = 0;

export const embeddingsEnabled = () => !!config.geminiApiKey && Date.now() > disabledUntil;

export async function embed(texts: string[], kind: "document" | "query"): Promise<number[][] | null> {
  if (!embeddingsEnabled() || !texts.length) return null;
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { retryOptions: { attempts: 1 }, timeout: 4_000 } });
  try {
    const res = await client.models.embedContent({
      model: config.embeddingModel,
      contents: texts,
      config: { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: 256 },
    });
    return (res.embeddings ?? []).map((e) => e.values ?? []);
  } catch {
    disabledUntil = Date.now() + 5 * 60_000; // quota/outage: stop trying for a while, recall still works
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
