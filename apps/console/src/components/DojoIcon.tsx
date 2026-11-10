/** The same dojo gate used in the hosted console. */
export function DojoIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4q9 4 18 0M4 9h16M7 6v15M17 6v15M6 15h12M12 7v2" />
    </svg>
  );
}
