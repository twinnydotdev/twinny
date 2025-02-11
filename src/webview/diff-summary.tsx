import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Change, createPatch } from "diff";

interface DiffSummaryProps {
  diff: Change[];
  fileName?: string;
}

const DiffSummary = ({ diff, fileName = "file" }: DiffSummaryProps) => {
  // Generate unified diff
  const unidiff = createPatch(
    fileName,
    diff.filter(p => p.removed || !p.added).map(p => p.value).join("") + "\n",
    diff.filter(p => p.added || !p.removed).map(p => p.value).join("") + "\n",
    "Old",
    "New"
  );

  // Split into lines and remove the "No newline" message
  const lines = unidiff.split("\n").filter(line => !line.includes("No newline at end of file"));

  const getLineStyle = (line: string) => {
    const baseStyle = { display: "block", width: "100%" };

    if (line.startsWith("@@")) {
      return { ...baseStyle, backgroundColor: "#1C1C1C" };
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      return { ...baseStyle, backgroundColor: "#1C1C1C" };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return { ...baseStyle, backgroundColor: "#1E3217" };
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return { ...baseStyle, backgroundColor: "#3C1F1F" };
    }
    return baseStyle;
  };

  return (
    <div>
      <SyntaxHighlighter
        language="typescript"
        style={vscDarkPlus}
        wrapLines
        showLineNumbers
        lineNumberStyle={{ display: "none" }}
        lineProps={lineNumber => ({
          style: getLineStyle(lines[lineNumber - 1])
        })}
      >
        {lines.join("\n")}
      </SyntaxHighlighter>
    </div>
  );
};

export default DiffSummary;
