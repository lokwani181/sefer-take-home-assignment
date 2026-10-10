import type { ApiError } from '@app/shared';

interface ErrorBannerProps {
  error: ApiError;
  title?: string;
  onDismiss?: () => void;
}

/** Shows a server ApiError with its detail and, when present, the actionable hint. */
export function ErrorBanner({ error, title, onDismiss }: ErrorBannerProps) {
  return (
    <div className="banner banner-error" role="alert">
      <div className="banner-body">
        <p className="banner-title">
          {title ? `${title}: ` : ''}
          {error.error}
        </p>
        {error.detail && <p className="banner-detail">{error.detail}</p>}
        {error.hint && (
          <p className="banner-hint">
            <strong>How to fix:</strong> {error.hint}
          </p>
        )}
      </div>
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onDismiss} aria-label="Dismiss error">
          ✕
        </button>
      )}
    </div>
  );
}
