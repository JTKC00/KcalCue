interface RangeRailProps {
  range: { min: number; max: number } | null;
  ticks?: boolean;
}

/** Draws a kcal range to scale on a rail that starts at 0 and reaches at least 1500 kcal. */
export function RangeRail({ range, ticks = true }: RangeRailProps) {
  const railMax = range ? Math.max(1500, Math.ceil(range.max / 500) * 500) : 1500;
  const step = railMax <= 2000 ? 500 : 1000;
  const marks: number[] = [];
  for (let value = 0; value <= railMax; value += step) marks.push(value);
  const left = range ? (range.min / railMax) * 100 : 0;
  const width = range ? Math.max(((range.max - range.min) / railMax) * 100, 1.2) : 100;
  return (
    <span className="range-rail" aria-hidden="true">
      <span className={range ? "range-rail-track" : "range-rail-track is-unknown"}>
        {range && <span className="range-rail-fill" style={{ left: `${left}%`, width: `${width}%` }} />}
      </span>
      {ticks && (
        <span className="range-rail-ticks">
          {marks.map((value) => (
            <span key={value} style={{ left: `${(value / railMax) * 100}%` }}>{value}</span>
          ))}
        </span>
      )}
    </span>
  );
}
