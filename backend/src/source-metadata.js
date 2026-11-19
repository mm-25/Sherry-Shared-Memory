/** Classify source observations without upgrading legacy or missing facts. */
export const sourceMetadataVocabulary = Object.freeze({
  version: [1], titleBasis: ['source', 'derived', 'generic', 'user', 'unknown'],
  conversationIdentity: ['provider', 'local', 'unknown'], messageIdentity: ['provider', 'local', 'unknown'],
  timestampBasis: ['source', 'session_fallback', 'observed', 'unknown'],
  linksStatus: ['inspected', 'unavailable', 'not_inspected', 'unknown'],
  attachmentsStatus: ['inspected', 'unavailable', 'not_inspected', 'unknown']
});
export function sourceMetadataFor(event) {
  return event.source_metadata?.version === 1 ? event.source_metadata : event.sourceMetadata?.version === 1 ? event.sourceMetadata : {
    version: 1, titleBasis: 'unknown', conversationIdentity: 'unknown', messageIdentity: 'unknown',
    timestampBasis: 'unknown', linksStatus: 'unknown', attachmentsStatus: 'unknown'
  };
}
export function validateSourceMetadata(value, event, capture, conversationOnly = false) {
  if (value == null && !conversationOnly) return null;
  if (capture.schemaVersion !== 2 || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(sourceMetadataVocabulary, key)) ||
      Object.entries(sourceMetadataVocabulary).some(([key, values]) => !values.includes(value[key]))) {
    throw new Error('must be a complete supported version-1 source metadata object on a schema-v2 capture');
  }
  if (conversationOnly) {
    if (value.conversationIdentity === 'unknown' || ['messageIdentity', 'timestampBasis', 'linksStatus', 'attachmentsStatus'].some(key => value[key] !== 'unknown'))
      throw new Error('title-only updates require known conversation identity and unknown message/time/link/attachment evidence');
  } else {
    if (value.messageIdentity === 'provider' && !String(event.providerMessageId || '').trim()) throw new Error('provider message identity requires a providerMessageId');
    if (['source', 'session_fallback'].includes(value.timestampBasis) && !event.messageTimestamp) throw new Error('source/session fallback time requires messageTimestamp');
    if (value.timestampBasis === 'observed' && event.messageTimestamp != null) throw new Error('observation time cannot be an original messageTimestamp');
    if (event.captureEvidence && (value.conversationIdentity !== 'local' || value.messageIdentity !== 'local' || value.timestampBasis !== 'observed' ||
      value.titleBasis !== ({placeholder:'generic',source:'source',derived:'derived'})[event.captureEvidence.titleBasis])) throw new Error('source metadata must agree with Android observation evidence');
  }
  return Object.fromEntries(Object.keys(sourceMetadataVocabulary).map(key => [key, value[key]]));
}
