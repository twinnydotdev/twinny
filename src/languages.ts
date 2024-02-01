export type CodeLanguage =
  | 'bat'
  | 'c'
  | 'cpp'
  | 'css'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
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
  langName: string
  fileExtensions: string[]
  filenamePatterns?: string[]
  syntaxComments?: { start: string; end?: string }
  derivedFrom?: CodeLanguage
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
    syntaxComments: { start: '//' }
  },
  cpp: {
    langName: 'C++',
    fileExtensions: ['.cpp', '.h'],
    syntaxComments: { start: '//' }
  },
  css: {
    langName: 'CSS',
    fileExtensions: ['.css']
  },
  go: {
    langName: 'Go',
    fileExtensions: ['.go'],
    syntaxComments: { start: '//' }
  },
  html: {
    langName: 'HTML',
    fileExtensions: ['.htm', '.html'],
    syntaxComments: { start: '<!--', end: '-->' }
  },
  java: {
    langName: 'Java',
    fileExtensions: ['.java'],
    syntaxComments: { start: '//' }
  },
  javascript: {
    langName: 'Javascript',
    fileExtensions: ['.js', '.jsx', '.cjs'],
    syntaxComments: { start: '//' }
  },
  json: {
    langName: 'JSON',
    fileExtensions: ['.json', '.jsonl', '.geojson']
  },
  jsx: {
    langName: 'JSX',
    fileExtensions: ['.jsx'],
    syntaxComments: { start: '//' }
  },
  kotlin: {
    langName: 'Kotlin',
    fileExtensions: ['.kt', '.ktm', '.kts'],
    syntaxComments: { start: '//' }
  },
  'objective-c': {
    langName: 'Objective C',
    fileExtensions: ['.h', '.m', '.mm'],
    syntaxComments: { start: '//' }
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
    syntaxComments: { start: '//' }
  },
  python: {
    langName: 'Python',
    fileExtensions: ['.py'],
    syntaxComments: { start: '#' }
  },
  rust: {
    langName: 'Rust',
    fileExtensions: ['.rs', '.rs.in'],
    syntaxComments: { start: '//' }
  },
  sass: {
    langName: 'SASS',
    fileExtensions: ['.sass'],
    syntaxComments: { start: '//' }
  },
  scss: {
    langName: 'SCSS',
    fileExtensions: ['.scss'],
    syntaxComments: { start: '//' }
  },
  shellscript: {
    langName: 'Shell',
    fileExtensions: ['.bash', '.sh'],
    syntaxComments: { start: '#' }
  },
  swift: {
    langName: 'Swift',
    fileExtensions: ['.swift'],
    syntaxComments: { start: '//' }
  },
  typescript: {
    langName: 'Typescript',
    fileExtensions: ['.ts', '.cts', '.mts'],
    syntaxComments: { start: '//' }
  },
  typescriptreact: {
    langName: 'Typescript React',
    fileExtensions: ['.tsx'],
    syntaxComments: { start: '//' },
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
    syntaxComments: { start: '--' }
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
    syntaxComments: { start: '#' }
  },
  scala: {
    langName: 'Scala',
    fileExtensions: ['.scala'],
    syntaxComments: { start: '//' }
  },
  sql: {
    langName: 'SQL',
    fileExtensions: ['.sql'],
    syntaxComments: { start: '--' }
  },
  typescriptreactnative: {
    langName: 'Typescript React Native',
    fileExtensions: ['.tsx'],
    syntaxComments: { start: '//' },
    derivedFrom: 'typescript'
  },
  xaml: {
    langName: 'XAML',
    fileExtensions: ['.xaml'],
    syntaxComments: { start: '<!--', end: '-->' }
  }
}
