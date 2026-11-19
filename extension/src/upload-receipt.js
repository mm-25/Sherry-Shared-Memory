// Both capture clients retain a batch until every submitted event is accounted for.
export function uploadReceiptError(batch, receipt) {
  const result = receipt?.result;
  const counts = [result?.received, result?.inserted, result?.updated, result?.duplicates];
  const metadataCount = Array.isArray(batch.conversationUpdates) ? batch.conversationUpdates.length : 0;
  const metadataConfirmed = metadataCount === 0 || (
    result?.metadataReceived === metadataCount
    && Number.isSafeInteger(result?.metadataUpdated)
    && result.metadataUpdated >= 0 && result.metadataUpdated <= metadataCount
  );
  if (receipt?.ok !== true || receipt.batchId !== batch.batchId || result?.status !== "committed"
    || !Array.isArray(batch.events) || (!batch.events.length && !metadataCount)
    || !metadataConfirmed
    || !counts.every((count) => Number.isSafeInteger(count) && count >= 0)
    || result.received !== batch.events.length
    || result.inserted + result.updated + result.duplicates !== result.received) {
    return "Sherry did not confirm this exact upload completely. Its saved messages will be retried.";
  }
  return null;
}
