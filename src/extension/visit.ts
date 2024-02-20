import ts from 'typescript'

export function findFunctionDeclarations(fileContents: string) {
  // Create a SourceFile object
  const sourceFile = ts.createSourceFile(
    'file.ts', // A name for the file (does not need to exist on disk)
    fileContents,
    ts.ScriptTarget.Latest, // Parse using the latest script target
    true // Set parent pointers
  )

  // Visit each node in the syntax tree
  function visit(node: ts.Node) {
    // Check if the node is an interface declaration and exported
    if (
      ts.isInterfaceDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      console.log('Exported interface:', node.name.text)
    }
    // Check if the node is a type alias declaration and exported
    else if (
      ts.isTypeAliasDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      console.log('Exported type:', node.name.text)
    }

    // Check if the node is a function declaration and exported
    else if (
      ts.isFunctionLike(node)
    ) {
      console.log('Exported function:', node.name)
    }

    // Continue searching through child nodes
    ts.forEachChild(node, visit)
  }

  // Start walking through the tree from the root
  visit(sourceFile)
}
