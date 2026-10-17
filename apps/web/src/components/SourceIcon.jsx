/** @param {{name:string,size?:number}} props */
export default function SourceIcon({ name, size = 20 }) {
  const paths = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    amazon: (
      <>
        <path d="M12 5.5C9 3.7 6 3.5 3 4v15c3-.5 6-.3 9 1.5 3-1.8 6-2 9-1.5V4c-3-.5-6-.3-9 1.5Z" />
        <path d="M12 5.5v15" />
      </>
    ),
    booking: (
      <>
        <path d="M3 20V7m18 13V9M3 16h18M7 10h11a3 3 0 0 1 3 3v3H3v-3a3 3 0 0 1 4-3Z" />
        <path d="M7 10V7h5v3" />
      </>
    ),
    indeed: (
      <>
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M8 7V4h8v3M3 12l9 3 9-3m-9 1v4" />
      </>
    ),
    tiobe: (
      <>
        <path d="M4 20h16" />
        <rect x="5" y="12" width="3" height="8" rx=".5" />
        <rect x="10.5" y="4" width="3" height="16" rx=".5" />
        <rect x="16" y="8" width="3" height="12" rx=".5" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7M4 12h12" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      className="source-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[/** @type {keyof typeof paths} */ (name)] ?? paths.overview}
    </svg>
  );
}
