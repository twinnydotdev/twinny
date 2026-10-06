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
  wantsModelSuggestion
} from "../../common/composer-predict"

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

test("after a space the word that usually comes next is guessed", () => {
  const model = buildWordModel(["run the tests please", "run the tests again", "run the build"])
  assert.strictEqual(predictWord("now run ", model), "the")
  assert.strictEqual(predictWord("now run the ", model), "tests")
  assert.strictEqual(predictWord("now the build ", model), "", "seen once is not enough")
  assert.strictEqual(predictWord("done. ", model), "")
})

test("code blocks and sentence ends do not teach the predictor", () => {
  const model = buildWordModel(["```\nzzzlongident zzzlongident\n```", "fix it. then fix it. then go"])
  assert.strictEqual(predictWord("zzz", model), "")
  assert.strictEqual(predictWord("fix it ", model), "", "\"it. then\" crosses a sentence")
})

test("the model is asked after a word, not in the middle of one", () => {
  assert.strictEqual(wantsModelSuggestion("can you "), true)
  assert.strictEqual(wantsModelSuggestion("first,"), true)
  assert.strictEqual(wantsModelSuggestion("can you expl"), false)
  assert.strictEqual(wantsModelSuggestion("a "), false)
})

test("a model's guess loses the draft said again, quotes and other lines", () => {
  assert.strictEqual(cleanModelSuggestion("can you ", "explain the error?\nThanks"), "explain the error?")
  assert.strictEqual(cleanModelSuggestion("can you", "\"explain it\""), " explain it")
  assert.strictEqual(cleanModelSuggestion("can you ", "Can you explain it"), "explain it")
  assert.strictEqual(cleanModelSuggestion("now please fix the ", "fix the tests too."), "tests too.")
  assert.strictEqual(cleanModelSuggestion("thanks, and what if ", "if I want to reconnect?"), "I want to reconnect?")
  assert.strictEqual(cleanModelSuggestion("can you ", "Continuation: add tests. Then run"), "add tests.")
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
  assert.deepStrictEqual(messages.slice(1, -1).map((m) => m.role), ["user", "assistant", "user", "assistant"])
  const last = messages[messages.length - 1]
  assert.strictEqual(last.role, "user")
  assert.match(last.content, /User: how do I close a socket\?\n\nAssistant: Call ws.close\(\):\n\[code\]/)
  assert.match(last.content, /<draft>does that <\/draft>/)
  assert.match(composerSuggestionMessages("hi ", [])[5].content, /\(none\)/)
})
