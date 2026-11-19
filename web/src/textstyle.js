// Resolve both direct text selection and labels attached to selected shapes.
export function selectedTexts(elements, selected) {
  return elements.filter(e => !e.isDeleted && e.type === 'text' &&
    (selected[e.id] || (e.containerId && selected[e.containerId])));
}
export function selectedStyle(texts, fonts) {
  const common = key => texts.every(e => e[key] === texts[0][key]) ? texts[0][key] : null;
  return {font: fonts.find(f => f.family != null && f.family === common('fontFamily'))?.id ?? null,
    fontSize: common('fontSize')};
}
export function restyleText(elements, selected, patch, restore) {
  const targets = new Set(selectedTexts(elements, selected).map(e => e.id));
  if (!targets.size) return null;
  const input = elements.map(e => targets.has(e.id) ? {...e, ...patch, text: e.originalText ?? e.text} : {...e});
  const measured = new Map(restore(input, null, {repairBindings:true, refreshDimensions:true}).map(e => [e.id,e]));
  return elements.map(e => targets.has(e.id) ? {...e, ...measured.get(e.id),
    version:e.version+1, versionNonce:Math.floor(Math.random()*2**31)} : e);
}
