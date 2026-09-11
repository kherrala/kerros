# Glossary

Words this project uses in a narrow sense. Where two terms are easy to confuse, the entry says what
separates them — that distinction is usually the whole point of having both words.

::: warning About the Finnish column
Terms marked **(vak.)** are established Finnish usage in building or security practice. Terms marked
**(ehd.)** are proposals — a reasonable rendering, but not something with settled currency in Finnish
industry vocabulary. Those are the ones worth a second opinion from someone working in the field.
:::

## The model

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Ontology** | ontologia *(vak.)* | The layer describing what a building *means* — which spaces group together, what connects to what — as distinct from the geometry describing what it looks like. Not a taxonomy of object types; that is `ObjectKind`. |
| **Space** | tila *(vak.)* | Somewhere you can stand: a room, a corridor, a lobby, the inside of a lift car. Has a footprint and belongs to exactly one floor. **A space is a place; a zone is a list of places.** |
| **Zone** | vyöhyke *(vak.)* | A named *set* of spaces, with no geometry of its own. Because it is a list and not a shape it may span floors, skip buildings, and include spaces nowhere near each other. **Not a drawn area** — that is a space of kind `zone`, which is a different thing and an unfortunate collision. |
| **Portal** | kulkuyhteys *(ehd.)* | A traversable connection between **exactly two** spaces. Usually a door, sometimes a gate or turnstile, sometimes an open boundary with nothing in it. **A portal is the connection; a door is the object filling it.** One door leaf can be referenced by more than one portal. |
| **Opening** | aukko *(vak.)* | The physical object — door, gate, turnstile, window — set into a barrier. **A window is an opening but never a portal**: you cannot walk through it. |
| **Barrier** | rakenne *(ehd.)* | A linear obstruction running between two junctions — `kind: 'wall'` or `'fence'`. Walls are the fabric rooms are made of; fences enclose outdoor ground. Openings attach by kind: a door goes on a wall, a gate on a fence. |
| **Wall vs fence** | seinä *(vak.)* / aita *(vak.)* | Both are barriers; the difference here is what drawing one *does*. Drawing a **wall** across a space divides it in two. Drawing a **fence** does not — a deliberate choice, not a fact about fences, because outdoor ground is normally one large space and splitting it at every fence line would surprise more often than help. If a fenced compound should be its own space, draw it as one. |
| **Footprint** | pohja-ala *(vak.)* | The ground an object covers — its drawn outline, or the rectangle its width, depth and rotation describe when it has none. |
| **Floor / storey** | kerros *(vak.)* | A level of a building, carrying an absolute elevation in metres. **Outdoors is not a floor** — it is `floorId: null`, and treating it as a floor is the classic bug (it makes every front door look like a staircase). |
| **Entresol / mezzanine** | välikerros *(vak.)*, parvi *(vak.)* | A partial intermediate level, typically a gallery ringing a void, that does not cover the whole plate. Shown alone it reads as almost nothing, so the plan draws the storey below with it. *Parvi* suits a small loft; *välikerros* is the general term. |
| **Parcel** | tontti *(vak.)*, kiinteistö *(vak.)* | The property boundary. **Larger than the building standing on it** — it takes in the pavement out to the kerb, and drawing it tight to the footprint leaves an entrance with nothing to open onto. |
| **Site** | työmaa *(vak.)* | The outdoor extent of a project, `floorId: null`. On a construction project, the whole controlled area. |

## Direction and trust

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Passage** | kulkusuunta *(ehd.)* | Which way a portal may be crossed at all: both ways, one way, or sealed. A property of the portal, not of the policy — a fire exit is one-way whoever you are. |
| **Attestation** (`attests`) | todennettavuus *(ehd.)* | How far a crossing can be *believed*. `confirmed` — a sensor saw it. `assumed` — inferred, nobody watched. `none` — the crossing is a **request, not an event** (a lift floor button: the passenger may get out anywhere). Anything counting people must ignore `none`. |
| **Perimeter portal** | rajakulkuyhteys *(ehd.)* | A portal with **one side inside a zone and one side outside**. These are the ways in, and the only portals worth attaching a zone-entry rule to. |
| **Captive portal** | sisäinen kulkuyhteys *(ehd.)* | A portal with **both sides inside the same zone**. Crossing one does not change which zone you are in, so a rule placed here either does nothing or obstructs someone already entitled to be there. Nothing to do with the Wi-Fi login sense of "captive portal". |

## Purposes a zone may carry

A zone's `purpose` is free text — the schema neither defines nor interprets these. They are listed
only because they are the senses people reach for, and naming them keeps a model legible to the next
reader.

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Tenancy** | vuokra-alue *(vak.)* | The spaces one occupier holds, usually spanning floors. The rooms you reach *through a door* — not the shared lobby they open onto. |
| **Fire compartment** | palo-osasto *(vak.)* | A zone whose purpose is containing fire. A good example of a zone that is neither a tenancy nor a circulation core. |
| **Muster point** | kokoontumispaikka *(vak.)* | Where people gather in an evacuation. An ordinary space, usually also a member of an evacuation zone. |
| **Circulation** | kulkualue *(ehd.)* | Lobbies, corridors, stair and lift cores — the shared spaces a tenancy is reached *through*, and which usually must stay outside it. |

## Vertical transport

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Shaft / hoistway** | hissikuilu *(vak.)* | The vertical void a lift car travels in. In this model it is not an entity: a lift **is a zone** of its per-floor landing spaces. |
| **Landing** | tasanne *(vak.)* | Where a lift or stair meets a floor. Ambiguous in ordinary use between the level and the lobby you stand in; here it is the lift-car space on that floor, and the way out of it is a portal. |
| **Through car** | läpikuljettava hissikori *(ehd.)* | A lift car with doors on two sides, opening onto two different lobbies — often different tenants. Needs no special support: it is one car space with two portals. |
| **Destination dispatch** | kohdekerrosohjaus *(ehd.)* | A lift bank where the floor is keyed at a kiosk and the group controller assigns a car afterwards. The access decision precedes the car assignment, so authorization keys to the landing's zone — **never to a car**. |
| **`connects`** | sisäinen kulkeutuvuus *(ehd.)* | How a zone's own spaces reach each other. `all` — any landing to any (a lift ride is direct). `adjacent` — level by level (a stair). `up` / `down` — one-way, an escalator. |

## Views and rendering

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Cutaway / stack** | leikkauskuva *(vak.)* | The view showing every storey at once, the selected one solid inside a translucent shell. |
| **Ghost** | haamu *(ehd.)* | A surface drawn translucent because it is not the level in focus. Darkened rather than recoloured, so the floor palette still reads through it. |
| **Basemap** | taustakartta *(vak.)* | The map underneath the plan. Not tone-mapped, which is why the 3D scene is exposed slightly below 1 — otherwise a pale floor dissolves into a pale map. |
| **Buried view** | maanalainen näkymä *(ehd.)* | A view whose focus level is below grade; the ground turns to soil strata and the levels above draw as a wireframe cage. |

## Navigation

| Term | Suomeksi | Definition |
| --- | --- | --- |
| **Route graph** | reittiverkko *(ehd.)* | Nodes and edges used for routing. |
| **Derived graph** | johdettu reittiverkko *(ehd.)* | The route graph computed from the plan — spaces are nodes, portals are edges, `connects` supplies the vertical ones — rather than drawn separately. A hand-kept graph is a second description of what connects to what, and two descriptions drift. |
| **Spatial completeness** | tilallinen kattavuus *(ehd.)* | The property that every traversable region is drawn as a space. Without it a derived graph has nowhere to route through: undrawn corridors are not shortcuts, they are walls. |

## Words we deliberately do not use

| Avoided | Why |
| --- | --- |
| **Area** | Too close to both "space" and "zone", and it means the *zone* sense in most building software while meaning the *space* sense in everyday speech. Say space or zone. |
| **Room** | Fine in prose, but not a model term: a lift car and a corridor are spaces too. |
| **Level** | Used loosely for floor in speech; the schema says `Floor`, so this glossary does too. |
