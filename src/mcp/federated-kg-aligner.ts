import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { db } from "../lib/db";
import { sanitizeUrlForKg, sanitizeExcerpt } from "../content/privacy";

export interface KgAlignmentOptions {
  vaultPath?: string;
  targetSubdir?: string; // Default "Wiki"
  writeDirs?: string[]; // Allowed write subdirs, default ["Wiki", "00 - Inbox", "Logs"]
  dryRun?: boolean;
}

export interface AlignmentResult {
  status: "success" | "error";
  processedEntities: number;
  createdNotes: string[];
  updatedNotes: string[];
  skippedLocked: string[];
  refusedPaths: string[];
  errors: string[];
}

/**
 * Checks whether a relative vault path is allowed within UA_VAULT_WRITE_DIRS
 */
export function isPathAllowedInVault(
  relativePath: string,
  allowedDirs: string[] = ["Wiki", "00 - Inbox", "Logs"]
): boolean {
  const normalized = path.normalize(relativePath).replace(/^(\.\/|\/)+/, "");
  return allowedDirs.some((dir) => {
    const normDir = path.normalize(dir).replace(/^(\.\/|\/)+/, "");
    return normalized === normDir || normalized.startsWith(normDir + "/") || normalized.startsWith(normDir + "\\");
  });
}

/**
 * Checks whether a note's frontmatter has locked: true
 */
export function isNoteLocked(content: string): boolean {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return false;
  const frontmatter = frontmatterMatch[1];
  return /locked:\s*true/i.test(frontmatter);
}

/**
 * Vault root for federated KG notes.
 * An explicit vaultPath wins, then UA_VAULT_PATH, then <homedir>/vaults/main.
 */
export function resolveVaultPath(
  options: Pick<KgAlignmentOptions, "vaultPath"> = {},
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = options.vaultPath?.trim();
  if (configured) return configured;
  const fromEnv = env.UA_VAULT_PATH?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), "vaults/main");
}

/**
 * Synchronizes Exocortex Dexie KG entities with Obsidian Vault Wiki layer
 */
export async function alignFederatedKgToVault(options: KgAlignmentOptions = {}): Promise<AlignmentResult> {
  const vaultPath = resolveVaultPath(options);
  const allowedWriteDirs =
    options.writeDirs ||
    (process.env.UA_VAULT_WRITE_DIRS
      ? process.env.UA_VAULT_WRITE_DIRS.split(":")
      : ["Wiki", "00 - Inbox", "Logs"]);
  const targetSubdir = options.targetSubdir || "Wiki";

  const result: AlignmentResult = {
    status: "success",
    processedEntities: 0,
    createdNotes: [],
    updatedNotes: [],
    skippedLocked: [],
    refusedPaths: [],
    errors: []
  };

  // DoD #3: Explicit check if targetSubdir itself is in allowed write dirs
  const sampleTestPath = path.join(targetSubdir, "test.md");
  if (!isPathAllowedInVault(sampleTestPath, allowedWriteDirs)) {
    result.status = "error";
    result.refusedPaths.push(sampleTestPath);
    result.errors.push(`Boundary Refusal: Subdirectory '${targetSubdir}' is outside UA_VAULT_WRITE_DIRS`);
    return result;
  }

  // Fetch entity facts from Dexie DB
  const semanticRecords = await db.semantic_vault.toArray();
  const frames = await db.cognitive_frames.toArray();

  const entityMap = new Map<
    string,
    {
      titles: Set<string>;
      urls: Set<string>;
      excerpts: Set<string>;
      relatedEntities: Set<string>;
    }
  >();

  for (const rec of semanticRecords) {
    if (!rec.primaryFocusEntity) continue;
    const rawEntity = rec.primaryFocusEntity.trim();
    const entity = sanitizeExcerpt(rawEntity);
    if (!entity) continue;

    if (!entityMap.has(entity)) {
      entityMap.set(entity, {
        titles: new Set(),
        urls: new Set(),
        excerpts: new Set(),
        relatedEntities: new Set()
      });
    }
    const data = entityMap.get(entity)!;
    if (rec.title) {
      const sanitizedTitle = sanitizeExcerpt(rec.title);
      if (sanitizedTitle) data.titles.add(sanitizedTitle);
    }
    if (rec.url) {
      const sanitizedUrl = sanitizeUrlForKg(rec.url);
      if (sanitizedUrl) data.urls.add(sanitizedUrl);
    }
    if (rec.excerpt) {
      const sanitizedExcerpt = sanitizeExcerpt(rec.excerpt);
      if (sanitizedExcerpt) data.excerpts.add(sanitizedExcerpt);
    }
  }

  for (const f of frames) {
    const rawEntity = f.userState?.primaryFocusEntity?.trim();
    if (!rawEntity) continue;
    const entity = sanitizeExcerpt(rawEntity);
    if (!entity) continue;

    if (!entityMap.has(entity)) {
      entityMap.set(entity, {
        titles: new Set(),
        urls: new Set(),
        excerpts: new Set(),
        relatedEntities: new Set()
      });
    }
    const data = entityMap.get(entity)!;
    if (f.provenance?.pageTitle) {
      const sanitizedTitle = sanitizeExcerpt(f.provenance.pageTitle);
      if (sanitizedTitle) data.titles.add(sanitizedTitle);
    }
    if (f.provenance?.url) {
      const sanitizedUrl = sanitizeUrlForKg(f.provenance.url);
      if (sanitizedUrl) data.urls.add(sanitizedUrl);
    }
    if (f.provenance?.cleanTextExcerpt) {
      const sanitizedExcerpt = sanitizeExcerpt(f.provenance.cleanTextExcerpt);
      if (sanitizedExcerpt) data.excerpts.add(sanitizedExcerpt);
    }
  }

  // Generate interlinked [[wikilinks]] for cross-references
  const allEntityNames = Array.from(entityMap.keys());
  for (const [entityName, data] of entityMap.entries()) {
    for (const otherEntity of allEntityNames) {
      if (otherEntity !== entityName && otherEntity.length > 2) {
        for (const exc of data.excerpts) {
          if (exc.toLowerCase().includes(otherEntity.toLowerCase())) {
            data.relatedEntities.add(otherEntity);
          }
        }
      }
    }
  }

  // Export each entity note
  for (const [entityName, data] of entityMap.entries()) {
    result.processedEntities++;
    const safeFilename = entityName.replace(/[/\\?%*:|"<>]/g, "_") + ".md";
    const relativePath = path.join(targetSubdir, safeFilename);

    // Boundary Enforcement Check
    if (!isPathAllowedInVault(relativePath, allowedWriteDirs)) {
      result.refusedPaths.push(relativePath);
      result.errors.push(`Boundary Refusal: Path '${relativePath}' is forbidden`);
      continue;
    }

    const fullPath = path.join(vaultPath, relativePath);
    const targetDir = path.dirname(fullPath);

    if (!options.dryRun && !fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(fullPath)) {
      const existingContent = fs.readFileSync(fullPath, "utf-8");

      // DoD #4: Lock Respect
      if (isNoteLocked(existingContent)) {
        result.skippedLocked.push(relativePath);
        continue;
      }

      // DoD #5: Authoritative Store Policy (Vault is authoritative)
      // Preserves existing human curation; appends machine telemetry section if not present
      if (!existingContent.includes("## Exocortex Telemetry")) {
        let telemetryBlock = "\n\n## Exocortex Telemetry\n";
        for (const url of data.urls) {
          telemetryBlock += `- Source: ${url}\n`;
        }
        for (const rel of data.relatedEntities) {
          telemetryBlock += `- Related: [[${rel}]]\n`;
        }
        if (!options.dryRun) {
          fs.writeFileSync(fullPath, existingContent + telemetryBlock, "utf-8");
        }
        result.updatedNotes.push(relativePath);
      } else {
        // Idempotent run: note already aligned
        result.updatedNotes.push(relativePath);
      }
    } else {
      // DoD #1: Entity Export with [[wikilinks]]
      let content = `---\ntags: [wiki, exocortex, entity]\nsource: exocortex\ncreated: ${new Date().toISOString().split("T")[0]}\n---\n\n# ${entityName}\n\n`;

      if (data.excerpts.size > 0) {
        content += `${Array.from(data.excerpts)[0]}\n\n`;
      }

      if (data.relatedEntities.size > 0) {
        content += `## Related Entities\n`;
        for (const rel of data.relatedEntities) {
          content += `- [[${rel}]]\n`;
        }
        content += `\n`;
      }

      if (data.urls.size > 0) {
        content += `## Captured Sources\n`;
        for (const url of data.urls) {
          const pageTitle = Array.from(data.titles)[0] || url;
          content += `- [${pageTitle}](${url})\n`;
        }
        content += `\n`;
      }

      if (!options.dryRun) {
        fs.writeFileSync(fullPath, content, "utf-8");
      }
      result.createdNotes.push(relativePath);
    }
  }

  if (result.errors.length > 0 && result.createdNotes.length === 0 && result.updatedNotes.length === 0) {
    result.status = "error";
  }

  return result;
}
