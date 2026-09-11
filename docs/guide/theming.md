# Theming

Kerros ships a default design system but imposes none of it. Wrap the viewer or editor in `KerrosThemeProvider` and override only what you need — every slot is optional and falls back to the built-in default.

```tsx
import { FloorViewer, KerrosThemeProvider } from '@kerros/viewer';

<KerrosThemeProvider theme={{
  tokens: { '--accent': '#e8562f', '--ink': '#12203a' },       // CSS design-token overrides
  icons: { camera: MyCameraIcon, aed: MyAedIcon },              // per kind / POI symbol / category
  notify: (msg, tone) => myToast(msg, tone),                    // route notifications to your UI
  confirm: async ({ title, body, danger }) => myDialog(),       // your own confirm dialog
  mapStyle: {                                                    // per operation-model rendering
    room: '#eef2f7', wall: '#9aa0ac', route: '#2fb0a3', routeActive: '#0d7d72',
    statusTones: { alarm: '#d61f1f', warning: '#c98a00' },
    objectColor: o => (o.category === 'coldroom' ? '#bfe3ef' : undefined),
  },
}}>
  <FloorViewer project={project} statuses={statuses} />
</KerrosThemeProvider>
```

## Design tokens

The stylesheet is built on CSS custom properties (`--accent`, `--ink`, `--panel`, `--alarm`, `--warning`, `--radius`, `--font`, …). Override them via `theme.tokens` (applied to the theme wrapper) or in your own CSS. Dark mode toggles a `dark` class; token overrides apply to both.

## Icons

`theme.icons` maps an object `kind`, a POI `symbol`, or a host `category` to any component taking `{ size }`. Unmatched keys fall back to the built-in lucide set.

## Notifications & dialogs

`theme.notify(message, tone)` and `theme.confirm(options)` let the host render toasts and destructive-action confirms in its own UI. Omit them to use the built-ins.

## Map & plan styling

`theme.mapStyle` recolours plan rendering per deployment: `room` / `wall` / `route` / `routeActive` base colours, `statusTones` for live status, and **`objectColor(object)`** — a callback receiving the full `SiteObject` (including `category` and `metadata`) that returns a colour or `undefined` to fall through. The basemap itself is separate (`BasemapConfig`), so any MapLibre style works underneath.

A host can colour every space purely from its `category` via `objectColor`, and swap in its own door, gate or turnstile glyphs via `icons`, without the library knowing what those categories mean.

The [facility-monitoring guide](/applications/facility-monitoring) shows how live readings reach the viewer;
[access control](/applications/access-control) describes host-specific categories and bindings.
