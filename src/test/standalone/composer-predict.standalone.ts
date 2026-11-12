/**
 * The composer's grey text: the keyboard-style word predictor and the
 * clean-up of a model's guess at the rest of the message.
 */
import * as assert from "node:assert"
import { test } from "node:test"

import {
  buildWordModel,
  cleanModelSuggestion,
  composerSuggestionMessages,
  predictWord,
  suggestionDraft,
  wantsModelSuggestion
} from "../../common/composer-predict"
import { composerFontSizeOf, suggestionProviderFor, suggestionSourceOf } from "../../common/composer-settings"

test("a partial word is finished from the seed words before anything is typed", () => {
  const model = buildWordModel([])
  assert.strictEqual(predictWord("can you expl", model), "ain")
  assert.strictEqual(predictWord("can you e", model), "", "one letter is too open")
  assert.strictEqual(predictWord("", model), "")
})

test("words the user has typed win over the seed words", () => {
  const model = buildWordModel(["refresh the ProviderSelect dropdown", "the ProviderSelect again"])
  assert.strictEqual(predictWord("fix the prov", model), "iderSelect")
  assert.strictEqual(predictWord("fix the PROV", model), "IDERSELECT")
})

test("a typed word likelier than any longer one is left alone", () => {
  const model = buildWordModel(["the cat", "the dog", "the end", "there it is"])
  assert.strictEqual(predictWord("look at the", model), "")
})

test("a word not yet begun is never guessed, but one that followed the last is likelier", () => {
  const model = buildWordModel(["run the tests please", "run the tests again", "run the build"])
  assert.strictEqual(predictWord("now run ", model), "")
  assert.strictEqual(predictWord("now run the ", model), "")
  assert.strictEqual(predictWord("now run the te", model), "sts")
})

test("code blocks and sentence ends do not teach the predictor", () => {
  const model = buildWordModel(["```\nzzzlongident zzzlongident\n```", "fix it. then fix it. then go"])
  assert.strictEqual(predictWord("zzz", model), "")
  assert.strictEqual(predictWord("fix it ", model), "", "\"it. then\" crosses a sentence")
})

test("the model is asked once a message has begun, until a sentence ends", () => {
  assert.strictEqual(wantsModelSuggestion("can you "), true)
  assert.strictEqual(wantsModelSuggestion("first,"), true)
  assert.strictEqual(wantsModelSuggestion("can you expl"), true, "a word half typed asks too")
  assert.strictEqual(wantsModelSuggestion("a "), false)
  assert.strictEqual(wantsModelSuggestion("that works. "), false, "a finished sentence does not")
  assert.strictEqual(wantsModelSuggestion("why?"), false)
})

test("a model's guess loses the draft said again, quotes and other lines", () => {
  assert.strictEqual(cleanModelSuggestion("can you ", "can you explain the error?\nThanks"), "explain the error?")
  assert.strictEqual(cleanModelSuggestion("can you ", "explain the error?"), "explain the error?", "only the rest")
  assert.strictEqual(cleanModelSuggestion("can you", "\"can you explain it\""), " explain it")
  assert.strictEqual(cleanModelSuggestion("can you ", "Can you explain it"), "explain it")
  assert.strictEqual(cleanModelSuggestion("can you ", "can your tests run"), "", "not the draft again, nor its rest")
  assert.strictEqual(cleanModelSuggestion("now please fix the ", "fix the tests too."), "tests too.")
  assert.strictEqual(cleanModelSuggestion("thanks, and what if ", "if I want to reconnect?"), "I want to reconnect?")
  assert.strictEqual(cleanModelSuggestion("can you ", "Continuation: add tests. Then run"), "add tests.")
  assert.strictEqual(cleanModelSuggestion("first line\nthen can you ", "then can you run it"), "run it", "the last line only")
})

test("a reply instead of a continuation, or nothing, is no guess", () => {
  assert.strictEqual(cleanModelSuggestion("can you ", "Sure, here is the code"), "")
  assert.strictEqual(cleanModelSuggestion("can you ", "I can help with that"), "")
  assert.strictEqual(cleanModelSuggestion("can you ", "   "), "")
  assert.strictEqual(cleanModelSuggestion("can you ", "..."), "")
})

test("a long guess stops at a word near the cap", () => {
  const long = "word ".repeat(40)
  const cleaned = cleanModelSuggestion("tell me ", long)
  assert.ok(cleaned.length <= 80)
  assert.match(cleaned, /word$/)
})

test("quotes are stripped only when they wrap the whole guess", () => {
  assert.strictEqual(cleanModelSuggestion("why is it failing, ", "it says \"cannot find module\""), "it says \"cannot find module\"")
  assert.strictEqual(cleanModelSuggestion("is it better to use ", "`useEffect` hooks?"), "`useEffect` hooks?")
  assert.strictEqual(cleanModelSuggestion("can you ", "'explain it'"), "explain it")
})

test("an answer in the assistant's voice is no guess", () => {
  assert.strictEqual(cleanModelSuggestion("how do I ", "You can use flexbox"), "")
  assert.strictEqual(cleanModelSuggestion("why is my build failing, ", "it's because of a missing dependency"), "")
})

test("the model is told it predicts, shown examples, then the draft with the conversation", () => {
  const messages = composerSuggestionMessages("does that ", [
    { role: "user", content: "how do I close a socket?" },
    { role: "assistant", content: "Call ws.close():\n```js\nws.close()\n```" }
  ])
  assert.strictEqual(messages[0].role, "system")
  assert.match(messages[0].content, /never answer/)
  assert.deepStrictEqual(messages.slice(1, -1).map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"])
  const last = messages[messages.length - 1]
  assert.strictEqual(last.role, "user")
  assert.match(last.content, /User: how do I close a socket\?\n\nAssistant: Call ws.close\(\):\n\[code\]/)
  assert.match(last.content, /<draft>does that <\/draft>/)
  assert.match(composerSuggestionMessages("hi ", [])[7].content, /\(none\)/)
})

test("the old on/off setting decides the source until one is chosen", () => {
  assert.strictEqual(suggestionSourceOf(undefined, true), "both")
  assert.strictEqual(suggestionSourceOf({}, false), "off")
  assert.strictEqual(suggestionSourceOf({ suggest: "sentences" }, false), "sentences")
  assert.strictEqual(suggestionSourceOf({ suggest: "off" }, true), "off")
})

test("sentence suggestions use the chosen provider and model, else the chat provider", () => {
  const chat = { id: "a", type: "chat", modelName: "big" }
  const providers = {
    a: chat,
    b: { id: "b", type: "chat", modelName: "medium" },
    f: { id: "f", type: "fim", modelName: "codellama" }
  }
  assert.strictEqual(suggestionProviderFor(chat, providers, undefined), chat)
  assert.deepStrictEqual(suggestionProviderFor(chat, providers, { providerId: "b", modelName: "small" }), {
    id: "b",
    type: "chat",
    modelName: "small"
  })
  assert.strictEqual(suggestionProviderFor(chat, providers, { providerId: "b", modelName: "" })?.modelName, "medium")
  assert.strictEqual(suggestionProviderFor(chat, providers, { providerId: "gone", modelName: "x" }), chat, "removed")
  assert.strictEqual(suggestionProviderFor(chat, providers, { providerId: "f", modelName: "x" }), chat, "not a chat provider")
  assert.strictEqual(suggestionProviderFor(chat, undefined, { providerId: "b", modelName: "x" }), chat)
})

test("the composer's text size is only set when it differs from the sidebar's", () => {
  assert.strictEqual(composerFontSizeOf(undefined), undefined)
  assert.strictEqual(composerFontSizeOf({ fontSize: 13 }), undefined)
  assert.strictEqual(composerFontSizeOf({ fontSize: 16 }), 16)
  assert.strictEqual(composerFontSizeOf({ fontSize: 400 }), undefined)
})

test("a guess joins a half-typed word by how it said the draft again", () => {
  assert.strictEqual(cleanModelSuggestion("how do I cen", "how do I center a div?"), "ter a div?")
  assert.strictEqual(cleanModelSuggestion("fix the bug in", "fix the bug in my React component"), " my React component")
  assert.strictEqual(cleanModelSuggestion("fix the bug in", "in my React component"), " my React component", "from the last word")
  assert.strictEqual(cleanModelSuggestion("how do I cen", "do I center a div?"), "ter a div?", "from the last few words")
  assert.strictEqual(cleanModelSuggestion("how do I cen", "tralize my code?"), "", "word or next word? no telling")
  assert.strictEqual(cleanModelSuggestion("does it work", "does it work"), "", "nothing beyond the draft")
  assert.strictEqual(cleanModelSuggestion("first,", "first, run the tests"), " run the tests")
})

test("a long draft is finished from its end", () => {
  const long = `${"word ".repeat(80)}and then can you`
  const shown = suggestionDraft(long)
  assert.ok(shown.length <= 240 && shown.endsWith("and then can you") && shown.startsWith("word "))
  assert.strictEqual(cleanModelSuggestion(long, `${shown} run it`), " run it")
  assert.strictEqual(suggestionDraft("one\ntwo thr"), "two thr")
})

test("a draft said again with its typos mended is still only finished, never doubled", () => {
  const draft = "Can you find a problem witht his codebase"
  const said = "Can you find a problem with this codebase and suggest a fix?"
  assert.strictEqual(cleanModelSuggestion(draft, said), " and suggest a fix?")
  assert.strictEqual(cleanModelSuggestion(`${draft} `, said), "and suggest a fix?")
  assert.strictEqual(cleanModelSuggestion("fix teh bug in teh cod", "fix the bug in the code?"), "e?")
  assert.strictEqual(cleanModelSuggestion("Can you chekc teh ", "Can you check the tests?"), "", "nothing to place it by")
  assert.strictEqual(cleanModelSuggestion("show me the diff for the ", "show me the diff for the the parser"), "the parser")
  assert.strictEqual(cleanModelSuggestion("what about this ", "what about his tests"), "")
})
