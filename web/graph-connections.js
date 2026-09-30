(() => {
  "use strict";

  const STOP_WORDS = new Set([
    "about", "after", "again", "also", "been", "being", "between", "could", "does", "from", "have", "into", "just", "more", "most", "need", "only", "other", "over", "same", "should", "some", "than", "that", "their", "them", "there", "these", "this", "those", "through", "what", "when", "where", "which", "while", "with", "would", "your",
    "assistant", "chat", "chats", "chatgpt", "claude", "conversation", "conversations", "gemini", "google", "openai", "user", "users", "using", "summary", "summaries", "memory", "memories", "context", "help", "make", "making", "work", "working", "thing", "things", "question", "questions", "answer", "answers", "talk", "talking", "discussion", "discussing", "information", "details", "update", "updated"
  ]);

  function words(value) {
    return [...new Set(String(value || "").normalize("NFKD").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  }

  function normalizedPhrase(value) {
    return words(value).sort().join(" ");
  }

  function addTerms(target, text, weight, source) {
    for (const word of words(text)) {
      const previous = target.get(word);
      if (!previous || previous.weight < weight) target.set(word, { weight, source });
    }
  }

  function build(conversations, summaries = [], maxLinksPerChat = 3) {
    const summaryById = new Map();
    for (const summary of summaries) {
      const id = summary.conversation_id || summary.conversation?.id;
      if (id && !summaryById.has(id)) summaryById.set(id, summary);
    }
    const documents = conversations.map((conversation) => {
      const summary = summaryById.get(conversation.id);
      const title = new Set(words(conversation.title));
      const topics = new Map((summary?.topics || []).map((topic) => [normalizedPhrase(topic), String(topic).trim()]).filter(([key]) => key));
      const terms = new Map();
      addTerms(terms, summary?.summary_text, 1, "summary");
      for (const topic of summary?.topics || []) addTerms(terms, topic, 3, "topic");
      addTerms(terms, conversation.title, 3, "title");
      return { id: conversation.id, title, topics, terms };
    });
    const frequency = new Map();
    for (const document of documents) for (const term of document.terms.keys()) frequency.set(term, (frequency.get(term) || 0) + 1);
    const candidates = [];
    for (let i = 0; i < documents.length; i += 1) {
      for (let j = i + 1; j < documents.length; j += 1) {
        const left = documents[i];
        const right = documents[j];
        const sharedTopics = [...left.topics.keys()].filter((topic) => right.topics.has(topic));
        const overlap = [...left.terms.keys()].filter((term) => right.terms.has(term))
          .map((term) => ({
            term,
            strength: Math.min(left.terms.get(term).weight, right.terms.get(term).weight)
              * (1 + Math.log(1 + documents.length / (1 + frequency.get(term))))
          })).sort((a, b) => b.strength - a.strength);
        const distinctiveTitle = overlap.some(({ term }) => left.title.has(term) && right.title.has(term)
          && frequency.get(term) <= Math.max(3, documents.length * .45));
        const textEvidence = overlap.length >= 3 && overlap.slice(0, 3).reduce((sum, item) => sum + item.strength, 0) >= 6;
        if (!sharedTopics.length && !distinctiveTitle && !textEvidence) continue;
        const score = overlap.slice(0, 5).reduce((sum, item) => sum + item.strength, 0)
          + sharedTopics.length * 12 + (distinctiveTitle ? 5 : 0);
        const relationship = sharedTopics.length
          ? `Both summaries identify “${left.topics.get(sharedTopics[0])}”.`
            : distinctiveTitle
              ? `Both chat titles mention ${overlap.filter(({ term }) => left.title.has(term) && right.title.has(term)).slice(0, 2).map(({ term }) => term).join(" and ")}.`
              : `Their summaries share ${overlap.slice(0, 3).map(({ term }) => term).join(", ")}.`;
        candidates.push({ sourceId: left.id, targetId: right.id, score, relationship });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId));
    const degree = new Map();
    return candidates.filter((candidate) => {
      if ((degree.get(candidate.sourceId) || 0) >= maxLinksPerChat || (degree.get(candidate.targetId) || 0) >= maxLinksPerChat) return false;
      degree.set(candidate.sourceId, (degree.get(candidate.sourceId) || 0) + 1);
      degree.set(candidate.targetId, (degree.get(candidate.targetId) || 0) + 1);
      return true;
    });
  }

  globalThis.SherryGraphConnections = Object.freeze({ build });
})();
