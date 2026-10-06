import { useEffect, useId, useRef, useState } from "react";
import { PenroseTriangleFaces } from "./penrose-triangle";
import { chooseFrameworkConnections, createFrameworkConnections, createFrameworkFormation, createFrameworkParticles, frameworkPositions, type FrameworkFormation } from "./framework-mark-motion";
import "./framework-mark.css";

/** Decorative framework metaphor, not a loading or live phase indicator. */
export function FrameworkMark({ active = true }: { active?: boolean }) {
  const id = useId();
  const [particles] = useState(createFrameworkParticles);
  const [connections] = useState(() => createFrameworkConnections(particles.length));
  const particleNodes = useRef<(SVGGElement | null)[]>([]);
  const connectionNodes = useRef<(SVGLineElement | null)[]>([]);
  const formation = useRef<FrameworkFormation | null>(null);
  const timeline = useRef({ elapsed: 0, nextSelection: 3300, selected: new Set<number>(), opacity: connections.map(() => 0) });
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => setReducedMotion(motion.matches);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", preference);
    visibility();
    preference();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", preference);
    };
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      // CSS disables the reveal too: leave a complete, static scattered mark.
      particles.forEach(({ home }, index) => particleNodes.current[index]?.setAttribute("transform", `translate(${home.x} ${home.y})`));
      connectionNodes.current.forEach(node => node?.setAttribute("opacity", "0"));
      timeline.current = { elapsed: 0, nextSelection: 3300, selected: new Set<number>(), opacity: connections.map(() => 0) };
      formation.current = null;
      return;
    }
    if (!active || hidden) return;
    let frame = 0;
    let previous: number | null = null;
    const animate = (timestamp: number) => {
      const delta = previous === null ? 0 : Math.min(timestamp - previous, 100);
      previous = timestamp;
      const current = timeline.current;
      current.elapsed += delta;
      if (current.elapsed >= 3300 && (!formation.current || current.elapsed >= formation.current.next)) {
        formation.current = createFrameworkFormation(current.elapsed, formation.current);
      }
      const { positions, strength } = frameworkPositions(particles, current.elapsed, formation.current);
      // Squares and lines share coordinates; no layout reads or React renders
      // are needed per frame. Paused time never advances the formation clock.
      positions.forEach(({ x, y }, index) => particleNodes.current[index]?.setAttribute("transform", `translate(${x} ${y})`));
      if (current.elapsed >= current.nextSelection) {
        current.selected = chooseFrameworkConnections(connections, positions, current.selected);
        current.nextSelection = current.elapsed + 4000 + Math.random() * 3000;
      }
      const fade = 1 - Math.exp(-delta / 650);
      connections.forEach(({ from, to }, index) => {
        if (!current.selected.has(index) && current.opacity[index] === 0) return;
        const node = connectionNodes.current[index];
        if (!node) return;
        current.opacity[index] += ((current.selected.has(index) ? 1 : 0) - current.opacity[index]) * fade;
        const opacity = current.opacity[index] * .4 * (1 - strength * .25);
        node.setAttribute("opacity", opacity < .002 ? "0" : String(opacity));
        if (opacity < .002) {
          if (!current.selected.has(index)) current.opacity[index] = 0;
          return;
        }
        node.setAttribute("x1", String(positions[from].x));
        node.setAttribute("y1", String(positions[from].y));
        node.setAttribute("x2", String(positions[to].x));
        node.setAttribute("y2", String(positions[to].y));
      });
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [active, hidden, reducedMotion, particles, connections]);

  return <svg className="framework-mark" width="480" height="372" viewBox="-8 -6 40 31"
    fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" data-paused={!active || hidden ? true : undefined}>
    <defs>
      <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation=".8" />
      </filter>
      <radialGradient id={`${id}-center`} cx="50%" cy="62%" r="65%">
        <stop offset="0" stopColor="currentColor" stopOpacity=".9" />
        <stop offset=".55" stopColor="currentColor" stopOpacity=".35" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0" />
      </radialGradient>
    </defs>
    <g className="framework-mark-mesh" strokeWidth=".08">
      {connections.map(({ from, to }, index) => <line key={`${from}-${to}`} opacity="0"
        ref={node => { connectionNodes.current[index] = node; }}
        x1={particles[from].home.x} y1={particles[from].home.y}
        x2={particles[to].home.x} y2={particles[to].home.y} />)}
    </g>
    <path className="framework-mark-glow" d="M12 3.34 22 20.66H2Z"
      strokeWidth="2.3" filter={`url(#${id}-glow)`} />
    <PenroseTriangleFaces faceClassName="framework-mark-face" />
    <path className="framework-mark-center" d="M12 10.27 16 17.2H8Z"
      fill={`url(#${id}-center)`} stroke="none" />
    {particles.map(({ home }, index) => <g key={index}
      ref={node => { particleNodes.current[index] = node; }}
      transform={`translate(${home.x} ${home.y})`}>
      <g className="framework-mark-particle"
        style={{ animationDelay: `${2100 + index * 40}ms` }}>
        <rect x="-.45" y="-.45" width=".9" height=".9"
          fill="var(--penrose-background, var(--background))" stroke="none" />
        <rect x="-.45" y="-.45" width=".9" height=".9" fill="currentColor" fillOpacity=".2" opacity=".8"
          stroke="currentColor" strokeWidth=".14" strokeLinejoin="miter" />
      </g>
    </g>)}
  </svg>;
}
