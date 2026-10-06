import type { SVGProps } from "react";

const triangleFaces = [
  ["engineering", "M2 20.66h4L14 6.8l-2-3.46Z", .12],
  ["planning", "m12 3.34-2 3.46 8 13.86h4Z", .3],
  ["design", "m22 20.66-2-3.46H4l-2 3.46Z", .2],
] as const;

/** Shared logo/tool geometry; opaque face bases preserve the cyclic overlaps. */
export function PenroseTriangleFaces({ faceClassName }: { faceClassName?: string } = {}) {
  const background = "var(--penrose-background, var(--background))";
  return <g strokeWidth="1">
    {triangleFaces.map(([phase, path, shade]) => <g key={path} className={faceClassName} data-phase={phase}>
      <path d={path} fill={background} stroke="none" />
      <path d={path} fill="currentColor" fillOpacity={shade} />
    </g>)}
    {/* The left face's bottom overlap must stay above the other faces. */}
    <g className={faceClassName} data-phase="engineering">
      <path d="M2 20.66h4l2-3.46H4Z" fill={background} stroke="none" />
      <path d="M2 20.66h4l2-3.46H4Z" fill="currentColor" fillOpacity=".12" stroke="none" />
      <path d="M4 17.2 2 20.66h4l2-3.46" />
    </g>
  </g>;
}

export function PenroseTriangle({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <PenroseTriangleFaces />
  </svg>;
}
