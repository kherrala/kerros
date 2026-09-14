# Website

The homepage introduces floor-plan editing, 3D exploration, indoor navigation, AI import and the
library modules. It links to the interactive demos, user guide and API reference.

- `landing.html` contains the shared homepage markup.
- `landing.css` provides its layout and light/dark themes.
- `landing.js` handles theme selection and video playback.
- `main.js` mounts the development homepage; `docs/index.md` mounts the same content in VitePress.

Video cards use local JPEG posters and WebVTT captions from `docs/public/media/`. The optional
`VITE_MEDIA_BASE_URL` setting supplies video sources. Without it, cards show their posters and
links to the interactive demos. Recordings load on demand, include native playback controls and
pause one another. Internal navigation links use relative paths.

`npm run build:site` assembles the homepage, applications and documentation in `dist/`.
