// Document serialisation: export/import with embedded reference images, and read-only parsing of an
// export. Import-side-effect-free — no browser storage, no React, no MapLibre; safe for any host
// (node-side tests, schema consumers). Every path in and out runs the full rule set in validate.ts,
// so a ProjectDocument obtained here is valid by construction.
import type { AssetRepository, ProjectDocument } from './types';
import { validateProject } from './validate';

export async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export async function exportProject(project: ProjectDocument, assets: AssetRepository): Promise<string> {
  const embeddedAssets: Record<string, string> = {};
  for (const id of new Set(project.drawings.map(d => d.assetId))) {
    const blob = await assets.get(id);
    if (!blob) throw new Error('A reference drawing is missing. Reattach it or remove its reference before exporting.');
    embeddedAssets[id] = await blobDataUrl(blob);
  }
  return JSON.stringify({ ...project, embeddedAssets }, null, 2);
}
export async function importProject(json: string, assets: AssetRepository): Promise<ProjectDocument> {
  const value: unknown = JSON.parse(json);
  const project = validateProject(value);
  const embedded = (value as { embeddedAssets?: Record<string, unknown> }).embeddedAssets ?? {};
  const decoded: [string, Blob][] = [];
  for (const id of new Set(project.drawings.map(d => d.assetId))) {
    const data = embedded[id];
    if (typeof data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(data))
      throw new Error('Project export is missing a supported reference image.');
    const res = await fetch(data);
    decoded.push([id, await res.blob()]);
  }
  const copy = structuredClone(project);
  delete (copy as ProjectDocument & { embeddedAssets?: unknown }).embeddedAssets;
  for (const [id, blob] of decoded) {
    const assetId = crypto.randomUUID();
    await assets.put(assetId, blob);
    copy.drawings
      .filter(d => d.assetId === id)
      .forEach(d => {
        d.assetId = assetId;
      });
  }
  copy.id = crypto.randomUUID();
  copy.updatedAt = new Date().toISOString();
  return copy;
}
/** Display semantics: ids and updatedAt untouched, nothing written anywhere — unlike importProject, which rewrites both for import-for-editing. Unsupported embedded entries resolve to undefined at get time rather than throwing. */
export function parseExport(json: string): { project: ProjectDocument; assets: AssetRepository } {
  const value: unknown = JSON.parse(json);
  const project = validateProject(value);
  const embedded = (value as { embeddedAssets?: Record<string, unknown> }).embeddedAssets ?? {};
  const copy = structuredClone(project);
  delete (copy as ProjectDocument & { embeddedAssets?: unknown }).embeddedAssets;
  const get = async (id: string): Promise<Blob | undefined> => {
    const data = embedded[id];
    if (typeof data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(data)) return undefined;
    return (await fetch(data)).blob();
  };
  return { project: copy, assets: { get, put: async () => {}, delete: async () => {} } };
}
