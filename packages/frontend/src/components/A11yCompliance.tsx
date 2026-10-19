'use client';

export default function A11yCompliance() {
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      Accessibility compliance marker
    </div>
  );
}