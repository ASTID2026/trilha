type Uasg = { uasg?: string; uasgName?: string; uasgUf?: string };

export function formatUasg(publication?: Uasg) {
  if (!publication?.uasg) return "UASG não identificada";
  return `UASG ${publication.uasg} · ${publication.uasgName || "Nome não identificado"}`;
}

// Enrich the presentation of extracted evidence without altering its source.
export function formatUasgEvidence(evidence: string, publication?: Uasg) {
  return publication?.uasg && evidence.trim() === `UASG: ${publication.uasg}`
    ? formatUasg(publication)
    : evidence;
}
