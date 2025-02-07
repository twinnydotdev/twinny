import React from "react";
import { createPatch, diffLines } from "diff";

import styles from "./styles/diff.module.css";

interface DiffSummaryProps {
  oldValue: string;
  newValue: string;
  fileName?: string;
}

const DiffSummary = ({
  oldValue,
  newValue,
  fileName = "file",
}: DiffSummaryProps) => {
  // Calculate line differences summary
  const diff = diffLines(oldValue, newValue);
  let addedLines = 0;
  let removedLines = 0;

  diff.forEach((part) => {
    if (part.added) addedLines += part.count || 0;
    if (part.removed) removedLines += part.count || 0;
  });

  // Generate unified diff (unidiff)
  const unidiff = createPatch(fileName, oldValue, newValue, "Old", "New");

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
      <div className={styles.summary}>
        <span className={styles.addedColor}>+{addedLines}</span>{" "}
        <span className={styles.removedColor}>-{removedLines}</span>
      </div>
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
