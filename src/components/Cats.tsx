// Tux (tuxedo, the web researcher) and Cali (calico kitten, the memory keeper).
// Pixel sprites live in /public/cats; animations are in globals.css.

/* eslint-disable @next/next/no-img-element -- tiny pixel SVGs, no optimisation needed */

type Sprite = "tux" | "tux-look" | "cali" | "cali-nap";

// Sprites are 15×14 pixels; `scale` is screen px per sprite pixel (whole numbers keep edges crisp).
export function Cat({ sprite, scale, alt = "", className = "" }: { sprite: Sprite; scale: number; alt?: string; className?: string }) {
  return <img src={`/cats/${sprite}.svg`} alt={alt} width={15 * scale} height={14 * scale} className={`pixelated ${className}`} />;
}

export type Answerer = "tux" | "cali" | "both";

// Who signs the answer: Tux when it used the web, Cali when it used memory, both when both.
export function CatAvatar({ who }: { who: Answerer }) {
  if (who === "both") {
    return (
      <div className="relative h-[52px] w-12" role="img" aria-label="Tux and Cali answered, from the web and memory">
        <Cat sprite="tux" scale={3} className="absolute left-0 top-0" />
        <Cat sprite="cali" scale={2} className="absolute left-[20px] top-[24px]" />
      </div>
    );
  }
  return (
    <div className="flex w-12 justify-center">
      {who === "tux" ? <Cat sprite="tux" scale={3} alt="Tux answered, from the web" /> : <Cat sprite="cali" scale={2} alt="Cali answered, from memory" />}
    </div>
  );
}

function Paw({ className = "", color = "var(--paw)", size = 15 }: { className?: string; color?: string; size?: number }) {
  return (
    <svg width={size} height={(size * 4) / 5} viewBox="0 0 5 4" shapeRendering="crispEdges" aria-hidden="true" className={className}>
      <rect x="1" y="0" width="1" height="1" fill={color} />
      <rect x="3" y="0" width="1" height="1" fill={color} />
      <rect x="0" y="1" width="1" height="1" fill={color} />
      <rect x="4" y="1" width="1" height="1" fill={color} />
      <rect x="1" y="2" width="3" height="2" fill={color} />
    </svg>
  );
}

export type Phase = "remembering" | "searching" | "reading" | "writing";

// The loading animation for each stage of a turn.
export function CatLoader({ phase, label }: { phase: Phase; label: string }) {
  return (
    <div className="flex items-end gap-4" role="status" aria-live="polite">
      {phase === "remembering" && <Cat sprite="cali" scale={3} className="cat-hop" />}
      {phase === "searching" && (
        <div className="relative h-12 w-64 max-w-full">
          <Paw className="cat-paw absolute bottom-0.5 left-[16%] [animation-delay:.4s]" />
          <Paw className="cat-paw absolute bottom-3 left-[44%] [animation-delay:1.2s]" />
          <Paw className="cat-paw absolute bottom-0.5 left-[72%] [animation-delay:2s]" />
          <div className="cat-walk absolute bottom-0.5">
            <Cat sprite="tux-look" scale={3} className="cat-bob block" />
          </div>
        </div>
      )}
      {phase === "reading" && (
        <div className="relative h-[42px] w-[45px]">
          <Cat sprite="tux-look" scale={3} className="cat-look-a absolute left-0 top-0" />
          <Cat sprite="tux-look" scale={3} className="cat-look-b absolute left-0 top-0 -scale-x-100" />
        </div>
      )}
      {phase === "writing" && <PawDots />}
      <span className="pb-1 font-mono text-[11px] text-faint">{label}</span>
    </div>
  );
}

// Three bouncing paws, in place of typing dots.
export function PawDots() {
  return (
    <span className="inline-flex items-center gap-1.5 py-1" aria-hidden="true">
      <Paw size={14} color="var(--ink)" className="cat-dot" />
      <Paw size={14} color="var(--orange)" className="cat-dot [animation-delay:.15s]" />
      <Paw size={14} color="var(--ink)" className="cat-dot [animation-delay:.3s]" />
    </span>
  );
}
