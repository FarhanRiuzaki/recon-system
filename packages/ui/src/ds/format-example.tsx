/** What a format makes of sample values, said beside its settings ("Looks like (1.500) and 98.000"). */
export function FormatExample({ items }: { items: readonly string[] }) {
  return (
    <p className="text-body-sm text-fg-3">
      Looks like {items.map((v, i) => <span key={i}>{i ? " and " : ""}<b className="font-mono font-medium text-fg">{v || "(empty)"}</b></span>)}
    </p>
  );
}
