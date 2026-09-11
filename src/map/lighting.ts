/** Scene axes are east, north, up. Both renderers use this world-anchored sun. */
export const sunlight = (evening: boolean) => {
  const position: [number, number, number] = evening ? [90, -40, 28] : [-70, -30, 52];
  const [x, y, z] = position;
  return {
    position,
    color: evening ? '#ffb975' : '#fff0d6',
    intensity: evening ? 1.65 : 2.1,
    mapPosition: [
      1.5,
      ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360,
      (Math.atan2(Math.hypot(x, y), z) * 180) / Math.PI,
    ] as [number, number, number],
  };
};
