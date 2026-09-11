import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { SiteObject } from '../model/types';
import type { StatusTone } from '../model/live';
import { en, type En } from '../i18n';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** App-wide dark mode: a `dark` class on the root element, remembered per browser. */
export function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(() => localStorage.getItem('kerros:dark') === '1');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('kerros:dark', dark ? '1' : '0');
  }, [dark]);
  return [dark, () => setDark(d => !d)];
}

// ——— Theming & pluggable chrome. Hosts wrap the viewer/editor in <KerrosThemeProvider> to override
// design tokens, supply custom icons, and route notifications/confirms into their own UI. Every
// field is optional; unset falls back to the built-in default, so the components work with no theme.
export interface ConfirmOptions {
  title: string;
  body?: string;
  danger?: boolean;
  confirmLabel?: string;
}
/** Plan/route/device rendering colours, per deployment ("operation model"). Basemap is separate (BasemapConfig). */
export interface MapStyleOptions {
  /** Plan area fill and wall colour (top-down 2D). */
  room?: string;
  wall?: string;
  route?: string;
  routeActive?: string;
  /** Selection/hover/draft highlight colours, applied on both the 2D plan and the 3D scene. */
  selection?: string;
  /** Soft (translucent) selection fill for areas; defaults to a light tint of the selection colour. */
  selectionFill?: string;
  hover?: string;
  draft?: string;
  statusTones?: Partial<Record<StatusTone, string>>;
  /** Last-word override for any area/object fill and marker accent; return undefined to fall through. */
  objectColor?: (object: SiteObject) => string | undefined;
}
export interface KerrosTheme {
  /** CSS custom-property overrides (e.g. { '--accent': '#e8562f' }); applied to the theme wrapper. */
  tokens?: Record<string, string>;
  /** Per kind/tool/POI-symbol icon overrides; keys match EntityIcon's `kind`/`symbol`. */
  icons?: Record<string, ComponentType<{ size?: number }>>;
  /** Show a transient notification. Unset → the built-in toast. */
  notify?: (message: string, tone?: 'info' | 'error') => void;
  /** Ask the user to confirm a destructive action. Unset → the built-in dialog. */
  confirm?: (options: ConfirmOptions) => Promise<boolean>;
  /** Plan/route/device rendering colours. */
  mapStyle?: MapStyleOptions;
  /** Override any library UI strings (deep-merged over the built-in English); read via useStrings(). */
  strings?: DeepPartial<En>;
}
const ThemeContext = createContext<KerrosTheme>({});
export function KerrosThemeProvider({ theme = {}, children }: { theme?: KerrosTheme; children: ReactNode }) {
  // Only the tokens are inline — they are the one genuinely dynamic part. The wrapper's layout role
  // (none: display:contents) is .kerros-passthrough in the stylesheet, kept apart from .kerros-root so
  // that "scope for the resets" and "box in the layout" stay two separate, legible ideas.
  const style = Object.fromEntries(
    Object.entries(theme.tokens ?? {}).map(([k, v]) => [k.startsWith('--') ? k : `--${k}`, v]),
  ) as CSSProperties;
  return (
    <ThemeContext.Provider value={theme}>
      <div className="kerros-root kerros-passthrough" style={style}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
export const useKerrosTheme = () => useContext(ThemeContext);

// Library UI strings with the host's overrides deep-merged over the built-in English (one level of
// nesting — tools/navigate/map — is enough for the current dictionary).
export function useStrings(): En {
  const { strings } = useKerrosTheme();
  return useMemo(() => {
    if (!strings) return en;
    const out = { ...en } as Record<string, unknown>;
    for (const [k, v] of Object.entries(strings))
      out[k] =
        v && typeof v === 'object' && !Array.isArray(v)
          ? { ...((en as Record<string, unknown>)[k] as object), ...v }
          : v;
    return out as En;
  }, [strings]);
}
