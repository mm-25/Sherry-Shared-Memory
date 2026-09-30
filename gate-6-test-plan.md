# Gate 6 Controlled Live Test

This is the only remaining Gate 6 validation. It deliberately uses one small synthetic conversation so no sensitive existing chat needs to be sent to the chosen model provider.

## 1. Create a safe test conversation

In a normal ChatGPT conversation captured by the extension, send:

> For this memory-system test, remember three preferences: I prefer concise design feedback, I am currently working on a shared AI memory platform, and I prefer project updates as short bullet points. Repeat these back briefly.

Wait for the complete assistant response and confirm that the extension reports the conversation as captured.

## 2. Configure a test summarizer

In the Memory web app:

1. Open **Settings**.
2. Turn **Automatic summarization** off for the controlled test.
3. Choose the provider whose API key you want to use.
4. Enter a model name supported by that key.
5. Enter the API key and select **Save settings**.
6. Confirm the page shows only a masked key hint.

Saving transmits the key to the Memory Worker, which encrypts it before database storage. The next step sends only the selected conversation slice to the chosen model provider and may consume a small amount of API credit.

## 3. Generate and inspect the first summary

1. Open **Conversations**, choose the synthetic test conversation, and select **Summarize this conversation**. This targets only that chat and leaves existing conversations untouched.
2. Open **Summaries**.
3. Open the new summary and verify:
   - it is understandable and factually matches the conversation;
   - the exact source messages are shown;
   - the original-chat link opens the source chat;
   - model and token information appears;
   - proposed memories are counted.

## 4. Test summary versioning

1. Add `Edited during the Gate 6 test.` to the summary text.
2. Select **Save edited version**.
3. Reopen the summary.
4. Confirm it is now Version 2 and Version 1 appears as superseded in the history.

## 5. Test memory review

1. Open **Memory**.
2. Mark one proposed memory **Yes, correct**.
3. Mark a second **No, incorrect**.
4. Mark a third **Not sure**.
5. Confirm their status badges change and the page remains usable after refresh.

## 6. Test a conflict

In the same source chat, send:

> Correction for the memory-system test: I now prefer detailed design feedback instead of concise design feedback. Treat this as the newer preference.

Wait for capture, reopen that conversation in **Conversations**, and select **Summarize this conversation** again. In **Memory**, verify that a conflict appears comparing the earlier and newer preferences. Test one resolution option, preferably **Keep newer**.

## 7. Test summary deletion last

1. Open the latest summary.
2. Select **Delete summary** and confirm.
3. Verify the summary disappears but the original conversation remains under **Conversations**.
4. Verify related memory claims remain available for independent review.

## What to report

Report any step where the visible result differs, plus the exact on-screen error. Do not send the API key. Leave the source test conversation and the app open so the stored diagnostics can be inspected.
