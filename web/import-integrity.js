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

  function verifyImportPlan(conversations) {
    const seenChats = new Set();
    let messages = 0;
    for (const conversation of conversations) {
      const chatId = String(conversation.id);
      if (seenChats.has(chatId)) throw new Error("The export repeats a chat identity. Review the file before importing.");
      seenChats.add(chatId);
      const seenMessages = new Set();
      for (const message of conversation.messages || []) {
        const messageId = String(message.id);
        if (seenMessages.has(messageId)) throw new Error("The export repeats a message identity. Review the file before importing.");
        seenMessages.add(messageId);
        messages += 1;
      }
    }
    return messages;
  }

  function verifyReadback(expectedMessages, storedEvents) {
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
    for (const message of expectedMessages) {
      const id = String(message.id);
      if (expectedIds.has(id)) throw new Error("The export repeats a message identity. Review this chat before importing it.");
      expectedIds.add(id);
      const stored = storedById.get(id);
      if (!stored || stored.role !== message.role) {
        throw new Error("Sherry could not find every imported message when reading the chat back from the cloud.");
      }
    }
    return expectedIds.size;
  }

  global.SherryImportIntegrity = { verifyReceipt, verifyImportPlan, verifyReadback };
})(globalThis);
