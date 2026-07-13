import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { cosine } from "./embedder";
import type { EmbeddingProvider } from "../adapters/types";

// ── Types ──

export interface DocSection {
  heading: string;
  content: string;
  sourcePath: string;
  lineStart: number;
  lineCount: number;
}

export interface DocSectionCache {
  sections: Array<DocSection & { vector: number[] }>;
  builtAt: string;
  model: string;
}

// ── Split Markdown by ## Headings ──

export function splitDocSections(content: string, sourcePath: string): DocSection[] {
  const lines = content.split("\n");
  const sections: DocSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      if (currentHeading && currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
          sourcePath,
          lineStart: currentStart,
          lineCount: currentLines.length,
        });
      }
      currentHeading = line.replace(/^##\s+/, "").trim();
      currentLines = [];
      currentStart = i + 1;
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }

  if (currentHeading && currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
      sourcePath,
      lineStart: currentStart,
      lineCount: currentLines.length,
    });
  }

  return sections;
}

// ── Build Section Cache ──

export async function buildDocSectionCache(
  docPaths: string[],
  provider: EmbeddingProvider,
  outputPath: string,
  batchSize: number = 10,
): Promise<DocSectionCache> {
  const allSections: DocSection[] = [];

  for (const docPath of docPaths) {
    if (!existsSync(docPath)) continue;
    const content = readFileSync(docPath, "utf-8");
    const sections = splitDocSections(content, docPath);
    allSections.push(...sections);
  }

  const cache: DocSectionCache = {
    sections: [],
    builtAt: new Date().toISOString(),
    model: "local",
  };

  for (let i = 0; i < allSections.length; i += batchSize) {
    const batch = allSections.slice(i, i + batchSize);
    const texts = batch.map(s => `${s.heading}\n${s.content}`.slice(0, 4000));
    const vectors = await provider.embed(texts);

    for (let j = 0; j < batch.length; j++) {
      cache.sections.push({ ...batch[j], vector: vectors[j] });
    }
  }

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(cache), "utf-8");

  return cache;
}

// ── Load Cache from Disk ──

export function loadDocSectionCache(path: string): DocSectionCache | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as DocSectionCache;
    if (!raw.sections || !Array.isArray(raw.sections)) return null;
    return raw;
  } catch {
    return null;
  }
}

// ── Retrieve Top-K Relevant Sections ──

export function retrieveRelevantSections(
  queryVector: number[],
  cache: DocSectionCache,
  topK: number = 5,
): DocSection[] {
  if (cache.sections.length === 0) return [];

  const scored = cache.sections.map((section, i) => ({
    index: i,
    score: cosine(queryVector, section.vector),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(s => {
    const { vector: _, ...rest } = cache.sections[s.index];
    return rest;
  });
}
