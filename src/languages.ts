export type Language =
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

export type LanguageType = {
  name: string
  extensions: string[]
  filenames?: string[]
  comment?: { start: string; end?: string }
}

export const languages: { [key in Language]: LanguageType } = {
  typescript: {
    name: 'Typescript',
    extensions: ['.ts', '.cts', '.mts'],
    comment: { start: '//' }
  },
  typescriptreact: {
    name: 'Typescript React',
    extensions: ['.tsx'],
    comment: { start: '//' }
  },
  javascript: {
    name: 'Javascript',
    extensions: ['.js', '.jsx', '.cjs'],
    comment: { start: '//' }
  },
  jsx: {
    name: 'JSX',
    extensions: ['.jsx'],
    comment: { start: '//' }
  },
  html: {
    name: 'HTML',
    extensions: ['.htm', '.html'],
    comment: { start: '<!--', end: '-->' }
  },
  css: {
    name: 'CSS',
    extensions: ['.css']
  },
  sass: {
    name: 'SASS',
    extensions: ['.sass'],
    comment: { start: '//' }
  },
  scss: {
    name: 'SCSS',
    extensions: ['.scss'],
    comment: { start: '//' }
  },
  json: {
    name: 'JSON',
    extensions: ['.json', '.jsonl', '.geojson']
  },
  yaml: {
    name: 'YAML',
    extensions: ['.yml', '.yaml'],
    comment: { start: '#' }
  },
  xml: {
    name: 'XML',
    extensions: ['.xml'],
    comment: { start: '<!--', end: '-->' }
  },
  java: {
    name: 'Java',
    extensions: ['.java'],
    comment: { start: '//' }
  },
  kotlin: {
    name: 'Kotlin',
    extensions: ['.kt', '.ktm', '.kts'],
    comment: { start: '//' }
  },
  swift: {
    name: 'Swift',
    extensions: ['.swift'],
    comment: { start: '//' }
  },
  'objective-c': {
    name: 'Objective C',
    extensions: ['.h', '.m', '.mm'],
    comment: { start: '//' }
  },
  rust: {
    name: 'Rust',
    extensions: ['.rs', '.rs.in'],
    comment: { start: '//' }
  },
  python: {
    name: 'Python',
    extensions: ['.py'],
    comment: { start: '#' }
  },
  c: {
    name: 'C',
    extensions: ['.c', '.h'],
    comment: { start: '//' }
  },
  cpp: {
    name: 'C++',
    extensions: ['.cpp', '.h'],
    comment: { start: '//' }
  },
  go: {
    name: 'Go',
    extensions: ['.go'],
    comment: { start: '//' }
  },
  php: {
    name: 'PHP',
    extensions: [
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
    comment: { start: '//' }
  },
  bat: {
    name: 'BAT file',
    extensions: ['.bat', '.cmd'],
    comment: { start: 'REM' }
  },
  shellscript: {
    name: 'Shell',
    extensions: ['.bash', '.sh'],
    comment: { start: '#' }
  }
}
