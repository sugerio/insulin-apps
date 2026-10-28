/** The app's mark: three bars of a breakdown, in the theme's primary colour. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect x="8" y="9" width="16" height="3.2" rx="1.6" fill="#fff" />
      <rect x="8" y="14.4" width="11" height="3.2" rx="1.6" fill="#fff" opacity=".82" />
      <rect x="8" y="19.8" width="6" height="3.2" rx="1.6" fill="#fff" opacity=".64" />
    </svg>
  );
}
