(function (global) {
  function verifyReceipt(receipt, expectedCount, expectedBatchId) {
    if (receipt?.ignoredDeletedEvents) {
      throw new Error(`${receipt.ignoredDeletedEvents} message(s) belong to a deleted conversation and were not imported.`);
    }
    const result = receipt?.result;
    const received = result?.received;
    const counts = [received, result?.inserted, result?.updated, result?.duplicates];
    const accountedFor = result?.inserted + result?.updated + result?.duplicates;
    if (receipt?.ok !== true || result?.status !== "committed"
      || (expectedBatchId != null && receipt.batchId !== expectedBatchId)
      || !counts.every((value) => Number.isSafeInteger(value) && value >= 0)
      || received !== expectedCount || accountedFor !== expectedCount) {
      throw new Error("The cloud did not confirm every message in this import batch. Review the import before retrying.");
    }
    return received;
  }

  function verifyImportPlan(conversations) {
    const seenChats = new Set();
    let messages = 0;
    for (const conversation of conversations) {
      const chatId = String(conversation.id);
      if (!chatId.trim() || chatId !== chatId.trim() || chatId.length > 512) throw new Error("The export has an unsupported chat identity. No messages were uploaded.");
      if (seenChats.has(chatId)) throw new Error("The export repeats a chat identity. Review the file before importing.");
      seenChats.add(chatId);
      const seenMessages = new Set();
      for (const message of conversation.messages || []) {
        const messageId = String(message.id);
        if (!messageId.trim() || messageId !== messageId.trim() || messageId.length > 512) throw new Error("The export has an unsupported message identity. No messages were uploaded.");
        if (seenMessages.has(messageId)) throw new Error("The export repeats a message identity. Review the file before importing.");
        seenMessages.add(messageId);
        messages += 1;
      }
    }
    return messages;
  }

  function verifyReadback(expectedMessages, storedEvents, options = {}) {
    if (options.verificationVersion !== 2 || typeof options.redactText !== "function") {
      throw new Error("The cloud cannot verify imported text, dates and order with this verification version. Review the import before retrying.");
    }
    if (!Array.isArray(storedEvents)) throw new Error("Sherry could not read back the imported chat.");
    const expectedIds = new Set();
    const storedById = new Map();
    for (const event of storedEvents) {
      if (event.provider_message_id != null) {
        const id = String(event.provider_message_id);
        if (storedById.has(id)) throw new Error("Sherry found a repeated message identity in the stored chat.");
        storedById.set(id, event);
      }
    }
    for (const [index, message] of expectedMessages.entries()) {
      const id = String(message.id);
      if (expectedIds.has(id)) throw new Error("The export repeats a message identity. Review this chat before importing it.");
      expectedIds.add(id);
      const stored = storedById.get(id);
      if (!stored || stored.role !== message.role) {
        throw new Error("Sherry could not find every imported message when reading the chat back from the cloud.");
      }
      const sourceTime = message.timestamp == null ? null : Date.parse(message.timestamp);
      const storedTime = stored.message_timestamp == null ? null : Date.parse(stored.message_timestamp);
      if (stored.text_content !== options.redactText(message.text).value
        || !Object.hasOwn(stored, "message_timestamp")
        || (sourceTime !== null && !Number.isFinite(sourceTime))
        || sourceTime !== storedTime
        || stored.sequence !== (message.sequence ?? index)) {
        throw new Error("The stored message text, source date or order did not match this import. Review the import before retrying.");
      }
    }
    return expectedIds.size;
  }

  global.SherryImportIntegrity = { verifyReceipt, verifyImportPlan, verifyReadback };
})(globalThis);
