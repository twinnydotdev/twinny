/** Small string helpers shared by the extension host and the webview. */

export const kebabToSentence = (kebab: string) => {
  if (!kebab) return ""
  const words = kebab.split("-")
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)
  return words.join(" ")
}

export const getLineBreakCount = (text: string) => text.split("\n").length
