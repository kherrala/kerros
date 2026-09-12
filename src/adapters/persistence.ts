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
/** Large documents belong in IndexedDB rather than localStorage's small synchronous quota.
 * An optional previous repository keeps existing browser saves readable; new saves take precedence. */
export class IndexedProjectRepository implements ProjectRepository {
  private db?: Promise<IDBDatabase>;
  constructor(private previous?: ProjectRepository) {}
  private open() {
    return (this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('kerros-projects', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('projects');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => {
      this.db = undefined;
      throw e;
    }));
  }
  async list(): Promise<ProjectSummary[]> {
    const db = await this.open();
    const [saved, previous] = await Promise.all([
      new Promise<ProjectDocument[]>((resolve, reject) => {
        const req = db.transaction('projects').objectStore('projects').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
      this.previous?.list() ?? Promise.resolve([]),
    ]);
    const summaries = new Map(previous.map(p => [p.id, p]));
    for (const p of saved) summaries.set(p.id, { id: p.id, name: p.name, updatedAt: p.updatedAt });
    return [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<ProjectDocument | null> {
    const db = await this.open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction('projects').objectStore('projects').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return value === undefined ? (this.previous?.load(id) ?? null) : validateProject(value);
  }
  private async write(id: string, project?: ProjectDocument): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite'),
        store = tx.objectStore('projects');
      if (project) store.put(project, id);
      else store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(project: ProjectDocument) {
    await this.write(project.id, project);
  }
  async delete(id: string) {
    // Remove an older copy first so a failed legacy deletion cannot resurrect it on the next load.
    await this.previous?.delete(id);
    await this.write(id);
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
