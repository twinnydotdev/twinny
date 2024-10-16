import { VSCodeDropdown } from "@vscode/webview-ui-toolkit/react"

import { ApiModel } from "../common/types"

import { getModelShortName } from "./utils"

interface Props {
  model: string | undefined
  setModel: (model: string) => void
  models: ApiModel[] | undefined
}

export const ModelSelect = ({ model, models, setModel }: Props) => {
  const handleOnChange = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const selectedValue = event?.target.value || ""
    setModel(selectedValue)
  }

  return (
    <VSCodeDropdown onChange={handleOnChange} value={model}>
      {models?.map((model, index) => {
        return (
          <option value={model.name} key={`${index}`}>
            {getModelShortName(model.name)}
          </option>
        )
      })}
    </VSCodeDropdown>
  )
}
