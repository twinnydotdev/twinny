export const EnabledAutoScrollIcon = () => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 8v8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M8 12l4 4 4-4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const DisabledAutoScrollIcon = () => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 8v8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M8 12l4 4 4-4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6 6l12 12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)

export const RAGIcon = ({ enabled }: { enabled: boolean }) => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M4 5C4 3.89543 5.79086 3 8 3C10.2091 3 12 3.89543 12 5M4 5C4 6.10457 5.79086 7 8 7C10.2091 7 12 6.10457 12 5M4 5V19C4 20.1046 5.79086 21 8 21C10.2091 21 12 20.1046 12 19V5"
      stroke={enabled ? 'currentColor' : '#888888'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M16 12H20M20 12L17 9M20 12L17 15"
      stroke={enabled ? 'currentColor' : '#888888'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 5H20M14 9H20M14 13H15M14 17H20"
      stroke={enabled ? 'currentColor' : '#888888'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle
      cx="19"
      cy="19"
      r="3"
      fill={enabled ? 'currentColor' : 'none'}
      stroke={enabled ? 'currentColor' : '#888888'}
      strokeWidth="2"
    />
  </svg>
)

export const EnabledRAGIcon = () => <RAGIcon enabled />
export const DisabledRAGIcon = () => <RAGIcon enabled={false} />
