# SANE framework visual and motion pattern

This is the canonical visual pattern for representing the SANE framework in the
App. Its first implementation target is the **New Conversation chat panel**.
This document establishes the design contract; it does not change the UI.

## Meaning and spatial mapping

The existing Penrose-like triangle represents the Main Track:

| Region | Phase | Meaning |
| --- | --- | --- |
| Bottom side | Design | Defines the intent and desired outcome. |
| Left side | Engineering | Shapes the technical solution. |
| Right side | Planning | Organizes the work into executable steps. |
| Center | Execution | Carries out the work shaped by all three sides. |

**All three sides give shape to the center. Design, Engineering, and Planning
give shape to Execution.**

Execution is the space framed by the triangle, not a fourth side. Keep the center
open and recognizable; its light expresses Execution without adding a solid
fourth piece or changing the logo's silhouette.

Small floating squares around the triangle represent the **Support Track**:
Research, Curation, and other supporting phases. They accompany and inform the
Main Track rather than forming another side or a mandatory next step.

This is a framework metaphor, not a live phase indicator, progress meter, loading
animation, or claim that work is currently running. Intro order communicates the
framework's main progression; it does not prohibit iteration or revisiting phases.

## Visual language

- Use vector geometry: SVG paths, rectangles, gradients, and restrained glow layers.
  No video, raster animation, canvas simulation, WebGL, or 3D scene is needed.
- Preserve the existing triangle proportions, face shading, and cyclic overlaps.
  The Penrose illusion belongs to the logo; motion remains entirely 2D.
- Use the App's theme colors, led by the existing primary color. Distinguish the
  phases by position and sequence, not four new mandatory colors.
- Keep glows soft, low-opacity, and local to the mark. The triangle's outline
  remains crisp; no bright neon bloom or large background wash.
- Draw support particles as upright vector squares with a solid light border and
  a darker, lightly shaded interior, matching the triangle's face treatment.
  Keep them flat and unrotated; no spheres or 3D objects.
- Keep the hierarchy clear: triangle first, center accent second, particles third.
  Text and the composer remain the primary interactive content.
- The current welcome composition is a large, responsive animation followed by
  **Design | Engineer | Plan | Execute** in the existing eyebrow/subtitle
  typography at **14px**, with a tight gap beneath the animation. The **SANE**
  title is temporarily commented out for visual review; its sans-serif styling
  is retained so it can be restored easily. This replaces the former welcome prompt,
  descriptive paragraph, workspace label, and suggestion buttons. An explanatory
  diagram can add region labels while preserving the same spatial mapping.

## Intro choreography

Play this sequence once when the New Conversation welcome state is entered:

1. **Design / bottom:** fade and slide the bottom side gently into its final place.
2. **Engineering / left:** fade and slide the left side into place.
3. **Planning / right:** fade and slide the right side into place.
4. **Unified glow:** only after all three sides have settled, fade the perimeter
   glow and the Execution light inside the central opening in and out together.
   Both rise, peak, and fall at the same time. The perimeter settles at a faint
   resting level; the transient center shine ends. Do not sweep a highlight
   across the entire panel.
5. **Support Track:** fade in the surrounding squares, then let them settle into
   small, slow floating movements.

Use fade plus a short translation for the first implementation, not a separate
stroke-drawing effect. The reveal order is fixed; the exact timings are tunable.
No bounce, overshoot, spinning triangle, or repeated assembly sequence.

### Starting motion values

These are implementation starting values, not additional framework semantics:

| Event | Time from entry | Behavior |
| --- | --- | --- |
| Bottom reveal | 0–400 ms | Opacity 0 → 1; short inward slide. |
| Left reveal | 400–800 ms | Same treatment. |
| Right reveal | 800–1,200 ms | Same treatment. |
| Unified perimeter and center glow | 1,200–2,100 ms | One synchronized rise and fall; perimeter stays faintly lit, center shine ends. |
| Squares appear | 2,100–2,700 ms | Gentle fade-in, optionally lightly staggered. |
| Ambient state | After 2,700 ms | Static faint triangle glow; slow square drift. |

Use smooth ease-out for assembly and smooth ease-in-out for light and drifting.
Begin with a side translation of roughly 4–8% of the triangle's rendered width.
Reserve the full illustration footprint before animation starts: nothing nearby
should shift as sides, glows, or particles appear.

## Resting / ambient state

After the intro, keep the assembled triangle and a **constant faint perimeter
glow**. Do not repeat the perimeter pulse or center shine. The center returns to
its open, quiet appearance.

Start with three support squares at randomly selected points. After the intro,
vary the population between **three and five squares** across **ten fixed spawn
points**. The count is a visual composition choice, not an enumeration of Support
Track phases.

- Place squares around the outside of the bottom, left, and right regions,
  with room between their borders and the triangle.
- Each particle stays near its own anchor on a short 2D path: a gentle arc,
  small ellipse, or back-and-forth drift.
- Every 4–7 seconds, randomly add a square at an unoccupied point or retire one.
  At three squares, the next change must add one; at five, it must retire one.
  Never retire a square if doing so would leave fewer than three.
- Use gentle 700ms ambient fade-ins and fade-outs. A retiring square continues
  to count toward the maximum and reserves its point until the fade completes.
  Do not spawn at the most recently retired point; the next arrival should be
  somewhere else. Other squares keep their existing positions and drift timelines.
- Start with travel of roughly 3–6% of the triangle width and independent
  6–10 second periods. Blend loop boundaries without jumps.
- Avoid a full revolution around the triangle, crossing through the center,
  depth changes, perspective, or synchronized circling. Call this **floating**
  rather than orbiting in implementation and UI discussions.
- Keep population changes infrequent and fades soft, without flashing or bursts.
  This should read as a quiet living mark, not a busy particle field or spinner.

## Lifecycle, accessibility, and performance

- Animation must never delay typing, sending, or navigation.
  Leaving the welcome view interrupts it immediately; do not wait for completion.
- Play the intro on a genuine entry into New Conversation, not every React
  render, draft edit, resize, theme change, or store update. A later deliberate
  return to New Conversation may play it again.
- Under `prefers-reduced-motion: reduce`, show the complete triangle, faint static
  glow, and static particles immediately. No assembly, light pulses, drift, or
  population changes. Pause the population scheduler while the view or document
  is hidden, and cancel its timer when the mark unmounts.
- The non-animated baseline must also be the completed composition. Disabling
  animation must not strand faces or particles at zero opacity or off-position.
- Keep the decorative SVG hidden from assistive technology and out of the tab
  order. An explanatory use elsewhere must provide equivalent text for the
  phase mapping; the animation alone cannot teach it accessibly.
- Ensure the silhouette remains legible in light and dark themes without relying
  on glow. Allow space for halos without clipping or covering adjacent content.
- Use a small fixed set of SVG elements and CSS opacity/transform animations.
  Prefer fixed glow layers with animated opacity over continuously changing blur.
  Do not introduce per-frame React state updates or an animation dependency for
  this first use. Pause ambient motion while the document or view is hidden;
  resume without replaying the intro.

## First implementation: New Conversation

### Repository integration points

- [`thread.tsx`](../../packages/sane-app/frontend/thread.tsx): the `.welcome`
  branch renders the framework animation and phase subtitle, with the SANE title
  temporarily commented out.
  Preserve existing loading/error precedence and composer behavior. The former
  welcome prompt, description, and suggestions are intentionally removed.
  Do not animate the selected conversation's “No messages
  yet” state or conversation loading state.
- [`penrose-triangle.tsx`](../../packages/sane-app/frontend/penrose-triangle.tsx):
  shared SVG geometry already exists. Its face array is currently **left, right,
  bottom**; that is not the intro order. Associate faces with semantic regions
  and animate bottom, left, right without breaking the rendering order and
  overlap patch that preserve the Penrose illusion. Include the patch in the
  appropriate reveal so it does not appear ahead of its face.
- [`style.css`](../../packages/sane-app/frontend/style.css): existing welcome
  layout, theme tokens, and global reduced-motion rules provide the baseline.
  Scope new motion styles to the animated welcome variant. Do not globally
  enlarge `.welcome-mark` or affect its use on the authentication screen.

Prefer a reusable, opt-in framework-mark component with its own reserved SVG
viewport for the triangle, center light, perimeter glow, and particles. Reuse
the logo geometry rather than maintain a divergent copy. Keep the existing
static `PenroseTriangle` behavior unchanged for shell branding, system labels,
tool glyphs, notifications, loading states, and authentication.

Use a full-size, responsive welcome illustration rather than the former small
logo mark. Reserve its full footprint and scale it to the available panel width
and viewport height, with space for floating squares. Keep the animation and
phase subtitle centered on desktop and mobile. If restored, the SANE title sits
between them.

### Acceptance criteria

- Bottom = Design, left = Engineering, right = Planning, center = Execution.
- Side reveals complete in that order before the perimeter pulse begins.
- Perimeter and center glow rise and fall together; squares follow the pulse.
- Idle has only a faint static triangle glow and bounded, slow 2D particle drift.
- Ambient population stays between three and five squares across ten distinct
  spawn points, with no occupied-point reuse or abrupt repositioning.
- The Penrose silhouette and overlaps remain correct in the completed mark.
- Reduced motion shows the finished static composition with nothing missing.
- No layout shifts, clipped halos, interaction delay, or intro replay on rerenders.
- Existing static logo uses and other chat states remain unchanged.
- Welcome currently shows only the enlarged animation and 14px phase subtitle.

**Readiness:** the first implementation is ready to proceed in the New
Conversation chat panel. The repository already has the vector logo, theme
tokens, reduced-motion baseline, and an isolated welcome-state insertion point.
No new runtime framework or backend behavior is required. Exact scale, glow
strength, and motion values remain visual-tuning decisions within this contract.
