import { EVENT_NAME, WORKSPACE_STORAGE_KEY } from "../../common/constants"
import { emit, useServerState } from "../messaging"

export const useTemplates = () => {
  const { data: templates } = useServerState(EVENT_NAME.twinnyListTemplates)

  const saveTemplates = (selected: string[]) =>
    emit(EVENT_NAME.twinnySetWorkspaceContext, {
      key: WORKSPACE_STORAGE_KEY.selectedTemplates,
      value: selected
    })

  const editDefaultTemplates = () =>
    emit(EVENT_NAME.twinnyEditDefaultTemplates)

  return { templates, saveTemplates, editDefaultTemplates }
}
