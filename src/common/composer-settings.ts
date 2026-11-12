/**
 * What the composer's own settings sheet holds: where the grey suggestions
 * come from, which model writes the sentence ones, and the size of the
 * text typed. Kept as one global value, so every window agrees and a
 * change shows at once. Plain data and functions, no editor in sight.
 */

/** Where suggestions come from: typed words, the model's sentences, both or neither. */
export type SuggestionSource = "off" | "words" | "sentences" | "both"

/** A provider from the user's list, and the model of it to ask. */
export interface SuggestionModelChoice {
  providerId: string
  modelName: string
}

export interface ComposerSettings {
  /** Unset until chosen: then `twinny.chatSuggestions` decides between both and off. */
  suggest?: SuggestionSource
  /** Unset for the chat model. */
  model?: SuggestionModelChoice
  /** Pixels; unset for the sidebar's own size. */
  fontSize?: number
}

export const COMPOSER_FONT_SIZES = [12, 13, 14, 15, 16]
export const DEFAULT_COMPOSER_FONT_SIZE = 13

/** The source in force: the sheet's choice, else what the old on/off setting says. */
export const suggestionSourceOf = (
  settings: ComposerSettings | undefined,
  legacyEnabled: boolean
): SuggestionSource => settings?.suggest ?? (legacyEnabled ? "both" : "off")

/** What the composer's settings sheet says about the last time a model was asked. */
export interface SuggestionStatus {
  asking: boolean
  last?: { model?: string; ms?: number; result: "shown" | "nothing" | "failed"; error?: string }
}

export const suggestsWords = (source: SuggestionSource) => source === "words" || source === "both"
export const suggestsSentences = (source: SuggestionSource) => source === "sentences" || source === "both"

/** A size the composer can be set in, or undefined for the sidebar's own. */
export const composerFontSizeOf = (settings: ComposerSettings | undefined): number | undefined => {
  const size = settings?.fontSize
  return typeof size === "number" && size >= 10 && size <= 24 && size !== DEFAULT_COMPOSER_FONT_SIZE
    ? size
    : undefined
}

interface ProviderLike {
  id: string
  type: string
  modelName: string
}

/**
 * The provider that writes sentence suggestions: the one chosen, with the
 * model chosen for it, while it is still in the list as a chat provider;
 * otherwise the chat provider, as before there was a choice.
 */
export const suggestionProviderFor = <T extends ProviderLike>(
  chat: T | undefined,
  providers: Record<string, T> | undefined,
  choice: SuggestionModelChoice | undefined
): T | undefined => {
  const chosen = choice ? providers?.[choice.providerId] : undefined
  if (!choice || !chosen || chosen.type !== "chat") return chat
  const modelName = choice.modelName || chosen.modelName
  return modelName ? { ...chosen, modelName } : chat
}
