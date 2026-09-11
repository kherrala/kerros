import type { AssetRepository, ProjectDocument, ProjectRepository, ProjectSummary } from '../model/types';
import { validateProject } from '../model/validate';
export { validateProject } from '../model/validate';
export { exportProject, importProject, blobDataUrl } from '../model/document';

const PREFIX = 'kerros:project:';
export class LocalProjectRepository implements ProjectRepository {
  async list(): Promise<ProjectSummary[]> {
    const result: ProjectSummary[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const p = validateProject(JSON.parse(localStorage.getItem(key)!));
        result.push({ id: p.id, name: p.name, updatedAt: p.updatedAt });
      } catch {
        /* Leave corrupt records untouched and exclude them from the picker. */
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string) {
    const json = localStorage.getItem(PREFIX + id);
    return json ? validateProject(JSON.parse(json)) : null;
  }
  async save(project: ProjectDocument) {
    localStorage.setItem(PREFIX + project.id, JSON.stringify(project));
  }
  async delete(id: string) {
    localStorage.removeItem(PREFIX + id);
  }
}
export class IndexedAssetRepository implements AssetRepository {
  private db?: Promise<IDBDatabase>;
  // Don't cache a rejected open promise — a transient failure (private mode, storage pressure)
  // would otherwise disable all asset access for the session; clear it so the next call retries.
  private open() {
    return (this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('kerros-assets', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('assets');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => {
      this.db = undefined;
      throw e;
    }));
  }
  async get(id: string): Promise<Blob | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('assets').objectStore('assets').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async put(id: string, asset: Blob): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(asset, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async delete(id: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
