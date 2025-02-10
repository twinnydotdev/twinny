import React from "react";
import { createPatch } from "diff";

import styles from "./styles/diff.module.css";

interface Change {
  count?: number;
  added?: boolean;
  removed?: boolean;
  value: string;
}

interface DiffSummaryProps {
  diff: Change[];
  fileName?: string;
}

const DiffSummary = ({
  diff,
  fileName = "file",
}: DiffSummaryProps) => {
  // Generate unified diff (unidiff)
  const unidiff = createPatch(
    fileName,
    diff.filter((p: Change) => p.removed || !p.added).map((p: Change) => p.value).join(""),
    diff.filter((p: Change) => p.added || !p.removed).map((p: Change) => p.value).join(""),
    "Old",
    "New"
  );

  // Split unidiff output into lines
  const lines = unidiff.split("\n");

  const getLineClass = (line: string) => {
    if (line.startsWith("@@")) return styles.hunkHeader;
    if (line.startsWith("---") || line.startsWith("+++")) return styles.diffHeader;
    if (line.startsWith("+") && !line.startsWith("+++")) return styles.added;
    if (line.startsWith("-") && !line.startsWith("---")) return styles.removed;
    return "";
  };

  return (
    <div className={styles.container}>
      <pre className={styles.diffBlock}>
        {lines.map((line, index) => {
          const lineClass = getLineClass(line);
          return (
            <div key={index} className={lineClass}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
};

export default DiffSummary;
