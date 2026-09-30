(function (global) {
  function verifyReceipt(receipt, expectedCount) {
    if (receipt?.ignoredDeletedEvents) {
      throw new Error(`${receipt.ignoredDeletedEvents} message(s) belong to a deleted conversation and were not imported.`);
    }
    const result = receipt?.result;
    const received = result?.received;
    const accountedFor = Number(result?.inserted) + Number(result?.updated) + Number(result?.duplicates);
    if (receipt?.ok !== true || result?.status !== "committed"
      || received !== expectedCount || accountedFor !== expectedCount) {
      throw new Error("The cloud did not confirm every message in this import batch. Review the import before retrying.");
    }
    return received;
  }

  global.SherryImportIntegrity = { verifyReceipt };
})(globalThis);
