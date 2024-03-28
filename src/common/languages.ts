// Derived with credit from https://github.com/ex3ndr/llama-coder/blob/main/src/prompts/processors/languages.ts
export type CodeLanguage =
  | 'bat'
  | 'c'
  | 'csharp'
  | 'cpp'
  | 'css'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'javascriptreact'
  | 'json'
  | 'jsx'
  | 'kotlin'
  | 'objective-c'
  | 'php'
  | 'python'
  | 'rust'
  | 'sass'
  | 'scss'
  | 'shellscript'
  | 'swift'
  | 'typescript'
  | 'typescriptreact'
  | 'xml'
  | 'yaml'
  | 'lua'
  | 'perl'
  | 'r'
  | 'ruby'
  | 'scala'
  | 'sql'
  | 'typescriptreactnative'
  | 'xaml'

export type CodeLanguageDetails = {
  fileExtensions: string[]
  filenamePatterns?: string[]
  syntaxComments: { start: string; end?: string }
  derivedFrom?: CodeLanguage
  langName?: string
}

export const supportedLanguages: {
  [key in CodeLanguage]: CodeLanguageDetails
} = {
  bat: {
    langName: 'BAT file',
    fileExtensions: ['.bat', '.cmd'],
    syntaxComments: { start: 'REM' }
  },
  c: {
    langName: 'C',
    fileExtensions: ['.c', '.h'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  csharp: {
    langName: 'C#',
    fileExtensions: ['.cs'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  cpp: {
    langName: 'C++',
    fileExtensions: ['.cpp', '.h'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  css: {
    langName: 'CSS',
    fileExtensions: ['.css'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  go: {
    langName: 'Go',
    fileExtensions: ['.go'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  html: {
    langName: 'HTML',
    fileExtensions: ['.htm', '.html'],
    syntaxComments: { start: '<!--', end: '-->' }
  },
  java: {
    langName: 'Java',
    fileExtensions: ['.java'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  javascript: {
    langName: 'Javascript',
    fileExtensions: ['.js', '.jsx', '.cjs'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  javascriptreact: {
    langName: 'Javascript JSX',
    fileExtensions: ['.jsx'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  json: {
    langName: 'JSON',
    fileExtensions: ['.json', '.jsonl', '.geojson'],
    syntaxComments: { start: '', end: ''}
  },
  jsx: {
    langName: 'JSX',
    fileExtensions: ['.jsx'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  kotlin: {
    langName: 'Kotlin',
    fileExtensions: ['.kt', '.ktm', '.kts'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  'objective-c': {
    langName: 'Objective C',
    fileExtensions: ['.h', '.m', '.mm'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  php: {
    langName: 'PHP',
    fileExtensions: [
      '.aw',
      '.ctp',
      '.fcgi',
      '.inc',
      '.php',
      '.php3',
      '.php4',
      '.php5',
      '.phps',
      '.phpt'
    ],
    syntaxComments: { start: '/*', end: '*/' }
  },
  python: {
    langName: 'Python',
    fileExtensions: ['.py'],
    syntaxComments: { start: '\'\'\'', end: '\'\'\'' }
  },
  rust: {
    langName: 'Rust',
    fileExtensions: ['.rs', '.rs.in'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  sass: {
    langName: 'SASS',
    fileExtensions: ['.sass'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  scss: {
    langName: 'SCSS',
    fileExtensions: ['.scss'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  shellscript: {
    langName: 'Shell',
    fileExtensions: ['.bash', '.sh'],
    syntaxComments: { start: '#' }
  },
  swift: {
    langName: 'Swift',
    fileExtensions: ['.swift'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  typescript: {
    langName: 'Typescript',
    fileExtensions: ['.ts', '.cts', '.mts'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  typescriptreact: {
    langName: 'Typescript React',
    fileExtensions: ['.tsx'],
    syntaxComments: { start: '/*', end: '*/' },
    derivedFrom: 'typescript'
  },
  xml: {
    langName: 'XML',
    fileExtensions: ['.xml'],
    syntaxComments: { start: '<!--', end: '-->' }
  },
  yaml: {
    langName: 'YAML',
    fileExtensions: ['.yml', '.yaml'],
    syntaxComments: { start: '#' }
  },
  lua: {
    langName: 'Lua',
    fileExtensions: ['.lua'],
    syntaxComments: { start: '--', end: '--[[ ]]--' }
  },
  perl: {
    langName: 'Perl',
    fileExtensions: ['.pl', '.pm'],
    syntaxComments: { start: '#' }
  },
  r: {
    langName: 'R',
    fileExtensions: ['.r', '.R'],
    syntaxComments: { start: '#' }
  },
  ruby: {
    langName: 'Ruby',
    fileExtensions: ['.rb'],
    syntaxComments: { start: '=begin', end: '=end' }
  },
  scala: {
    langName: 'Scala',
    fileExtensions: ['.scala'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  sql: {
    langName: 'SQL',
    fileExtensions: ['.sql'],
    syntaxComments: { start: '/*', end: '*/' }
  },
  typescriptreactnative: {
    langName: 'Typescript React Native',
    fileExtensions: ['.tsx'],
    syntaxComments: { start: '/*', end: '*/' },
    derivedFrom: 'typescript'
  },
  xaml: {
    langName: 'XAML',
    fileExtensions: ['.xaml'],
    syntaxComments: { start: '<!--', end: '-->' }
  }
}
