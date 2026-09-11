import * as THREE from 'three';
import { surfaceTextures, type SurfaceFinish } from './textures';

/** Small deterministic, metre-scaled textures keep exported projects independent of CDNs. */
export class MaterialLibrary {
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private textures: THREE.Texture[] = [];
  // Slightly glossier than fully matte: with an environment present, roughness is what decides how
  // much tonal gradient a large surface picks up across its extent. At 0.85 a big floor plate shades
  // almost uniformly and reads as flat paper; easing it back lets the sky/ground gradient sweep across.
  solid(color: string, roughness = 0.72) {
    const key = `solid:${color}:${roughness}`;
    if (!this.materials.has(key)) {
      const material = new THREE.MeshStandardMaterial({ color, roughness, side: THREE.DoubleSide });
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  /** A vertex-coloured twin of an existing material, so geometry can carry baked shading without
   *  doubling the palette. Cached per source material: everything drawn with the twin must supply a
   *  colour attribute, since a merge needs matching attributes across all its geometries. */
  shaded(base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const key = `shaded:${base.uuid}`;
    if (!this.materials.has(key)) {
      const material = base.clone();
      material.vertexColors = true;
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  /** Translucent variant for de-emphasised floors in the stacked view. */
  ghost(color: string) {
    const key = `ghost:${color}`;
    if (!this.materials.has(key)) {
      // A ghost tinted with its own colour is invisible: interiors are pale, backgrounds are pale,
      // and pale-on-pale at low opacity measures 1.0:1 against the map — the building disappears.
      //
      // Darken rather than tint towards a fixed slate. Both make a ghost visible; only darkening
      // keeps the colour it started as, and a stacked view where every storey has been recoloured
      // the same grey cannot show you that the storeys differ. Multiplying preserves the hue and
      // chroma relationships the floor palette was built to carry.
      //
      // Opacity stays low, because a ghost is never seen alone: seventeen storeys layer seventeen of
      // them with depthWrite off and nothing sorting back-to-front, and anything stronger compounds
      // into an opaque mass.
      const tint = new THREE.Color(color).multiplyScalar(0.42);
      const material = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.9,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
      });
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  private finishes = new Map<SurfaceFinish, THREE.Texture[]>();
  get(kind: SurfaceFinish, color: string): THREE.MeshStandardMaterial {
    const key = `${kind}:${color}`;
    if (this.materials.has(key)) return this.materials.get(key)!;
    let maps = this.finishes.get(kind);
    if (!maps) {
      maps = surfaceTextures(kind);
      this.finishes.set(kind, maps);
      this.textures.push(...maps);
    }
    const [map, bumpMap, roughnessMap] = maps;
    const material = new THREE.MeshStandardMaterial({
      color,
      map,
      bumpMap,
      roughnessMap,
      bumpScale: kind === 'brick' ? 0.018 : kind === 'roof' ? 0.026 : kind === 'grass' ? 0.025 : 0.006,
      roughness: 1,
      metalness: kind === 'roof' ? 0.48 : 0,
      side: THREE.DoubleSide,
    });
    material.userData.shared = true;
    this.materials.set(key, material);
    return material;
  }
  glass(evening = false, lit = false) {
    const key = `glass:${evening}:${lit}`;
    if (!this.materials.has(key)) {
      const material = new THREE.MeshPhysicalMaterial({
        color: evening ? '#53616b' : '#829b9e',
        roughness: 0.16,
        metalness: 0.28,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        envMapIntensity: 1.7,
        emissive: '#ffc780',
        emissiveIntensity: evening && lit ? 0.65 : 0,
        side: THREE.DoubleSide,
      });
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  metal(color = '#626c6d') {
    const key = `metal:${color}`;
    if (!this.materials.has(key)) {
      const material = new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.32 });
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  dispose() {
    this.materials.forEach(m => m.dispose());
    this.textures.forEach(t => t.dispose());
    this.materials.clear();
    this.finishes.clear();
    this.textures = [];
  }
}
