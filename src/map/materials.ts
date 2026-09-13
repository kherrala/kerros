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
  /** The active storey's own plate, when the stack has storeys under it. Opaque enough to read as
   *  the floor you are standing on, sheer enough that the levels beneath show through it — without
   *  this the plate is a lid and "All floors" shows one. depthWrite stays on: the plate must still
   *  occlude its own walls' hidden faces, and the ghosts below carry depthWrite off already, so they
   *  blend rather than fight it. */
  plate(color: string, roughness = 0.72) {
    const key = `plate:${color}:${roughness}`;
    if (!this.materials.has(key)) {
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.55,
      });
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  /** A lit ceiling. Its underside faces down, so every light in the scene misses it and a plain
   *  material renders it as the darkest thing in the room — which is the opposite of what a ceiling
   *  full of fittings looks like from beneath. Emissive is the honest fix: the ceiling is not lit,
   *  it is the thing doing the lighting, and `tint` is whatever the floor's lamps are. */
  luminous(color: string, tint: string, strength: number, finish?: SurfaceFinish) {
    const key = `luminous:${color}:${tint}:${strength.toFixed(2)}:${finish ?? ''}`;
    if (!this.materials.has(key)) {
      // Built on the finish's own material when there is one, so the ceiling keeps its tile grid and
      // its fissured face and gains the emission on top — a lit ceiling is still a ceiling, and a
      // flat glowing plane overhead is the one surface a room cannot have.
      const material = finish
        ? this.get(finish, color).clone()
        : new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide });
      material.emissive = new THREE.Color(tint);
      material.emissiveIntensity = strength;
      // The emission follows the finish's own map. Flat emission over a patterned surface washes the
      // pattern out — and on a ceiling it is also wrong: the light comes through the tiles, not
      // through the metal grid holding them up.
      material.emissiveMap = material.map;
      material.side = THREE.DoubleSide;
      material.userData.shared = true;
      this.materials.set(key, material);
    }
    return this.materials.get(key)!;
  }
  /** A polished twin of a finish, for the floor you are standing on in walk mode. Seen from above a
   *  floor is a flat patch of its own colour and matte is right; seen along at eye level it is the
   *  one surface in the room that shows you where the light is, because a grazing angle is where
   *  reflectance lives. The roughness map still multiplies through, so the polish keeps the finish's
   *  own variation instead of turning the plate into a mirror. */
  polished(base: THREE.MeshStandardMaterial, roughness = 0.5): THREE.MeshStandardMaterial {
    const key = `polished:${base.uuid}:${roughness}`;
    if (!this.materials.has(key)) {
      const material = base.clone();
      material.roughness = roughness;
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
  ghost(color: string, opacity = 0.17) {
    const key = `ghost:${color}:${opacity}`;
    if (!this.materials.has(key)) {
      // A ghost tinted with its own colour is invisible: interiors are pale, backgrounds are pale,
      // and pale-on-pale at low opacity measures 1.0:1 against the map — the building disappears.
      //
      // Darken rather than tint towards a fixed slate. Both make a ghost visible; only darkening
      // keeps the colour it started as, and a stacked view where every storey has been recoloured
      // the same grey cannot show you that the storeys differ. Multiplying preserves the hue and
      // chroma relationships the floor palette was built to carry.
      //
      // Opacity is shared out across the stack, because a ghost is never seen alone: seventeen
      // storeys layer seventeen of them with depthWrite off and nothing sorting back-to-front, so a
      // value that reads well on a house compounds into an opaque mass on a tower. The caller scales
      // it by how many levels are actually stacked.
      const tint = new THREE.Color(color).multiplyScalar(0.42);
      const material = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.9,
        side: THREE.DoubleSide,
        transparent: true,
        opacity,
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
      bumpScale:
        kind === 'brick' ? 0.018 : kind === 'roof' ? 0.026 : kind === 'grass' ? 0.025 : kind === 'tile' ? 0.001 : 0.006,
      roughness: 1,
      metalness: kind === 'roof' ? 0.48 : 0,
      side: THREE.DoubleSide,
    });
    material.userData.shared = true;
    material.userData.finish = kind;
    this.materials.set(key, material);
    return material;
  }
  glass(evening = false, lit = false) {
    const key = `glass:${evening}:${lit}`;
    if (!this.materials.has(key)) {
      const material = new THREE.MeshPhysicalMaterial({
        // Daylight glazing was a muted grey-green that went nearly black against a bright wall —
        // the colour of old float glass in a photograph, not of a window you are looking at. A pale
        // sky tint with less metal in it reads as glass with daylight behind it.
        color: evening ? '#5b6a75' : '#b9d2dc',
        roughness: 0.1,
        metalness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 2.1,
        emissive: '#ffc780',
        emissiveIntensity: evening && lit ? 0.65 : 0,
        // Glass you can see through. It was opaque, so a window was a coloured panel in a wall and
        // a room stayed a sealed box however many openings it had; the light in the plan came only
        // from the missing ceiling. Kept well short of invisible — a pane has to read as a pane at
        // a distance, and a fully clear one leaves nothing but its frame.
        transparent: true,
        opacity: evening && lit ? 0.92 : 0.42,
        // Still writes depth. Without it a pane occludes nothing, which is invisible on a house and
        // catastrophic on a tower: a hundred glazed storeys all show through one another and the
        // building becomes a haze with no floor you can pick out.
        depthWrite: true,
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
