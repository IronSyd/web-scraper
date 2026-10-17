import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/** @param {{walking?:boolean}} props */
export function BeeMark({ walking = false }) {
  return (
    <svg
      className={`brand-bee${walking ? " is-walking" : ""}`}
      width="36"
      height="36"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g
        className="bee-walk"
        stroke="#242623"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g className="bee-leg-back">
          <path d="m17 32-3 7h-4m13-6-1 7h-4" />
        </g>
        <g className="bee-leg-front">
          <path d="m28 32 3 7h4" />
        </g>
        <path d="M24 20c-9-1-11-9-6-11 6-2 10 7 6 11Z" fill="#FFFDF4" />
        <path d="M25 19c1-9 9-12 11-7 2 5-5 10-11 7Z" fill="#FFFDF4" />
        <path d="m10 25-5-2 4 6" fill="#242623" />
        <path
          d="M34 25c0 6-6 11-13 10-7 0-12-5-12-10s6-8 13-8 12 3 12 8Z"
          fill="#F3C64E"
        />
        <path d="M17 18c-3 5-3 11 0 16m8-16c-3 5-3 12 0 16" strokeWidth="4" />
        <path d="m36 17 2-7 4-1m-9 8-1-6" />
        <circle cx="36" cy="24" r="7" fill="#242623" />
        <circle cx="38" cy="22" r="1.2" fill="#FFFDF4" stroke="none" />
      </g>
    </svg>
  );
}

/** @param {{onNavigate?:()=>void}} props */
export default function Brand({ onNavigate }) {
  const [walking, setWalking] = useState(true);
  useEffect(() => {
    if (!walking) return;
    const timer = setTimeout(() => setWalking(false), 700);
    return () => clearTimeout(timer);
  }, [walking]);
  return (
    <Link
      className="brand-link"
      to="/"
      aria-label="Webby"
      onClick={onNavigate}
      onMouseEnter={() => setWalking(true)}
      onFocus={() => setWalking(true)}
    >
      <span className="brand-symbol">
        <BeeMark walking={walking} />
      </span>
      <span className="brand-copy">
        <span className="brand-name">Webby</span>
        <span className="brand-description">Web scraper</span>
      </span>
    </Link>
  );
}
