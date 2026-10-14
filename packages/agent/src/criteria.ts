/** Pulls the numbered/bulleted list under an "Acceptance Criteria" heading out of a ticket description. */
export function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(#+\s*)?\**acceptance criteria\**\s*:?\s*$/i.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*]|AC\s*\d+\s*[:.)-])\s+(.*\S)\s*$/i);
    if (m) out.push(m[1]);
    else if (line.trim() && out.length) break; // next section
  }
  return out;
}
