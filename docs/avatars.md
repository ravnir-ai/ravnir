# Agent avatars

`public/avatar.js` is the shared browser and server renderer. `public/studio.js` provides the look card and studio. The original inline SVG artwork has no runtime dependencies on the application module.

## The character library

The library keeps distinct silhouettes, clear identity colors, customization and expressive interactions together.

The objects use directional satin shading, ceramic surfaces, brushed metal and frosted glass. Smaller faces and quieter catchlights replace the oversized baby-like faces and candy-like reflections. Their selected body color remains visible. Ceramic shading stays within its color family. Crowns, glasses, headsets, antennae, plants and orbiting moons remain available, with cleaner geometry and restrained highlights.

| Body | Shape and finish | First preset |
| --- | --- | --- |
| Raven | Adult perched profile, charcoal feathers and subtle sheen | Midnight |
| Orb | Spherical body and a restrained glass rim | Comet |
| Egg | Narrow upright ovoid, ceramic surface | Owl |
| Capsule | Slender pill and matte color | Sprig |
| Cube | Crisp isometric planes and satin color | Cobalt |
| Screen | Monitor with a small bezel radius and a flat stand | Pixel |
| Can | Cylindrical body, elliptical lid and brushed metal | Tin |
| Dome | Broad arch with a clean flat base | Mochi |
| Gem | Distinct faceted outline and metallic planes | Regal |
| Ring | Larger open center and a copper-colored band | Donut |

These ten presets appear before repeated raven variants. All previous preset names remain usable. A curated identity palette appears before the earlier palette; arbitrary saved custom colors remain valid. The product logo is a separate asset.

## Suggestions and saved looks

Match the job uses the body families across roles: chief uses raven, engineering screen, finance cube, research orb, growth capsule, communications dome, audit gem, assistant egg, job search ring, and creative work can. This affects suggestions and new-agent defaults. A saved look keeps its selected body, color, face, material and accessory unless the owner changes it.

Unknown or missing body values normalize to raven. Older blob, bean, cloud, drop and pebble values keep their established mappings.

Material keys retain their storage values while the studio describes the new rendering:

| Stored key | Object finish | Raven finish |
| --- | --- | --- |
| matte | Matte | Matte |
| gloss | Satin | Satin |
| glass | Frosted glass | Soft |
| metal | Brushed metal | Graphite |
| pearl | Ceramic | Iridescent |

Objects keep all eye and mouth styles, optional blush, eye size, spacing and height controls. Surface faces are labeled Inlaid. Visors remain dark with small lit eyes. Explicit choices are preserved; the new presets favor smaller, quieter faces without removing customization.

## Raven identity

Ravens have a smaller skull and natural profile eye, long folded primaries, a dark bill and a wedge tail. Feather color appears as a restrained sheen over charcoal, including for saved pastel or vivid colors. A small rim keeps the outline visible in dark themes.

Eight eye treatments retain natural proportions: Natural, Alert, Ringed, Sharp, Soft, Narrow, Bright and Pale. Eye size, height and iris color remain adjustable. Natural shows the eye; Marked combines the eye with an insignia; Mark only shows the insignia alone. The mark catalog supplies initials and symbols such as a compass, shield, book and terminal.

Saved accessory keys select natural raven plumage, with matching studio labels:

| Stored key | Raven treatment | Object accessory |
| --- | --- | --- |
| none | Smooth | None |
| antenna | Crest | Antenna |
| orbit | Scapular | Moon |
| halo | Collar | Halo |
| sprout | Tuft | Sprout |
| crown | Swept | Crown |
| headset | Mantle | Headset |
| glasses | Brow | Glasses |

The additional raven presets Scholar, Patina, Umber, Sentinel, Quill and Ember remain after the full-library lineup. Selecting an already-selected Raven body preserves its chosen insignia.

## Status, interaction and motion

Objects retain gaze, hovering, tapping, breathing, blinks, personality-dependent reactions and speech. Their status expressions remain: working narrows the eyes and adds a gentle glow, waiting looks attentive and nudges, completion smiles and hops, pausing closes the eyes, and speech drives the mouth or visor. Paused agents ignore taps and transient completion reactions.

In Full motion, a raven fans its wings on hover. Tapping produces a short flutter and greeting whose lift varies by personality. Working ravens fly with slow wingbeats, keep flying through taps and return to a perch on completion. Calm birds have measured greetings, cheerful birds flutter energetically, curious birds lean toward the pointer, focused birds glide longer and shy birds spread their wings more cautiously. Speech drives a small jaw opening.

Raven status indicators accompany those poses: muted sage while working, amber while waiting, green when done, gray when paused and slate blue while speaking. Avatars have an accessible status description as well as color; surrounding app status text remains.

Subtle suppresses large movement and replaces the orbit accessory's SVG motion with a still moon. Working ravens show a static flight pose. Off and the system reduced-motion preference stop every CSS animation and animated pseudo-element, SVG orbit, gaze movement and voice-driven body, face and glow movement. State remains readable without animation.

Changing motion preferences refreshes the stored rendered look with the current mood and identity, so an orbit built during Full does not keep moving after Off is selected. Returning to Full restores its SVG animation. Polling still keeps cached avatars unless their look or rendering options change.

## API and verification

`RavnirAvatar.render(node, look, { name, seed, color, state, bot })` accepts working, waiting, sleeping, happy and speaking states. `setState` changes status, `react` briefly acknowledges an event, `speak` sets voice level from 0 to 1, `attend` directs gaze and `clear` removes the avatar. `setMotion("full" | "subtle" | "off")` persists under `ravnir.avatarMotion`.

`normalize`, `suggest`, `preset`, `random` and `markup` run without a DOM. `RAVEN_PLUMAGE`, `RAVEN_COLORS`, `RAVEN_MATERIALS` and `RAVEN_EYES` supply the raven studio catalogs. `markup` and `render` retain `face: false`, `mark: false` and `extras: false` preview options.

`test/avatar-library.test.js` covers role and preset variety, dynamic SVG motion preferences, identity and mood retention, speaking stillness and the object status and accessory set under reduced motion. `test/raven-ui.test.js` covers restored raven interactions and the phone studio. General avatar schema, persistence and SVG validity coverage remains in `test/core.test.js`, `test/raven.test.js` and `test/avatar-speaking.test.js`.

The local study at `docs/brand/mature-ravens.html` shows the entire mixed library, both themes, sidebar views, body outlines and a mixed team. Its current screenshot is `docs/brand/mature-library-preview.png`. Tap a character, select its name to customize it, or change the status and motion controls.

`docs/brand/avatar-lineup-comparison.png` compares earlier crows, the first mature ravens and the object lineup. Small-size visual checks are design inspections, not a measured recognition study.
