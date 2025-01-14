import { useTranslation } from "react-i18next"
import { VSCodeDropdown } from "@vscode/webview-ui-toolkit/react"

import { ApiModel } from "../common/types"

import { getModelShortName } from "./utils"

interface Props {
  model: string | undefined
  setModel: (model: string) => void
  models: ApiModel[] | undefined
}

export const ModelSelect = ({ model, models, setModel }: Props) => {
  const { t } = useTranslation()
  const handleOnChange = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const selectedValue = event?.target.value
    if (!selectedValue) return
    setModel(selectedValue)
  }

  const selectedModel =
    model || (models && models.length > 0 ? models[0].name : "")

  return (
    <VSCodeDropdown onChange={handleOnChange} value={selectedModel}>
      {models && models.length > 0 ? (
        models.map((model, index) => {
          return (
            <option value={model.name} key={`${index}`}>
              {getModelShortName(model.name)}
            </option>
          )
        })
      ) : (
        <option value="" disabled>
          {t("no-models-available")}
        </option>
      )}
    </VSCodeDropdown>
  )
}
