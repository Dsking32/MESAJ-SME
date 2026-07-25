import { cn } from "@/lib/cn";

/**
 * Visualizes how a message fills its GSM/UCS-2 segments — one block per
 * segment, filled proportionally. Reinforces that segments are billed
 * individually, which is the thing clients most often get wrong.
 */
export function SegmentMeter({
  segments,
  charsRemainingInSegment,
  segmentSize,
}: {
  segments: number;
  charsRemainingInSegment: number;
  segmentSize: number;
}) {
  const shown = Math.max(segments, 1);
  const currentFill = segments === 0 ? 0 : (segmentSize - charsRemainingInSegment) / segmentSize;

  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: Math.min(shown, 6) }).map((_, i) => {
        const isLast = i === shown - 1;
        const isOverflowMarker = shown > 6 && i === 5;
        const fill = isLast ? Math.max(currentFill, segments === 0 ? 0 : 0.08) : 1;
        return (
          <div key={i} className="relative h-1.5 w-6 overflow-hidden rounded-full bg-[var(--color-ink-100)]">
            {!isOverflowMarker && (
              <div
                className={cn("h-full rounded-full transition-all", segments > 1 ? "bg-[var(--color-amber-600)]" : "bg-[var(--color-brand-600)]")}
                style={{ width: `${fill * 100}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
