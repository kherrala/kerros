# Enable MML vector maps

The reference apps can use the National Land Survey of Finland (Maanmittauslaitos, MML) vector basemap, adopt building footprints, display surrounding buildings and overlay cadastral boundaries. These are optional host adapters; the library does not contain an API key.

## Obtain and configure the key

1. Follow [MML's API key instructions](https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje) to register or sign in to **OmaTili** and create an API key for the open interfaces.
2. Copy `.env.example` to `.env.local` if needed, then set:

   ```dotenv
   VITE_MML_API_KEY=your_mml_key
   ```

3. Run `make up`, or restart it after changing the key. For native development, restart `make dev`.
4. Open a project and choose **Map settings → Basemap → MML · Finnish land survey**. Enable **Property boundaries** for the cadastral overlay and **3D city buildings** for surrounding massing. The **Architecture plan** option controls the plan overlay's visibility.

The `VITE_` key is visible in browser requests and compiled browser assets. Keep `.env.local` out of Git; use MML's account tools to replace the key if necessary. Do not use this public configuration mechanism for the Claude secret.

## What the adapter requests

`app/mmlBasemap.ts` ([source below](#reference-adapter)) is the reference implementation. It uses:

| Resource | Configuration |
| --- | --- |
| Basemap style | `/vectortiles/stylejson/v20/backgroundmap.json?TileMatrixSet=WGS84_Pseudo-Mercator` |
| Cadastral TileJSON | `/kiinteisto-avoin/v3/kiinteistojaotus/WGS84_Pseudo-Mercator/tilejson.json` |
| Building layer | `rakennus`, with `mtk_id` identity and `kerrosluku` storey data |
| Parcel and boundary layers | `PalstanSijaintitiedot`, `KiinteistorajanSijaintitiedot` |
| Boundary markers and labels | `RajamerkinSijaintitiedot`, `KiinteistotunnuksenSijaintitiedot` |

Both resource paths use `https://avoin-karttakuva.maanmittauslaitos.fi`. The adapter appends `api-key` to requests only when the hostname matches that service. Authentication must reach the style, tiles, fonts and sprites: MML's returned resource links do not automatically retain a caller's key. The adapter preserves MML attribution.

MML publishes vector tiles in both EPSG:3067 and EPSG:3857. This MapLibre integration chooses **WGS84_Pseudo-Mercator / EPSG:3857**. That choice is separate from converting an imported survey drawing's coordinate system. See the [official vector service technical documentation](https://www.maanmittauslaitos.fi/kartat-ja-paikkatieto/aineistot-ja-rajapinnat/karttojen-rajapintapalvelut/karttakuvapalvelu-wms) and [NLS service repository](https://github.com/nlsfi/avoin-karttakuva.maanmittauslaitos.fi/blob/master/README.md).

## Use in another host

Copy or adapt `app/mmlBasemap.ts` into your host, then supply its result as `PlannerAdapters.basemap` for the editor or `basemap` for the viewer. The adapter is reference-app code, not a named export from the library packages. Its `vectorSchema` describes the service's building, context and cadastral layers; merely supplying a style URL does not configure those capabilities. See [host extensions](./extending#custom-basemaps).

## Troubleshooting

- **MML is absent from the basemap picker:** the app was started or built without `VITE_MML_API_KEY`. Restart after editing `.env.local`; a published build needs the variable at build time.
- **401/403 responses or missing labels:** inspect the failed service request in browser developer tools. Check that it targets the MML hostname and carries `api-key`, including font/sprite/tile requests.
- **Map works, parcel lines are missing:** enable **Property boundaries**, zoom into Finland and inspect requests to the separate `kiinteisto-avoin` service.
- **Backrooms still has a plain background:** select the MML basemap explicitly. That fictional example opens on the plan background by design.

## Reference adapter

This example is included from the repository source using a relative path, so the guide follows the implementation.

<<< ../../app/mmlBasemap.ts
