import { useEffect, useId, useRef, useState } from "react";
import { PenroseTriangleFaces } from "./penrose-triangle";
import "./framework-mark.css";

const supportSpawnPoints = [
  { x: -2, y: 8 },
  { x: -3, y: 14 },
  { x: -3, y: 21 },
  { x: 26, y: 8 },
  { x: 27, y: 14 },
  { x: 27, y: 21 },
  { x: 6, y: 0 },
  { x: 18, y: 0 },
  { x: 8, y: 25 },
  { x: 18, y: 25 },
] as const;

type SupportParticle = { point: number; introOrder?: number; leaving?: boolean };
const minParticles = 3;
const maxParticles = 5;

function initialParticles(): SupportParticle[] {
  const available = supportSpawnPoints.map((_, point) => point);
  return Array.from({ length: minParticles }, (_, introOrder) => ({
    point: available.splice(Math.floor(Math.random() * available.length), 1)[0],
    introOrder,
  }));
}

/** Decorative framework metaphor, not a loading or live phase indicator. */
export function FrameworkMark({ active = true }: { active?: boolean }) {
  const id = useId();
  const [particles, setParticles] = useState(initialParticles);
  const [ambientReady, setAmbientReady] = useState(false);
  const lastRetiredPoint = useRef<number | null>(null);
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
    // A preference change can cancel a fade-out before its animationend event.
    if (reducedMotion) {
      const retiring = particles.find(particle => particle.leaving);
      if (retiring) {
        lastRetiredPoint.current = retiring.point;
        setParticles(current => current.filter(particle => !particle.leaving));
      }
      return;
    }
    if (!active || hidden || !ambientReady || particles.some(particle => particle.leaving)) return;
    const timer = window.setTimeout(() => {
      const direction = Math.random();
      const selection = Math.random();
      setParticles(current => {
        if (current.length === minParticles || current.length < maxParticles && direction < .5) {
          const available = supportSpawnPoints.map((_, point) => point).filter(point =>
            point !== lastRetiredPoint.current && !current.some(particle => particle.point === point));
          return [...current, { point: available[Math.floor(selection * available.length)] }];
        }
        const retiring = Math.floor(selection * current.length);
        return current.map((particle, index) => index === retiring ? { ...particle, leaving: true } : particle);
      });
    }, 4000 + Math.random() * 3000);
    return () => window.clearTimeout(timer);
  }, [active, hidden, reducedMotion, ambientReady, particles]);

  return <svg className="framework-mark" width="480" height="408" viewBox="-8 -6 40 34"
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
    <path className="framework-mark-glow" d="M12 3.34 22 20.66H2Z"
      strokeWidth="2.3" filter={`url(#${id}-glow)`} />
    <PenroseTriangleFaces faceClassName="framework-mark-face" />
    <path className="framework-mark-center" d="M12 10.27 16 17.2H8Z"
      fill={`url(#${id}-center)`} stroke="none" />
    {particles.map(({ point, introOrder, leaving }) => <g key={point}
      transform={`translate(${supportSpawnPoints[point].x} ${supportSpawnPoints[point].y})`}>
      <g className="framework-mark-particle" data-intro={introOrder !== undefined ? true : undefined}
        data-leaving={leaving ? true : undefined}
        style={{ animationDelay: `${!leaving && introOrder !== undefined ? 2100 + introOrder * 100 : 0}ms` }}
        onAnimationEnd={event => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName === "framework-particle-disappear") {
            lastRetiredPoint.current = point;
            setParticles(current => current.filter(particle => particle.point !== point));
          } else if (event.animationName === "framework-particle-appear" && introOrder === minParticles - 1) {
            setAmbientReady(true);
          }
        }}>
        <g className="framework-mark-float" data-motion={point % 3}
          style={{ animationDelay: introOrder !== undefined ? "2700ms" : "700ms" }}>
          <rect x="-1" y="-1" width="2" height="2"
            fill="var(--penrose-background, var(--background))" stroke="none" />
          <rect x="-1" y="-1" width="2" height="2" fill="currentColor" fillOpacity=".2"
            stroke="currentColor" strokeWidth=".3" strokeLinejoin="miter" />
        </g>
      </g>
    </g>)}
  </svg>;
}
