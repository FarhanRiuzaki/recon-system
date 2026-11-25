// Focus a step's control even when it sits in a closed disclosure ("View as list"): the disclosure opens first.
export function focusControl(id: string): void {
  const el = document.getElementById(id);
  const around = el?.closest("details");
  if (around && !around.open) around.open = true;
  el?.focus();
}
