import * as THREE from 'three';

/** Private cabin finishes: their lighting environment is the ceiling diffuser, even in a dark
 * basement. Metals reflect this environment; the cabin walls do not glow like the old grey box. */
export class CabinMaterials {
  readonly steel: THREE.MeshPhysicalMaterial;
  readonly trim: THREE.MeshStandardMaterial;
  readonly wall: THREE.MeshStandardMaterial;
  readonly floor: THREE.MeshStandardMaterial;
  readonly dark: THREE.MeshStandardMaterial;
  readonly lamp = new THREE.MeshBasicMaterial({ color: '#fff0d5', toneMapped: false });
  readonly display = new THREE.MeshBasicMaterial({ color: '#f5c985', toneMapped: false });
  readonly environment: THREE.Texture;
  private target: THREE.WebGLRenderTarget;
  private textures: THREE.Texture[] = [];
  private owned: THREE.Material[] = [];
  constructor(renderer: THREE.WebGLRenderer) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#faf1dd');
    gradient.addColorStop(0.24, '#d6cec2');
    gradient.addColorStop(0.55, '#aaa49d');
    gradient.addColorStop(1, '#55585a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    for (const x of [35, 150, 305, 440]) {
      ctx.fillStyle = '#fffaf0';
      ctx.fillRect(x, 12, 28, 65);
      ctx.fillStyle = '#ddd5c6';
      ctx.fillRect(x + 10, 90, 5, 80);
    }
    const environment = new THREE.CanvasTexture(canvas);
    environment.mapping = THREE.EquirectangularReflectionMapping;
    environment.colorSpace = THREE.SRGBColorSpace;
    const generator = new THREE.PMREMGenerator(renderer);
    this.target = generator.fromEquirectangular(environment);
    this.environment = this.target.texture;
    environment.dispose();
    generator.dispose();
    renderer.resetState();
    const grain = document.createElement('canvas');
    grain.width = 256;
    grain.height = 512;
    const g = grain.getContext('2d')!,
      pixels = g.createImageData(256, 512);
    let seed = 821;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 0xffffffff;
    };
    const stripes = Array.from({ length: 256 }, () => random());
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 256; x++) {
        const value = 190 + stripes[x] * 35 + random() * 6;
        const i = (y * 256 + x) * 4;
        pixels.data.set([value, value, value, 255], i);
      }
    g.putImageData(pixels, 0, 0);
    const brushed = new THREE.CanvasTexture(grain);
    brushed.wrapS = brushed.wrapT = THREE.RepeatWrapping;
    brushed.repeat.set(2, 1);
    brushed.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(brushed);
    this.steel = new THREE.MeshPhysicalMaterial({
      color: '#c2c7cc',
      map: brushed,
      roughness: 0.3,
      metalness: 0.92,
      anisotropy: 0.65,
      anisotropyRotation: Math.PI / 2,
      envMap: this.environment,
      envMapIntensity: 1.35,
    });
    this.steel.userData.cabinSteel = true;
    this.trim = new THREE.MeshStandardMaterial({
      color: '#cbd0d3',
      metalness: 0.95,
      roughness: 0.18,
      envMap: this.environment,
      envMapIntensity: 1.4,
    });
    this.wall = new THREE.MeshStandardMaterial({
      color: '#b4a89a',
      metalness: 0.05,
      roughness: 0.65,
      envMap: this.environment,
      envMapIntensity: 1.0,
    });
    this.floor = new THREE.MeshStandardMaterial({
      color: '#6f7370',
      roughness: 0.83,
      envMap: this.environment,
      envMapIntensity: 1.3,
    });
    this.dark = new THREE.MeshStandardMaterial({
      color: '#17232c',
      roughness: 0.6,
      envMap: this.environment,
      envMapIntensity: 0.8,
    });
    this.owned = [this.steel, this.trim, this.wall, this.floor, this.dark, this.lamp, this.display];
    for (const m of this.owned) m.userData.shared = true;
  }
  dispose() {
    this.owned.forEach(m => m.dispose());
    this.textures.forEach(t => t.dispose());
    this.target.dispose();
  }
}
