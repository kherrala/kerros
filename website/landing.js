/** Shared, framework-free behavior for the development entry and the published manual home. */
export function mountLanding() {
  const root = document.querySelector('.landing');
  if (!root) return () => {};
  const theme = root.querySelector('.lp-theme');
  const applyTheme = dark => {
    document.documentElement.classList.toggle('dark', dark);
    theme?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    theme?.setAttribute('aria-pressed', String(dark));
  };
  try {
    const saved = localStorage.getItem('kerros:dark');
    applyTheme(saved === null ? matchMedia('(prefers-color-scheme: dark)').matches : saved === '1');
  } catch {
    applyTheme(false);
  }
  const toggle = () => {
    const dark = !document.documentElement.classList.contains('dark');
    applyTheme(dark);
    try {
      localStorage.setItem('kerros:dark', dark ? '1' : '0');
    } catch {
      /* storage is optional */
    }
  };
  theme?.addEventListener('click', toggle);
  const videos = [...root.querySelectorAll('video')];
  const playing = e => {
    for (const video of videos) if (video !== e.target) video.pause();
  };
  for (const video of videos) video.addEventListener('play', playing);
  return () => {
    theme?.removeEventListener('click', toggle);
    for (const video of videos) {
      video.removeEventListener('play', playing);
      video.pause();
    }
  };
}
