import { useTranslation } from "react-i18next"

import styles from "./styles/chat.module.css"

/* Ctrl is Ctrl on macOS too: these are the terminal's keys, not VS Code's. */
const SHORTCUTS: [keys: string[], label: string][] = [
  [["Enter"], "shortcut-send"],
  [["Shift+Enter"], "shortcut-newline"],
  [["Enter"], "shortcut-approve"],
  [["Shift+Enter"], "shortcut-always"],
  [["Esc"], "shortcut-skip"],
  [["Esc"], "shortcut-stop"],
  [["Esc", "Esc"], "shortcut-clear"],
  [["Ctrl+C"], "shortcut-interrupt"],
  [["↑", "↓"], "shortcut-history"],
  [["PgUp", "PgDn"], "shortcut-scroll"],
  [["Ctrl+L"], "shortcut-new"],
  [["Tab"], "shortcut-accept-suggestion"],
  [["Shift+Tab"], "shortcut-agent"],
  [["@"], "shortcut-mention"],
  [["?"], "shortcut-help"]
]

/** The chat's keys, listed above the composer while "?" has it open. */
export const Shortcuts = () => {
  const { t } = useTranslation()

  return (
    <div className={styles.shortcuts} role="dialog" aria-label={t("shortcuts-title")}>
      <div className={styles.shortcutsHead}>
        <span>{t("shortcuts-title")}</span>
        <span className={styles.shortcutsClose}>{t("shortcuts-close")}</span>
      </div>
      <dl className={styles.shortcutsList}>
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} className={styles.shortcutsRow}>
            <dt>
              {keys.map((key, i) => (
                <kbd key={i}>{key}</kbd>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
