(() => {
  "use strict";

  function messageTime(event) {
    return event?.message_timestamp || event?.first_captured_at || event?.captured_at || null;
  }

  function sort(events, direction = "latest") {
    const latestFirst = direction !== "oldest";
    const entries = events.map((event, index) => ({ event, index, time: Date.parse(messageTime(event) || ""), sequence: Number(event?.sequence) }));
    const hasStableSequence = entries.every(({ event, sequence }) => event?.sequence != null && Number.isInteger(sequence) && sequence >= 0)
      && new Set(entries.map(({ sequence }) => sequence)).size === entries.length;
    return entries
      .sort((a, b) => {
        // A provider's transcript position is the turn order. Capture time is not:
        // a user turn without a source timestamp may be observed seconds after a
        // newer assistant turn whose source timestamp was available.
        if (hasStableSequence) return (latestFirst ? b.sequence - a.sequence : a.sequence - b.sequence) || a.index - b.index;
        const aHasTime = Number.isFinite(a.time);
        const bHasTime = Number.isFinite(b.time);
        if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
        if (aHasTime && a.time !== b.time) return latestFirst ? b.time - a.time : a.time - b.time;
        return latestFirst ? b.index - a.index : a.index - b.index;
      })
      .map(({ event }) => event);
  }

  globalThis.SherryTranscriptOrder = Object.freeze({ messageTime, sort });
})();
