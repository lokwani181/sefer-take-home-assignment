import { useRef, useState, type DragEvent } from 'react';
import type { ApiError } from '@app/shared';
import { MAX_FILES } from '../api/client';
import { useElapsedSeconds } from '../hooks/useElapsedSeconds';
import { formatBytes } from '../lib/format';
import { ACCEPT_ATTRIBUTE, fileKey, fileKind, mergeFiles } from '../lib/upload-files';
import { ErrorBanner } from './ErrorBanner';

interface UploadPanelProps {
  files: File[];
  onFilesChange(files: File[]): void;
  onGenerate(): void;
  /** Set while a createShipment request is in flight. */
  startedAt: number | null;
  error: ApiError | null;
  onDismissError(): void;
  hasResult: boolean;
}

/** Drag-and-drop / picker for shipment documents, the selected-file list, and the long-running upload state. */
export function UploadPanel({ files, onFilesChange, onGenerate, startedAt, error, onDismissError, hasResult }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const elapsed = useElapsedSeconds(startedAt);
  const busy = startedAt !== null;
  // Once results are on screen, shrink to one line so the entry gets the space.
  const collapsed = hasResult && !expanded && !busy && !error;

  const generate = () => {
    setExpanded(false);
    onGenerate();
  };

  const add = (incoming: File[]) => {
    const merged = mergeFiles(files, incoming);
    onFilesChange(merged.files);
    setRejected(merged.rejected);
  };

  const remove = (file: File) => {
    onFilesChange(files.filter((f) => fileKey(f) !== fileKey(file)));
    setRejected([]);
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!busy) add(Array.from(e.dataTransfer?.files ?? []));
  };

  if (collapsed) {
    return (
      <section className="panel upload-panel is-collapsed" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Documents</h2>
        <ul className="doc-chips" aria-label="Processed files">
          {files.map((file) => (
            <li key={fileKey(file)} className="chip" title={file.name}>
              {file.name}
            </li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={() => setExpanded(true)}>
          Change documents
        </button>
      </section>
    );
  }

  return (
    <section className="panel upload-panel" aria-labelledby="upload-heading">
      <div className="panel-head">
        <h2 id="upload-heading">{hasResult ? 'Documents' : 'Upload shipment documents'}</h2>
        <p className="muted">
          Commercial invoice, packing list, bill of lading or air waybill. PDF, PNG, JPG or TIFF; up to {MAX_FILES} files.
        </p>
      </div>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${files.length ? ' is-compact' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <span className="dropzone-icon" aria-hidden="true">
          ⇪
        </span>
        <p className="dropzone-text">
          Drag and drop files here, or{' '}
          <button type="button" className="btn-link" onClick={() => inputRef.current?.click()} disabled={busy}>
            choose files
          </button>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          aria-label="Choose shipment documents"
          tabIndex={-1}
          disabled={busy}
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {rejected.length > 0 && (
        <ul className="inline-errors" aria-live="polite">
          {rejected.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="file-list" aria-label="Selected files">
          {files.map((file) => (
            <li key={fileKey(file)} className="file-row">
              <span className={`file-kind file-kind-${fileKind(file).toLowerCase()}`}>{fileKind(file)}</span>
              <span className="file-name" title={file.name}>
                {file.name}
              </span>
              <span className="file-size">{formatBytes(file.size)}</span>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => remove(file)} disabled={busy} aria-label={`Remove ${file.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="upload-actions">
        <button type="button" className="btn btn-primary" onClick={generate} disabled={busy || files.length === 0}>
          {busy ? 'Generating…' : hasResult ? 'Generate new entry' : 'Generate entry'}
        </button>
        {files.length > 0 && !busy && (
          <span className="muted">
            {files.length} file{files.length === 1 ? '' : 's'} selected
          </span>
        )}
      </div>

      {busy && (
        <div className="progress" aria-busy="true">
          <div className="progress-bar" aria-hidden="true">
            <span />
          </div>
          <p role="status">
            Processing {files.length} document{files.length === 1 ? '' : 's'}: reading text layers, running OCR on scans, reconciling and building the XML.
          </p>
          <p className="muted">
            <span role="timer" aria-label="Elapsed time">
              {elapsed} s elapsed
            </span>{' '}
            · Scanned documents usually take 30–60 s.
          </p>
        </div>
      )}

      {error && !busy && <ErrorBanner error={error} title="Could not generate the entry" onDismiss={onDismissError} />}
    </section>
  );
}
